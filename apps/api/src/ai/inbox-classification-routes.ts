import type { Hono } from "hono";
import type { AppContext, AppEnv } from "../api-context";
import { apiError } from "../common/http-errors";
import { classificationTags, canClassifyInbox, getDestinations } from "./inbox-classification";
import { getMemoDetail, updateMemoRecord } from "../notes/memo-service";
import { inboxNotebookIdentitySql } from "../notes/notebook-service";
import { getActorLabel, getAuditActor, getWorkspaceId, requireUser } from "../auth/request-auth";
import type { DatabaseAdapter } from "../storage/storage-contract";

const liveInbox = `n.is_deleted = 0 AND ${inboxNotebookIdentitySql("n")}`;

function getStatus(db: DatabaseAdapter, workspaceId: string, id: string) {
  return db.prepare(`
    SELECT m.notebook_id AS notebookId, COALESCE((${liveInbox}), 0) AS inInbox,
      j.inbox_id AS sourceInboxId, j.status, j.outcome, j.attempts, j.reason,
      d.id AS destinationId, d.name AS destinationName, j.result_revision AS resultRevision,
      j.suggested_tags AS suggestedTags, c.revision,
      CASE WHEN j.status = 'moved' AND j.result_revision = c.revision AND m.notebook_id = j.destination_id
        AND s.id IS NOT NULL THEN 1 ELSE 0 END AS canUndo
    FROM memos m
    JOIN memo_contents c ON c.memo_id = m.id
    JOIN notebooks n ON n.id = m.notebook_id AND n.workspace_id = m.workspace_id
    LEFT JOIN inbox_classification_jobs j ON j.memo_id = m.id AND j.workspace_id = m.workspace_id
    LEFT JOIN notebooks d ON d.id = COALESCE(j.destination_id, CASE WHEN j.status = 'moved' THEN m.notebook_id END)
      AND d.workspace_id = m.workspace_id AND d.is_deleted = 0
    LEFT JOIN notebooks s ON s.id = j.inbox_id AND s.workspace_id = m.workspace_id AND s.is_deleted = 0
    WHERE m.id = ? AND m.workspace_id = ? AND m.is_deleted = 0 AND m.is_archived = 0 AND n.is_deleted = 0
  `).bind(id, workspaceId).first<{
    notebookId: string; inInbox: number; sourceInboxId: string | null; status: string | null; outcome: string | null;
    attempts: number | null; reason: string | null; destinationId: string | null; destinationName: string | null;
    resultRevision: number | null; suggestedTags: string | null; revision: number; canUndo: number;
  }>();
}

const conflict = (c: AppContext) => apiError(c, "classification_changed", "The note or classification changed. Reload before continuing.", 409);

export function registerInboxClassificationRoutes(app: Hono<AppEnv>) {
  app.get("/api/v1/inbox-classification", (c) => {
    const denied = requireUser(c);
    return denied ?? c.json({ enabled: canClassifyInbox(c.env, getWorkspaceId(c)) });
  });

  app.get("/api/v1/inbox-classification/:id", async (c) => {
    const denied = requireUser(c);
    if (denied) return denied;
    const workspaceId = getWorkspaceId(c);
    if (!canClassifyInbox(c.env, workspaceId)) return apiError(c, "classification_disabled", "Automatic filing is disabled.", 404);
    const row = await getStatus(c.env.storage.db, workspaceId, c.req.param("id"));
    if (!row) return apiError(c, "not_found", "Memo not found.", 404);
    const { inInbox, status, outcome, attempts, reason, destinationId, destinationName, canUndo, notebookId } = row;
    return c.json({
      status, outcome, attempts: attempts ?? 0, reason, destinationId, destinationName, notebookId,
      inInbox: Boolean(inInbox), canUndo: Boolean(canUndo),
      canApply: outcome === "review_recommended" && Boolean(inInbox && destinationId) && row.resultRevision === row.revision,
    });
  });

  app.post("/api/v1/inbox-classification/:id/queue", async (c) => {
    const denied = requireUser(c);
    if (denied) return denied;
    const workspaceId = getWorkspaceId(c);
    if (!canClassifyInbox(c.env, workspaceId)) return apiError(c, "classification_disabled", "Automatic filing is disabled.", 404);
    const result = await c.env.storage.db.prepare(`
      INSERT INTO inbox_classification_jobs (memo_id, workspace_id, inbox_id)
      SELECT m.id, m.workspace_id, n.id FROM memos m JOIN notebooks n ON n.id = m.notebook_id AND n.workspace_id = m.workspace_id
      WHERE m.id = ? AND m.workspace_id = ? AND m.is_deleted = 0 AND m.is_archived = 0 AND ${liveInbox}
      ON CONFLICT (memo_id) DO UPDATE SET inbox_id = excluded.inbox_id, status = 'pending', attempts = 0, available_at = 0,
        claim_token = NULL, outcome = NULL, destination_id = NULL, reason = NULL, result_revision = NULL, suggested_tags = NULL
      WHERE inbox_classification_jobs.status NOT IN ('pending','running')
    `).bind(c.req.param("id"), workspaceId).run();
    return result.meta.changes ? c.json({ ok: true }, 202) : conflict(c);
  });

  app.post("/api/v1/inbox-classification/:id/:action", async (c) => {
    const denied = requireUser(c);
    if (denied) return denied;
    const workspaceId = getWorkspaceId(c);
    const { id, action } = c.req.param();
    if (!canClassifyInbox(c.env, workspaceId) || (action !== "apply" && action !== "undo")) {
      return apiError(c, "not_found", "Classification action not found.", 404);
    }
    const db = c.env.storage.db;
    const row = await getStatus(db, workspaceId, id);
    const memo = await getMemoDetail(db, workspaceId, id);
    if (!row || !memo || memo.revision !== row.resultRevision) return conflict(c);
    const undo = action === "undo";
    if (undo ? !row.canUndo : !(row.inInbox && row.outcome === "review_recommended")) return conflict(c);
    const targetId = undo ? row.sourceInboxId : row.destinationId;
    if (!targetId || (!undo && !(await getDestinations(db, workspaceId)).some((destination) => destination.id === targetId))) return conflict(c);
    const status = undo ? "retained" : "moved";
    const outcome = undo ? "undone" : "classified";
    // Force a constraint failure to roll the batch back if another writer changed the job or note.
    const guard = db.prepare(`
      UPDATE inbox_classification_jobs
      SET status = CASE WHEN status = ? AND outcome = ? AND result_revision = ?
        AND EXISTS (SELECT 1 FROM memos m JOIN memo_contents c ON c.memo_id = m.id
          WHERE m.id = ? AND m.workspace_id = ? AND m.notebook_id = ? AND m.is_deleted = 0 AND m.is_archived = 0 AND c.revision = ?)
        AND EXISTS (SELECT 1 FROM notebooks n WHERE n.id = ? AND n.workspace_id = ? AND n.is_deleted = 0)
        THEN ? ELSE 'stale' END,
        outcome = ?, reason = CASE WHEN ? THEN NULL ELSE reason END,
        result_revision = ?, suggested_tags = NULL
      WHERE memo_id = ? AND workspace_id = ?
    `).bind(row.status, row.outcome, memo.revision, id, workspaceId, row.notebookId, memo.revision, targetId,
      workspaceId, status, outcome, undo ? 1 : 0, undo ? null : memo.revision + 1, id, workspaceId);
    try {
      const result = await updateMemoRecord(db, workspaceId, id, {
        notebookId: targetId,
        expectedRevision: memo.revision,
        ...(undo ? {} : { tags: classificationTags(memo, JSON.parse(row.suggestedTags ?? "[]") as string[]) }),
      }, getAuditActor(c), getActorLabel(c), false, { before: [guard], after: () => [] });
      return result.error ? conflict(c) : c.json({ ok: true });
    } catch (error) {
      if (error instanceof Error && error.message.includes("status IN ('pending', 'running', 'moved', 'retained')")) return conflict(c);
      throw error;
    }
  });
}

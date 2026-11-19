import { z } from "zod";
import { parseDiagramDocument, parseTableDocument, parseInfographicDocument, parsePosterDocument } from "@edgeever/shared";
import type { AppContext } from "../api-context";
import { getActorLabel, getAuditActor } from "../auth/request-auth";
import { AppError } from "../common/app-error";
import { sha256 } from "../common/hash-utils";
import { createMemoRecord, getMemoDetail, updateMemoRecord } from "../notes/memo-service";
import { resolveWorkspaceInboxId } from "../notes/notebook-service";
import { enqueueInboxClassification } from "./inbox-classification";
import { getCompanionTurn, type CompanionScope } from "./companion-service";

export const SaveCompanionResponseSchema = z.object({
  action: z.enum(["create", "append"]),
  memoId: z.string().min(1).max(100).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
}).strict();

/** Save the persisted answer exactly, without a second model call rewriting it.
 * Receipt and mutation commit atomically so retries cannot append/create twice. */
export async function saveCompanionResponse(c: AppContext, scope: CompanionScope, turnId: string,
  input: z.infer<typeof SaveCompanionResponseSchema>) {
  const db = c.env.storage.db;
  const turn = await getCompanionTurn(db, scope, turnId);
  if (!turn || turn.status !== "completed" || !turn.response.trim())
    throw new AppError("companion_response_unavailable", "Only a completed, non-empty answer can be saved.", 409);
  if (input.action === "append" && (!input.memoId || input.expectedRevision === undefined))
    throw new AppError("invalid_params", "Appending requires the current note and its revision.", 400);
  const key = await sha256(JSON.stringify([scope.workspaceId, scope.ownerId, turnId, input.action, input.action === "append" ? input.memoId : ""]));
  const id = `reply_${key}`;
  const previous = async () => {
    const receipt = await db.prepare("SELECT result_memo_id FROM companion_actions WHERE id = ? AND workspace_id = ? AND owner_id = ? AND status = 'applied'")
      .bind(id, scope.workspaceId, scope.ownerId).first<{ result_memo_id: string }>();
    if (!receipt) return null;
    const memo = await getMemoDetail(db, scope.workspaceId, receipt.result_memo_id);
    if (!memo) throw new AppError("companion_saved_note_unavailable", "The saved note is unavailable. Check the trash before creating another copy.", 409);
    return { memo, reused: true };
  };
  const existing = await previous();
  if (existing) return existing;
  const actor = getAuditActor(c);
  const auth = c.get("auth");
  const inboxId = await resolveWorkspaceInboxId(db, scope.workspaceId);
  const now = new Date().toISOString();
  const receipt = (memoId: string) => db.prepare(`INSERT INTO companion_actions
    (id, turn_id, workspace_id, owner_id, payload_json, status, result_memo_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?)`)
    .bind(id, turnId, scope.workspaceId, scope.ownerId, JSON.stringify({ plan: {
      kind: "tool", toolName: input.action === "create" ? "create_memo" : "update_memo",
      arguments: { sourceTurnId: turnId }, reason: "Save answer requested by the user",
    }, notes: [] }), memoId, now, now);
  const after = (memoId: string) => [receipt(memoId), ...enqueueInboxClassification(c.env, auth, inboxId, memoId, true)];
  try {
    if (input.action === "create") {
      const memo = await createMemoRecord(db, scope.workspaceId, {
        notebookId: inboxId, title: turn.message.replace(/\s+/g, " ").slice(0, 160),
        contentMarkdown: turn.response, tags: ["AI对话"],
      }, actor, getActorLabel(c), after);
      return { memo, reused: false };
    }
    const source = await getMemoDetail(db, scope.workspaceId, input.memoId!);
    if (!source || source.isArchived || source.revision !== input.expectedRevision)
      throw new AppError("companion_action_conflict", "The note changed. Refresh it before appending.", 409);
    if (parseDiagramDocument(source.contentMarkdown) || parseTableDocument(source.contentMarkdown)
      || parseInfographicDocument(source.contentMarkdown) || parsePosterDocument(source.contentMarkdown))
      throw new AppError("companion_append_unsupported", "Append to a prose note, or save this answer as a new note.", 400);
    const result = await updateMemoRecord(db, scope.workspaceId, source.id, {
      expectedRevision: source.revision, notebookId: inboxId,
      contentMarkdown: `${source.contentMarkdown}${source.contentMarkdown.trim() ? "\n\n---\n\n" : ""}${turn.response}`,
    }, actor, getActorLabel(c), false, {
      before: [db.prepare(`UPDATE memo_contents SET revision = CASE WHEN revision = ? AND EXISTS
        (SELECT 1 FROM memos m WHERE m.id = ? AND m.workspace_id = ? AND m.notebook_id = ? AND m.updated_at = ? AND m.is_deleted = 0)
        THEN revision ELSE NULL END WHERE memo_id = ?`)
        .bind(source.revision, source.id, scope.workspaceId, source.notebookId, source.updatedAt, source.id)],
      after,
    });
    if (!("memo" in result)) throw new AppError(result.error, result.message, 409);
    return { memo: result.memo, reused: false };
  } catch (error) {
    const applied = await previous();
    if (applied) return applied;
    throw error;
  }
}

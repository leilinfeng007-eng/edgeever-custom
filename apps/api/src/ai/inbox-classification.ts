/**
 * 本地自定义收件箱归档：仅指定自托管工作区启用，按任务租约调用模型并检查源笔记版本。
 * 从 self-hosted-server 启动；模型建议不能跳过笔记服务的工作区隔离或并发校验。
 */
import { normalizeTags, type MemoDetail } from "@edgeever/shared";
import { z } from "zod";
import type { AuthContext, Bindings } from "../api-context";
import { AppError } from "../common/app-error";
import { classifyWithDefaultModel, isModelOutputError, type ClassifierInput } from "./inbox-classification-model";
import { isDemoModeEnabled } from "../workspace/demo-mode";
import { getMemoDetail, updateMemoRecord } from "../notes/memo-service";
import { inboxNotebookIdentitySql } from "../notes/notebook-service";
import type { DatabaseAdapter, PreparedStatementAdapter } from "../storage/storage-contract";

const POLL_INTERVAL_MS = 3_000;
const MODEL_TIMEOUT_MS = 65_000;
const SETTLE_MS = 15_000;
const CLAIM_DURATION_MS = 90_000;
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 30_000;

const classificationSchema = z.strictObject({
  notebookId: z.string().min(1).nullable(),
  tags: z.array(z.string().trim().min(1).max(32)).max(3),
  reason: z.string().trim().max(240).optional(),
  review: z.boolean().optional(),
});

type ClassificationJob = { memo_id: string; inbox_id: string; attempts: number; claim_token: string };
type Destination = { id: string; name: string; parent_id: string | null; path: string };
type Classify = (input: ClassifierInput) => Promise<unknown>;

export const eligibleWorkspace = (env: Bindings) =>
  env.EDGE_EVER_RUNTIME === "self-hosted-bun" && !isDemoModeEnabled(env.EDGE_EVER_DEMO_MODE)
    ? env.EDGE_EVER_AUTO_CLASSIFY_WORKSPACE?.trim() || null
    : null;

export const enqueueInboxClassification = (
  env: Bindings,
  auth: AuthContext,
  notebookId: string,
  memoId: string,
): PreparedStatementAdapter[] => {
  if (auth.kind !== "agent" || eligibleWorkspace(env) !== auth.workspaceId) return [];
  return [env.storage.db.prepare(`
    INSERT INTO inbox_classification_jobs (memo_id, workspace_id, inbox_id, available_at)
    SELECT ?, n.workspace_id, n.id, ?
    FROM notebooks n
    WHERE n.id = ? AND n.workspace_id = ? AND n.is_deleted = 0 AND ${inboxNotebookIdentitySql("n")}
  `).bind(memoId, Date.now() + SETTLE_MS, notebookId, auth.workspaceId)];
};

export const rescheduleInboxClassification = (env: Bindings, auth: AuthContext, memoId: string) => {
  if (auth.kind !== "agent" || eligibleWorkspace(env) !== auth.workspaceId) return [];
  return [env.storage.db.prepare(`
    UPDATE inbox_classification_jobs
    SET status = 'pending', available_at = ?, attempts = 0, claim_token = NULL, outcome = NULL,
        destination_id = NULL, reason = NULL, result_revision = NULL, suggested_tags = NULL
    WHERE memo_id = ? AND workspace_id = ? AND status != 'moved' AND COALESCE(outcome, '') != 'undone'
      AND EXISTS (SELECT 1 FROM memos m WHERE m.id = memo_id AND m.workspace_id = inbox_classification_jobs.workspace_id
        AND m.notebook_id = inbox_id AND m.is_deleted = 0 AND m.is_archived = 0)
  `).bind(Date.now() + SETTLE_MS, memoId, auth.workspaceId)];
};

export const getDestinations = async (db: DatabaseAdapter, workspaceId: string) => (
  await db.prepare(`
    WITH RECURSIVE eligible(id, name, parent_id, path) AS (
      SELECT n.id, n.name, n.parent_id, n.name
      FROM notebooks n
      WHERE n.workspace_id = ? AND n.is_deleted = 0 AND n.parent_id IS NULL
        AND NOT COALESCE(${inboxNotebookIdentitySql("n")}, 0)
        AND n.id NOT IN ('nb_demo_features', 'nb_demo_features_en')
        AND lower(n.name) NOT IN ('edgeever 功能演示', 'edgeever feature demos')
      UNION ALL
      SELECT n.id, n.name, n.parent_id, e.path || ' / ' || n.name
      FROM notebooks n JOIN eligible e ON e.id = n.parent_id
      WHERE n.workspace_id = ? AND n.is_deleted = 0 AND NOT COALESCE(${inboxNotebookIdentitySql("n")}, 0)
        AND n.id NOT IN ('nb_demo_features', 'nb_demo_features_en')
        AND lower(n.name) NOT IN ('edgeever 功能演示', 'edgeever feature demos')
    )
    SELECT id, name, parent_id, path FROM eligible ORDER BY path, id
  `).bind(workspaceId, workspaceId).all<Destination>()
).results;

export const classificationTags = (memo: MemoDetail, tags: string[]) => {
  const seen = new Set(memo.tags.map(tag => tag.toLocaleLowerCase()));
  const additions = normalizeTags(tags.map(tag => tag.replace(/^#+/, "").trim())).filter(tag => {
    const key = tag.toLocaleLowerCase();
    if (seen.has(key) || Array.from(tag).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
    seen.add(key);
    return true;
  });
  return [...memo.tags, ...additions].slice(0, 24);
};

// Abort the entire write if a user edited, moved or removed the source, the
// destination changed, or another worker acquired the claim during inference.
const commitClassification = (
  db: DatabaseAdapter,
  workspaceId: string,
  job: ClassificationJob,
  memo: MemoDetail,
  destination: Destination,
  reason: string | null,
) => db.prepare(`
  INSERT INTO inbox_classification_jobs (memo_id, workspace_id, inbox_id, status, outcome, destination_id, reason, result_revision)
  VALUES (?, ?, ?, CASE WHEN EXISTS (
    SELECT 1 FROM inbox_classification_jobs j
    JOIN memos m ON m.id = j.memo_id AND m.workspace_id = j.workspace_id
    JOIN memo_contents c ON c.memo_id = m.id
    JOIN notebooks n ON n.id = ? AND n.workspace_id = j.workspace_id AND n.is_deleted = 0
    WHERE j.memo_id = ? AND j.workspace_id = ? AND j.claim_token = ? AND j.status = 'running'
      AND m.is_deleted = 0 AND m.is_archived = 0 AND m.notebook_id = j.inbox_id AND m.updated_at = ?
      AND c.revision = ? AND c.content_hash = ? AND n.name = ? AND n.parent_id IS ?
  ) THEN 'moved' ELSE 'stale' END, 'classified', ?, ?, ?)
  ON CONFLICT (memo_id) DO UPDATE SET status = excluded.status, outcome = excluded.outcome, claim_token = NULL,
    destination_id = excluded.destination_id, reason = excluded.reason, result_revision = excluded.result_revision, suggested_tags = NULL
`).bind(memo.id, workspaceId, job.inbox_id, destination.id, memo.id, workspaceId, job.claim_token,
  memo.updatedAt, memo.revision, memo.contentHash, destination.name, destination.parent_id,
  destination.id, reason, memo.revision + 1);

export async function processInboxClassification(
  env: Bindings,
  signal: AbortSignal,
  classify: Classify = classifyWithDefaultModel(env),
  now = Date.now(),
) {
  const workspaceId = eligibleWorkspace(env);
  if (!workspaceId || signal.aborted) return;
  const db = env.storage.db;
  const job = await db.prepare(`
    UPDATE inbox_classification_jobs
    SET status = 'running', attempts = attempts + 1, claim_token = ?, available_at = ?
    WHERE memo_id = (
      SELECT memo_id FROM inbox_classification_jobs
      WHERE workspace_id = ? AND status IN ('pending', 'running') AND available_at <= ?
      ORDER BY available_at, memo_id LIMIT 1
    )
    RETURNING memo_id, inbox_id, attempts, claim_token
  `).bind(crypto.randomUUID(), now + CLAIM_DURATION_MS, workspaceId, now).first<ClassificationJob>();
  if (!job) return;

  const finish = async (outcome: string, retry = false, suggestion?: { id?: string; reason?: string; tags?: string[]; revision?: number }) => {
    const pending = retry && job.attempts < MAX_ATTEMPTS;
    const result = await db.prepare(`
      UPDATE inbox_classification_jobs SET status = ?, available_at = ?, claim_token = NULL, outcome = ?,
        destination_id = ?, reason = ?, suggested_tags = ?, result_revision = ?
      WHERE memo_id = ? AND claim_token = ? AND status = 'running'
    `).bind(pending ? "pending" : "retained", now + job.attempts * RETRY_INTERVAL_MS,
      outcome, suggestion?.id ?? null, suggestion?.reason ?? null, JSON.stringify(suggestion?.tags ?? []),
      suggestion?.revision ?? null, job.memo_id, job.claim_token).run();
    if (Number(result.meta.changes) === 1) {
      console.info(`[inbox-classification] ${job.memo_id} ${pending ? "will_retry" : "retained"} ${outcome}`);
    }
  };

  try {
    if (job.attempts > MAX_ATTEMPTS) return await finish("attempts_exhausted");

    const memo = await getMemoDetail(db, workspaceId, job.memo_id);
    if (!memo || memo.notebookId !== job.inbox_id || memo.isArchived) return await finish("source_changed");
    if (!memo.contentText.trim()) return await finish("empty_body");

    const destinations = await getDestinations(db, workspaceId);
    if (!destinations.length) return await finish("no_destination");
    const decision = classificationSchema.safeParse(await classify({
      workspaceId,
      note: { title: memo.title, text: memo.contentText.slice(0, 8_000), existingTags: memo.tags },
      destinations: destinations.map(({ id, path }) => ({ id, path })),
      signal: AbortSignal.any([signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]),
    }));
    signal.throwIfAborted();

    if (!decision.success) return await finish("model_fields_invalid");
    if (decision.data.notebookId === null) return await finish("unclear", false, { reason: decision.data.reason });
    const destination = destinations.find(note => note.id === decision.data.notebookId);
    if (!destination) return await finish("invalid_destination");
    const current = await getMemoDetail(db, workspaceId, memo.id);
    if (!current || current.notebookId !== job.inbox_id || current.isArchived) return await finish("source_changed");
    if (current.revision !== memo.revision || current.updatedAt !== memo.updatedAt) {
      return await finish("source_updated", true);
    }
    if (decision.data.review) {
      return await finish("review_recommended", false, {
        id: destination.id, reason: decision.data.reason, tags: decision.data.tags, revision: memo.revision,
      });
    }

    const result = await updateMemoRecord(db, workspaceId, memo.id, {
      notebookId: destination.id,
      tags: classificationTags(memo, decision.data.tags),
      expectedRevision: memo.revision,
    }, { actorType: "agent", actorId: null }, "EdgeEver 自动归档", false, {
      before: [commitClassification(db, workspaceId, job, memo, destination, decision.data.reason ?? null)],
      after: () => [],
    });

    if (result.error) return await finish("source_changed", result.error === "revision_conflict");
    console.info(`[inbox-classification] ${memo.id} moved ${destination.id}`);
  } catch (error) {
    if (signal.aborted) return;
    // 输出错误/未配置/鉴权失败保留收件箱，不反复请求；429、暂时异常按最多三次任务尝试重排。
    // 等待模型时笔记变化也会重排；持久化使用 claim_token，过期工作者不得覆盖新租约结果。
    if (error instanceof AppError && error.code === "ai_not_configured") return await finish("model_not_configured");
    if (error instanceof AppError && isModelOutputError(error.code)) return await finish(error.code);
    if (error instanceof Error && error.message.includes("status IN ('pending', 'running', 'moved', 'retained')")) {
      return await finish("source_or_destination_changed");
    }
    const providerStatus = error instanceof Error && "statusCode" in error ? error.statusCode : undefined;
    if (providerStatus === 401 || providerStatus === 403) return await finish("model_auth_failed");
    if (typeof providerStatus === "number" && providerStatus >= 400 && providerStatus < 500 && providerStatus !== 429) {
      return await finish("model_request_rejected");
    }
    await finish("classification_failed", true);
  }
}

export const startInboxClassification = (env: Bindings) => {
  if (!eligibleWorkspace(env)) return null;
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running || controller.signal.aborted) return;
    running = processInboxClassification(env, controller.signal)
      .catch(() => console.error("[inbox-classification] queue processing failed"))
      .finally(() => { running = undefined; });
  };
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  tick();

  return async () => {
    clearInterval(timer);
    controller.abort();
    await running;
  };
};

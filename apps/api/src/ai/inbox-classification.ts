/**
 * 本地自定义收件箱归档：自托管后台任务，按任务租约调用模型并检查源笔记版本。
 * 从 self-hosted-server 启动；模型建议不能跳过笔记服务的工作区隔离或并发校验。
 */
import { normalizeTags, type MemoDetail } from "@edgeever/shared";
import { z } from "zod";
import type { AppContext, AuthContext, Bindings } from "../api-context";
import { AppError } from "../common/app-error";
import { classifyWithDefaultModel, isModelOutputError, type ClassifierInput } from "./inbox-classification-model";
import { isDemoModeEnabled } from "../workspace/demo-mode";
import { listResourcesForMemo } from "../attachments/resource-service";
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

type ClassificationJob = { workspace_id: string; memo_id: string; inbox_id: string; attempts: number; claim_token: string };
type Destination = { id: string; name: string; parent_id: string | null; path: string };
type Classify = (input: ClassifierInput) => Promise<unknown>;

// Runtimes that own a scheduler for this queue: the Bun server keeps a poller,
// Cloudflare Workers run the same drain from a Cron Trigger. Local Miniflare dev
// has no trigger, so generated local config disables automatic filing instead.
const CLASSIFICATION_RUNTIMES = new Set(["self-hosted-bun", "cloudflare-workers"]);

const runtimeName = (env: Bindings) => env.EDGE_EVER_RUNTIME?.trim() || "cloudflare-workers";

const enabled = (env: Bindings) =>
  CLASSIFICATION_RUNTIMES.has(runtimeName(env)) && !isDemoModeEnabled(env.EDGE_EVER_DEMO_MODE) &&
  !["0", "false", "off"].includes(env.EDGE_EVER_AUTO_CLASSIFY?.trim().toLowerCase() ?? "");

const configuredWorkspace = (env: Bindings) => env.EDGE_EVER_AUTO_CLASSIFY_WORKSPACE?.trim() || null;

// Missing model, disabled provider, or unavailable credential encryption all
// need user action in settings; retrying the same request cannot succeed.
const CREDENTIAL_ERRORS = new Set(["ai_not_configured", "ai_encryption_key_missing"]);

export const canClassifyInbox = (env: Bindings, workspaceId: string) =>
  enabled(env) && (!configuredWorkspace(env) || configuredWorkspace(env) === workspaceId);

export const enqueueInboxClassification = (
  env: Bindings,
  auth: AuthContext,
  notebookId: string,
  memoId: string,
  manualChoice = false,
): PreparedStatementAdapter[] => {
  if ((auth.kind !== "agent" && !manualChoice) || !canClassifyInbox(env, auth.workspaceId)) return [];
  return [env.storage.db.prepare(`
    INSERT INTO inbox_classification_jobs (memo_id, workspace_id, inbox_id, available_at)
    SELECT m.id, m.workspace_id, n.id, ?
    FROM memos m JOIN notebooks n ON n.id = m.notebook_id AND n.workspace_id = m.workspace_id
    WHERE m.id = ? AND m.workspace_id = ? AND n.id = ? AND m.is_deleted = 0 AND m.is_archived = 0
      AND n.is_deleted = 0 AND ${inboxNotebookIdentitySql("n")}
    ON CONFLICT (memo_id) DO UPDATE SET inbox_id = excluded.inbox_id, status = 'pending',
      available_at = excluded.available_at, attempts = 0, claim_token = NULL, outcome = NULL,
      destination_id = NULL, reason = NULL, result_revision = NULL, suggested_tags = NULL
  `).bind(Date.now() + SETTLE_MS, memoId, auth.workspaceId, notebookId)];
};

// Runs in the same transaction as the standard notebook selector/batch move.
// Clearing the lease prevents an in-flight model result from undoing a choice.
export const notebookClassificationChoice = (env: Bindings, auth: AuthContext, memoIds: string[], notebookId: string, queueInbox = auth.kind === "user") => {
  if (!canClassifyInbox(env, auth.workspaceId)) return [];
  return [...new Set(memoIds)].flatMap(memoId => [
    env.storage.db.prepare(`UPDATE inbox_classification_jobs
      SET status = 'retained', outcome = 'explicit_location', claim_token = NULL,
          destination_id = NULL, reason = NULL, result_revision = NULL, suggested_tags = NULL
      WHERE workspace_id = ? AND memo_id = ?`).bind(auth.workspaceId, memoId),
    ...(queueInbox
      ? enqueueInboxClassification(env, auth, notebookId, memoId, true)
      : stopMemoClassification(env, auth, memoId)),
  ]);
};

export const stopMemoClassification = (env: Bindings, auth: AuthContext, memoId: string) => {
  const db = env.storage.db;
  const recordedHold = db.prepare(`
    INSERT INTO inbox_classification_jobs (memo_id, workspace_id, inbox_id, status, outcome)
    SELECT m.id, m.workspace_id, n.id, 'retained', 'explicit_location'
    FROM memos m JOIN notebooks n ON n.id = m.notebook_id AND n.workspace_id = m.workspace_id
    WHERE m.id = ? AND m.workspace_id = ? AND m.is_deleted = 0 AND m.is_archived = 0
      AND n.is_deleted = 0 AND ${inboxNotebookIdentitySql("n")}
    ON CONFLICT (memo_id) DO UPDATE SET inbox_id = excluded.inbox_id, status = 'retained',
      outcome = 'explicit_location', claim_token = NULL, destination_id = NULL, reason = NULL,
      attempts = 0, result_revision = NULL, suggested_tags = NULL
  `).bind(memoId, auth.workspaceId);
  const cancelPending = db.prepare(`
    UPDATE inbox_classification_jobs
    SET status = 'retained', outcome = 'explicit_location', claim_token = NULL,
        destination_id = NULL, reason = NULL, result_revision = NULL, suggested_tags = NULL
    WHERE memo_id = ? AND workspace_id = ? AND status IN ('pending', 'running')
  `).bind(memoId, auth.workspaceId);
  return [recordedHold, cancelPending];
};

export async function hasInboxHold(db: DatabaseAdapter, workspaceId: string, memoId: string) {
  return Boolean(await db.prepare(`
    SELECT 1 FROM inbox_classification_jobs j
    JOIN memos m ON m.id = j.memo_id AND m.workspace_id = j.workspace_id AND m.notebook_id = j.inbox_id
    WHERE j.workspace_id = ? AND j.memo_id = ? AND j.status = 'retained' AND j.outcome IN ('explicit_location', 'undone')
  `).bind(workspaceId, memoId).first());
}

export const rescheduleInboxClassification = (env: Bindings, auth: AuthContext, memoId: string) => {
  if (!canClassifyInbox(env, auth.workspaceId)) return [];
  return [env.storage.db.prepare(`
    UPDATE inbox_classification_jobs
    SET status = 'pending', available_at = ?, attempts = 0, claim_token = NULL, outcome = NULL,
        destination_id = NULL, reason = NULL, result_revision = NULL, suggested_tags = NULL
    WHERE memo_id = ? AND workspace_id = ? AND status != 'moved' AND COALESCE(outcome, '') NOT IN ('undone', 'explicit_location')
      AND EXISTS (SELECT 1 FROM memos m WHERE m.id = memo_id AND m.workspace_id = inbox_classification_jobs.workspace_id
        AND m.notebook_id = inbox_id AND m.is_deleted = 0 AND m.is_archived = 0)
  `).bind(Date.now() + SETTLE_MS, memoId, auth.workspaceId)];
};

/**
 * Re-queues an in-place edit of an inbox note. Unlike reschedule this also
 * creates the job row, so a note written while automatic filing was off is
 * picked up after its next edit. The conflict guard keeps every explicit
 * human decision intact: a manual "keep in inbox" hold ('explicit_location'),
 * an undo, or a completed move is never reset by an autosave.
 */
export const requeueInboxClassification = (
  env: Bindings,
  auth: AuthContext,
  notebookId: string,
  memoId: string,
): PreparedStatementAdapter[] => {
  if (!canClassifyInbox(env, auth.workspaceId)) return [];
  return [env.storage.db.prepare(`
    INSERT INTO inbox_classification_jobs (memo_id, workspace_id, inbox_id, available_at)
    SELECT m.id, m.workspace_id, n.id, ?
    FROM memos m JOIN notebooks n ON n.id = m.notebook_id AND n.workspace_id = m.workspace_id
    WHERE m.id = ? AND m.workspace_id = ? AND n.id = ? AND m.is_deleted = 0 AND m.is_archived = 0
      AND n.is_deleted = 0 AND ${inboxNotebookIdentitySql("n")}
    ON CONFLICT (memo_id) DO UPDATE SET inbox_id = excluded.inbox_id, status = 'pending',
      available_at = excluded.available_at, attempts = 0, claim_token = NULL, outcome = NULL,
      destination_id = NULL, reason = NULL, result_revision = NULL, suggested_tags = NULL
    WHERE inbox_classification_jobs.status != 'moved'
      AND COALESCE(inbox_classification_jobs.outcome, '') NOT IN ('undone', 'explicit_location')
  `).bind(Date.now() + SETTLE_MS, memoId, auth.workspaceId, notebookId)];
};

export const getDestinations = async (db: DatabaseAdapter, workspaceId: string) => (
  await db.prepare(`
    WITH RECURSIVE eligible(id, name, parent_id, path) AS (
      SELECT n.id, n.name, n.parent_id, n.name
      FROM notebooks n
      WHERE n.workspace_id = ? AND n.is_deleted = 0 AND n.parent_id IS NULL
        AND NOT COALESCE(${inboxNotebookIdentitySql("n")}, 0)
        AND COALESCE(n.slug, '') NOT IN ('demo-features', 'demo-features-zh', 'feature-demos')
        AND lower(n.name) NOT IN ('edgeever 功能演示', 'edgeever feature demos', '中文功能演示', '英文功能演示', '功能演示', 'feature demos')
      UNION ALL
      SELECT n.id, n.name, n.parent_id, e.path || ' / ' || n.name
      FROM notebooks n JOIN eligible e ON e.id = n.parent_id
      WHERE n.workspace_id = ? AND n.is_deleted = 0 AND NOT COALESCE(${inboxNotebookIdentitySql("n")}, 0)
        AND COALESCE(n.slug, '') NOT IN ('demo-features', 'demo-features-zh', 'feature-demos')
        AND lower(n.name) NOT IN ('edgeever 功能演示', 'edgeever feature demos', '中文功能演示', '英文功能演示', '功能演示', 'feature demos')
    )
    SELECT id, name, parent_id, path FROM eligible ORDER BY path, id
  `).bind(workspaceId, workspaceId).all<Destination>()
).results;

const liveInbox = `n.is_deleted = 0 AND ${inboxNotebookIdentitySql("n")}`;

export type InboxClassificationStatus = {
  notebookId: string;
  inInbox: boolean;
  sourceInboxId: string | null;
  status: string | null;
  outcome: string | null;
  attempts: number;
  reason: string | null;
  destinationId: string | null;
  destinationName: string | null;
  revision: number;
  resultRevision: number | null;
  suggestedTags: string[];
  canUndo: boolean;
  canApply: boolean;
};

/** 读取单条笔记的分类状态；与 HTTP 路由共用，MCP 只读暴露。 */
export async function getInboxClassificationStatus(
  db: DatabaseAdapter,
  workspaceId: string,
  memoId: string,
): Promise<InboxClassificationStatus | null> {
  const row = await db.prepare(`
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
  `).bind(memoId, workspaceId).first<{
    notebookId: string; inInbox: number; sourceInboxId: string | null; status: string | null; outcome: string | null;
    attempts: number | null; reason: string | null; destinationId: string | null; destinationName: string | null;
    resultRevision: number | null; suggestedTags: string | null; revision: number; canUndo: number;
  }>();
  if (!row) return null;
  let suggestedTags: string[] = [];
  try {
    const parsed = JSON.parse(row.suggestedTags ?? "[]");
    if (Array.isArray(parsed)) suggestedTags = parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    suggestedTags = [];
  }
  return {
    notebookId: row.notebookId,
    inInbox: Boolean(row.inInbox),
    sourceInboxId: row.sourceInboxId,
    status: row.status,
    outcome: row.outcome,
    attempts: row.attempts ?? 0,
    reason: row.reason,
    destinationId: row.destinationId,
    destinationName: row.destinationName,
    revision: row.revision,
    resultRevision: row.resultRevision,
    suggestedTags,
    canUndo: Boolean(row.canUndo),
    canApply: row.outcome === "review_recommended" && Boolean(row.inInbox && row.destinationId) && row.resultRevision === row.revision,
  };
}

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

/**
 * Claims and completes at most one due job. Returns false when nothing was
 * claimable so callers can stop draining instead of re-querying an empty queue.
 */
export async function processInboxClassification(
  env: Bindings,
  signal: AbortSignal,
  classify: Classify = classifyWithDefaultModel(env),
  now = Date.now(),
): Promise<boolean> {
  if (!enabled(env) || signal.aborted) return false;
  const onlyWorkspace = configuredWorkspace(env);
  const db = env.storage.db;
  const job = await db.prepare(`
    UPDATE inbox_classification_jobs
    SET status = 'running', attempts = attempts + 1, claim_token = ?, available_at = ?
    WHERE memo_id = (
      SELECT memo_id FROM inbox_classification_jobs
      WHERE status IN ('pending', 'running') AND available_at <= ? ${onlyWorkspace ? 'AND workspace_id = ?' : ''}
      ORDER BY available_at, memo_id LIMIT 1
    )
    RETURNING workspace_id, memo_id, inbox_id, attempts, claim_token
  `).bind(crypto.randomUUID(), now + CLAIM_DURATION_MS, now, ...(onlyWorkspace ? [onlyWorkspace] : [])).first<ClassificationJob>();
  if (!job) return false;
  const workspaceId = job.workspace_id;

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
    // Any finished attempt consumed a claim slot, so the drain loop may continue.
    return true;
  };

  try {
    if (job.attempts > MAX_ATTEMPTS) return await finish("attempts_exhausted");

    const memo = await getMemoDetail(db, workspaceId, job.memo_id);
    if (!memo || memo.notebookId !== job.inbox_id || memo.isArchived) return await finish("source_changed");
    const attachments = (await listResourcesForMemo(db, workspaceId, memo.id)).slice(0, 20)
      .map(({ filename, kind }) => ({ filename, kind }));
    if (!memo.contentText.trim() && !attachments.length && !memo.tags.length && (!memo.title || /^Untitled$|^无标题$/.test(memo.title))) {
      return await finish("empty_body");
    }

    const destinations = await getDestinations(db, workspaceId);
    if (!destinations.length) return await finish("no_destination");
    const decision = classificationSchema.safeParse(await classify({
      workspaceId,
      note: { title: memo.title, text: memo.contentText.slice(0, 8_000), existingTags: memo.tags, attachments },
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
    // A scheduler may cancel the remaining work (deploy, cron deadline). Leave
    // the claim to expire so the next run can re-acquire it instead of the job
    // sitting in 'running' forever.
    if (signal.aborted) return true;
    // 输出错误/未配置/鉴权失败保留收件箱，不反复请求；429、暂时异常按最多三次任务尝试重排。
    // 等待模型时笔记变化也会重排；持久化使用 claim_token，过期工作者不得覆盖新租约结果。
    // 凭据类失败不是暂时故障：重试不会自行修复，必须停在可读状态等用户配置。
    if (error instanceof AppError && CREDENTIAL_ERRORS.has(error.code)) return await finish("model_not_configured");
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
  return true;
}

// Bounded batch: each job costs at least one model call plus several D1 reads,
// so a single cron tick or poller tick must not drain an unbounded backlog.
const DRAIN_BATCH_SIZE = 5;
const DRAIN_BUDGET_MS = 25_000;

/**
 * Drains due jobs until the queue is empty or the batch/deadline budget is hit.
 * Both schedulers share this loop so retry and concurrency behavior stay identical.
 */
export async function drainInboxClassification(
  env: Bindings,
  options: { signal?: AbortSignal; classify?: Classify; now?: () => number; batchSize?: number; budgetMs?: number } = {},
) {
  const controller = options.signal ?? new AbortController().signal;
  const batchSize = options.batchSize ?? DRAIN_BATCH_SIZE;
  const deadline = Date.now() + (options.budgetMs ?? DRAIN_BUDGET_MS);
  let processed = 0;

  while (processed < batchSize && !controller.aborted && Date.now() < deadline) {
    const worked = await processInboxClassification(env, controller, options.classify, options.now?.() ?? Date.now());
    if (!worked) break;
    processed += 1;
  }

  return { processed, exhausted: processed < batchSize };
}

/**
 * Opportunistically drains already-due jobs after a request. Newly enqueued
 * jobs are intentionally not due yet (they wait out SETTLE_MS), so this is a
 * cheap no-op in that case and the Cron Trigger performs the first attempt.
 * Deliberately never sleeps here: a waitUntil task is bounded to roughly 30s
 * after the response, which a settle delay plus a model call can exceed.
 */
export const kickInboxClassification = (context: AppContext) => {
  if (!enabled(context.env)) return;
  let executionCtx: { waitUntil: (task: Promise<unknown>) => void } | undefined;
  try {
    executionCtx = context.executionCtx as unknown as { waitUntil: (task: Promise<unknown>) => void };
  } catch {
    // Runtimes without an execution context (tests, Bun) rely on their poller.
    return;
  }
  executionCtx?.waitUntil(
    drainInboxClassification(context.env, { batchSize: 1, budgetMs: 20_000 })
      .catch((error) => console.error("[inbox-classification] request drain failed", error)),
  );
};

export const startInboxClassification = (env: Bindings) => {
  if (!enabled(env)) return null;
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running || controller.signal.aborted) return;
    running = drainInboxClassification(env, { signal: controller.signal })
      .then(() => undefined)
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

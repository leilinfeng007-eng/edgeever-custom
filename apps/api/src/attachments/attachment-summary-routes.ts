/**
 * 「更新附件汇总」HTTP 入口：读笔记正文与资源来源，重算 `## 附件汇总`，再用 CAS 写回。
 * 幂等：正文没有变化时直接返回当前笔记，不产生修订。
 */
import { isPdfAttachment, type MemoDetail, type Resource } from "@edgeever/shared";
import type { Hono } from "hono";
import type { AppContext, AppEnv, AuditActor } from "../api-context";
import { getActorLabel, getAuditActor, getWorkspaceId, requireAnyScopes } from "../auth/request-auth";
import { apiError, badRequest, notFound } from "../common/http-errors";
import {
  applyAttachmentSummary,
  collectAttachmentSummaryEntries,
  type AttachmentSummaryEntry,
} from "./attachment-summary";
import type { DatabaseAdapter } from "../storage/storage-contract";
import type { updateMemoRecord as updateMemoRecordService } from "../notes/memo-service";

export type AttachmentSummaryRouteDependencies = {
  getMemoDetail: (
    database: DatabaseAdapter,
    workspaceId: string,
    memoId: string,
  ) => Promise<MemoDetail | null>;
  listResourcesForMemo: (
    database: DatabaseAdapter,
    workspaceId: string,
    memoId: string,
  ) => Promise<Resource[]>;
  updateMemoRecord: typeof updateMemoRecordService;
};

const conflict = (context: AppContext, code: string, message: string) =>
  apiError(context, code, message, 409);

/** 只有附件与 PDF 计入汇总；图片不计入，避免汇总变成图片清单。 */
export const isSummarizedResource = (resource: Resource) =>
  resource.kind === "attachment" || isPdfAttachment(resource.mimeType, resource.filename);

export const collectSummaryEntriesForMemo = (
  memo: Pick<MemoDetail, "contentJson">,
  resources: readonly Resource[],
): AttachmentSummaryEntry[] =>
  collectAttachmentSummaryEntries(
    memo.contentJson,
    resources.filter((resource) => isSummarizedResource(resource)),
  );

export const registerAttachmentSummaryRoutes = (
  app: Hono<AppEnv>,
  dependencies: AttachmentSummaryRouteDependencies,
) => {
  app.post("/api/v1/memos/:id/attachment-summary", async (context) => {
    // 写正文，因此要求笔记写权限；附件写权限也放行（MCP/自动化场景）。
    const denied = requireAnyScopes(context, ["write:memos"], ["write:resources"]);
    if (denied) return denied;

    const memoId = context.req.param("id");
    const workspaceId = getWorkspaceId(context);
    const database = context.env.storage.db;

    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    const expectedRevision = Number(body?.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return badRequest(context, "expectedRevision must be a non-negative integer.");
    }
    const expectedContentHash = typeof body?.expectedContentHash === "string" && body.expectedContentHash.trim()
      ? body.expectedContentHash.trim()
      : undefined;

    const memo = await dependencies.getMemoDetail(database, workspaceId, memoId);
    if (!memo) return notFound(context, "Memo not found");
    if (memo.revision !== expectedRevision) {
      return conflict(context, "revision_conflict", "Memo was updated elsewhere. Reload before saving.");
    }
    if (expectedContentHash && expectedContentHash !== memo.contentHash) {
      return conflict(context, "content_conflict", "Note content changed after it was read.");
    }

    const resources = await dependencies.listResourcesForMemo(database, workspaceId, memoId);
    const entries = collectSummaryEntriesForMemo(memo, resources);
    const applied = applyAttachmentSummary(memo.contentMarkdown ?? "", entries);

    // 无附件或汇总未变化：不改正文，直接回当前状态（重复调用幂等）。
    if (applied.total === 0 || !applied.changed) {
      return context.json({ memo, total: applied.total, changed: false });
    }

    const result = await dependencies.updateMemoRecord(
      database,
      workspaceId,
      memoId,
      {
        expectedRevision,
        ...(expectedContentHash ? { expectedContentHash } : {}),
        contentMarkdown: applied.markdown,
      },
      getAuditActor(context) as AuditActor,
      getActorLabel(context),
    );

    if (result.error !== undefined) {
      return apiError(context, result.error, result.message, result.status ?? 409);
    }

    return context.json({ memo: result.memo, total: applied.total, changed: true });
  });
};

/**
 * 笔记 REST 入口：接收 schema 校验后的请求，交给 memo-service 维护正文、修订与审计。
 * MCP 也调用同一服务；接口层决定编辑会话要求，不应在搬迁时放宽校验。
 */
import {
  DeleteMemosSchema,
  DuplicateMemoSchema,
  MemoCreateSchema,
  MergeMemosSchema,
  MemoUpdateSchema,
  MoveMemosSchema,
  type MemoDetail,
  type MemoEditSession,
  type MemoRevision,
  type MemoUpdateInput,
} from "@edgeever/shared";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import type { AppContext, AppEnv, AuditActor, Bindings } from "../api-context";
import { AppError } from "../common/app-error";
import { createId } from "../common/entity-utils";
import { apiError, badRequest, notFound } from "../common/http-errors";
import type { ListMemosInput, ListMemosResult } from "./memo-list-service";
import { getActorLabel, getAuditActor, getWorkspaceId, requireScopes } from "../auth/request-auth";
import { deleteReleasedResourceObjects } from "../attachments/resource-service";
import {
  assertMemoNotebookWriteAccess,
  assertNotebookAccess,
  resolveRequestNotebookAccess,
  type NotebookAccess,
} from "../auth/token-notebook-access";
import type { DatabaseAdapter } from "../storage/storage-contract";
import type { MemoMutationCommit } from "./memo-service";
import { applyNoteSectionOperations } from "../mcp/mcp-note-sections";
import { notebookClassificationChoice, requeueInboxClassification, kickInboxClassification, enqueueInboxClassification, canClassifyInbox } from "../ai/inbox-classification";
import { inboxNotebookIdentitySql } from "./notebook-service";
type MemoRouteDependencies = {
  clampNumber: (value: number, min: number, max: number) => number;
  createImageResource: (context: AppContext, input: {
    memoId: string;
    resourceId?: string;
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    actor: AuditActor;
    source: "upload" | "mcp";
  }) => Promise<{ id: string }>;
  createMemo: (
    database: DatabaseAdapter,
    workspaceId: string,
    input: {
      notebookId: string;
      title?: string;
      contentMarkdown?: string;
      tags?: string[];
      createdAt?: string;
      updatedAt?: string;
    },
    actor: AuditActor,
    actorLabel: string,
  ) => Promise<MemoDetail>;
  createMemoEditSession: (context: AppContext, memoId: string) => Promise<MemoEditSession | null>;
  deleteMemo: (
    environment: Bindings,
    workspaceId: string,
    memoId: string,
    permanent: boolean,
    actor: AuditActor,
  ) => Promise<void>;
  deleteMemos: (
    environment: Bindings,
    workspaceId: string,
    memoIds: string[],
    permanent: boolean,
    actor: AuditActor,
  ) => Promise<number>;
  emptyTrash: (environment: Bindings, workspaceId: string, actor: AuditActor) => Promise<number>;
  getMemoDetail: (
    database: DatabaseAdapter,
    workspaceId: string,
    memoId: string,
    includeDeleted?: boolean,
  ) => Promise<MemoDetail | null>;
  listMemoRevisions: (
    database: DatabaseAdapter,
    workspaceId: string,
    memoId: string,
    limit: number,
  ) => Promise<MemoRevision[]>;
  listMemos: (database: DatabaseAdapter, input: ListMemosInput) => Promise<ListMemosResult>;
  duplicateMemo: (
    context: AppContext,
    memoId: string,
    input: { notebookId?: string; title?: string },
    actor: AuditActor,
    actorLabel: string,
  ) => Promise<MemoDetail>;
  mergeMemos: (
    database: DatabaseAdapter,
    workspaceId: string,
    input: { memoIds: string[]; notebookId?: string; title?: string },
    actor: AuditActor,
    actorLabel: string,
  ) => Promise<MemoDetail>;
  moveMemos: (
    database: DatabaseAdapter,
    workspaceId: string,
    memoIds: string[],
    notebookId: string,
    actor: AuditActor,
    actorLabel: string,
    commit?: MemoMutationCommit,
  ) => Promise<number>;
  restoreMemo: (
    database: DatabaseAdapter,
    workspaceId: string,
    memoId: string,
    actor: AuditActor,
  ) => Promise<MemoDetail>;
  restoreMemoRevision: (
    database: DatabaseAdapter,
    workspaceId: string,
    memoId: string,
    revisionId: string,
    actor: AuditActor,
    actorLabel: string,
  ) => Promise<MemoDetail>;
  updateMemo: (
    database: DatabaseAdapter,
    workspaceId: string,
    memoId: string,
    input: MemoUpdateInput,
    actor: AuditActor,
    actorLabel: string,
    requireEditSession: boolean,
    commit?: MemoMutationCommit,
  ) => Promise<
    | { memo: MemoDetail; releasedResources?: { objectKey: string; storageConfigId: string }[]; error?: never; message?: never; status?: never; details?: never }
    | { error: string; message: string; status?: number; details?: Record<string, unknown> }
  >;
};

const handleAppError = (context: AppContext, error: unknown) => {
  if (error instanceof AppError) {
    return apiError(context, error.code, error.message, error.status);
  }
  throw error;
};

export const registerMemoRoutes = (
  app: Hono<AppEnv>,
  dependencies: MemoRouteDependencies,
) => {
  // 受限 Token 的笔记本守卫。未受限请求不额外读库；
  // 越权统一返回 403 notebook_access_denied。
  const assertMemoAccess = async (
    context: AppContext,
    memoId: string,
    kind: "read" | "write",
    notebookAccess: NotebookAccess,
    action: string,
    includeDeleted = true,
  ) => {
    if (!notebookAccess.restricted) return;
    const memo = await dependencies.getMemoDetail(
      context.env.storage.db,
      getWorkspaceId(context),
      memoId,
      includeDeleted,
    );
    if (memo) assertNotebookAccess(notebookAccess, kind, memo.notebookId, action);
  };

  const assertMemoIdsAccess = (context: AppContext, memoIds: string[], notebookAccess: NotebookAccess, action: string) =>
    assertMemoNotebookWriteAccess(context.env.storage.db, getWorkspaceId(context), memoIds, notebookAccess, action);

  app.get("/api/v1/memos", async (context) => {
    const denied = requireScopes(context, "read:memos");
    if (denied) return denied;

    return context.json(await dependencies.listMemos(context.env.storage.db, {
      workspaceId: getWorkspaceId(context),
      includeTotal: context.req.query("includeTotal") !== "0",
      notebookId: context.req.query("notebookId"),
      includeNotebookDescendants: context.req.query("includeDescendants") === "1",
      query: context.req.query("q"),
      tag: context.req.query("tag"),
      includeTrash: context.req.query("trash") === "1",
      sort: context.req.query("sort"),
      filter: context.req.query("filter"),
      limit: Number(context.req.query("limit") ?? 100),
      cursor: context.req.query("cursor"),
      notebookAccess: await resolveRequestNotebookAccess(context),
    }));
  });

  app.post("/api/v1/memos", zValidator("json", MemoCreateSchema), async (context) => {
    const denied = requireScopes(context, "write:memos");
    if (denied) return denied;

    try {
      const input = context.req.valid("json");
      assertNotebookAccess(
        await resolveRequestNotebookAccess(context),
        "write",
        input.notebookId,
        "create a memo",
      );
      const memo = await dependencies.createMemo(
        context.env.storage.db,
        getWorkspaceId(context),
        input,
        getAuditActor(context),
        getActorLabel(context),
      );
      // An explicit destination stays put; only an inbox save is auto-filed.
      // Web saves reach this route through the local mirror sync.
      const inInbox = Boolean(await context.env.storage.db.prepare(
        `SELECT 1 FROM notebooks WHERE id = ? AND workspace_id = ? AND is_deleted = 0
           AND ${inboxNotebookIdentitySql("notebooks")}`,
      ).bind(memo.notebookId, getWorkspaceId(context)).first());
      if (inInbox && canClassifyInbox(context.env, getWorkspaceId(context))) {
        await context.env.storage.db.batch(
          enqueueInboxClassification(context.env, context.get("auth"), memo.notebookId, memo.id, true),
        );
        kickInboxClassification(context);
      }
      return context.json({ memo }, 201);
    } catch (error) {
      return handleAppError(context, error);
    }
  });

  app.post("/api/v1/memos/with-image", async (context) => {
    const denied = requireScopes(context, "write:memos");
    if (denied) return denied;

    const form = await context.req.raw.formData();
    const file = form.get("file");
    const notebookId = typeof form.get("notebookId") === "string" ? String(form.get("notebookId")).trim() : "";
    const title = typeof form.get("title") === "string" ? String(form.get("title")) : "";
    // multipart/form-data encodes line breaks in text fields as CRLF (browsers
    // always, and newer Bun versions too), while notes store LF line breaks.
    const contentMarkdown = typeof form.get("contentMarkdown") === "string"
      ? String(form.get("contentMarkdown")).replace(/\r\n?/g, "\n")
      : "";
    let tags: string[] = [];
    const tagsValue = form.get("tags");
    if (typeof tagsValue === "string" && tagsValue.trim()) {
      try {
        const parsed = JSON.parse(tagsValue) as unknown;
        if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== "string")) {
          return badRequest(context, "tags must be a JSON array of strings.");
        }
        tags = parsed;
      } catch {
        return badRequest(context, "tags must be a JSON array of strings.");
      }
    }
    if (!(file instanceof File) || !notebookId || !contentMarkdown.includes("EDGEVERRESOURCEID")) {
      return badRequest(context, "notebookId, contentMarkdown, and an image file are required.");
    }
    assertNotebookAccess(
      await resolveRequestNotebookAccess(context),
      "write",
      notebookId,
      "create a memo with an image",
    );
    const resourceId = createId("res");
    const markdown = contentMarkdown.replaceAll("EDGEVERRESOURCEID", resourceId);
    const actor = getAuditActor(context);
    let memoId = "";
    try {
      const memo = await dependencies.createMemo(
        context.env.storage.db,
        getWorkspaceId(context),
        { notebookId, title, contentMarkdown: markdown, tags },
        actor,
        getActorLabel(context),
      );
      memoId = memo.id;
      await dependencies.createImageResource(context, {
        memoId,
        resourceId,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
        actor,
        source: "upload",
      });
      return context.json({ memo, resourceId }, 201);
    } catch (error) {
      if (memoId) {
        await dependencies.deleteMemo(context.env, getWorkspaceId(context), memoId, true, actor).catch(() => undefined);
      }
      return handleAppError(context, error);
    }
  });

  app.get("/api/v1/memos/:id", async (context) => {
    const denied = requireScopes(context, "read:memos");
    if (denied) return denied;

    const memo = await dependencies.getMemoDetail(
      context.env.storage.db,
      getWorkspaceId(context),
      context.req.param("id"),
      context.req.query("includeDeleted") === "1",
    );
    if (memo) {
      try {
        assertNotebookAccess(
          await resolveRequestNotebookAccess(context),
          "read",
          memo.notebookId,
          "read this memo",
        );
      } catch (error) {
        return handleAppError(context, error);
      }
    }
    return memo ? context.json({ memo }) : notFound(context, "Memo not found");
  });

  app.post("/api/v1/memos/:id/edit-sessions", async (context) => {
    const denied = requireScopes(context, "write:memos");
    if (denied) return denied;

    try {
      await assertMemoAccess(
        context,
        context.req.param("id"),
        "write",
        await resolveRequestNotebookAccess(context),
        "edit this memo",
      );
    } catch (error) {
      return handleAppError(context, error);
    }
    const editSession = await dependencies.createMemoEditSession(context, context.req.param("id"));
    return editSession
      ? context.json({ editSession })
      : notFound(context, "Memo not found");
  });

  app.post("/api/v1/memos/batch/move", zValidator("json", MoveMemosSchema), async (context) => {
    const denied = requireScopes(context, "write:memos");
    if (denied) return denied;

    const input = context.req.valid("json");
    try {
      const notebookAccess = await resolveRequestNotebookAccess(context);
      assertNotebookAccess(notebookAccess, "write", input.notebookId, "move memos into this notebook");
      await assertMemoIdsAccess(context, input.memoIds, notebookAccess, "move these memos");
      const moved = await dependencies.moveMemos(
        context.env.storage.db,
        getWorkspaceId(context),
        input.memoIds,
        input.notebookId,
        getAuditActor(context),
        getActorLabel(context),
        { before: [], after: () => notebookClassificationChoice(context.env, context.get("auth"), input.memoIds, input.notebookId) },
      );
      return context.json({ ok: true, moved });
    } catch (error) {
      return handleAppError(context, error);
    }
  });

  app.post("/api/v1/memos/batch/delete", zValidator("json", DeleteMemosSchema), async (context) => {
    const denied = requireScopes(context, "write:memos");
    if (denied) return denied;

    const input = context.req.valid("json");
    try {
      await assertMemoIdsAccess(
        context,
        input.memoIds,
        await resolveRequestNotebookAccess(context),
        "delete these memos",
      );
      const deleted = await dependencies.deleteMemos(
        context.env,
        getWorkspaceId(context),
        input.memoIds,
        Boolean(input.permanent),
        getAuditActor(context),
      );
      return context.json({ ok: true, deleted });
    } catch (error) {
      return handleAppError(context, error);
    }
  });

  app.delete("/api/v1/memos/trash/empty", async (context) => {
    const denied = requireScopes(context, "write:memos");
    if (denied) return denied;

    // 清空回收站是工作区级破坏性操作；受限 Token 一律拒绝。
    const notebookAccess = await resolveRequestNotebookAccess(context);
    if (notebookAccess.restricted) {
      return apiError(
        context,
        "notebook_access_denied",
        "This API token does not have access to every notebook, so it cannot empty the trash. Update the token's notebook access in EdgeEver settings.",
        403,
      );
    }

    const deleted = await dependencies.emptyTrash(
      context.env,
      getWorkspaceId(context),
      getAuditActor(context),
    );
    return context.json({ ok: true, deleted });
  });

  app.get("/api/v1/memos/:id/revisions", async (context) => {
    const denied = requireScopes(context, "read:memos");
    if (denied) return denied;

    try {
      await assertMemoAccess(
        context,
        context.req.param("id"),
        "read",
        await resolveRequestNotebookAccess(context),
        "list revisions of this memo",
      );
      const revisions = await dependencies.listMemoRevisions(
        context.env.storage.db,
        getWorkspaceId(context),
        context.req.param("id"),
        dependencies.clampNumber(Number(context.req.query("limit") ?? 50), 1, 100),
      );
      return context.json({ revisions });
    } catch (error) {
      return handleAppError(context, error);
    }
  });

  app.post("/api/v1/memos/:id/revisions/:revisionId/restore", async (context) => {
    const denied = requireScopes(context, "write:memos");
    if (denied) return denied;

    try {
      await assertMemoAccess(
        context,
        context.req.param("id"),
        "write",
        await resolveRequestNotebookAccess(context),
        "restore this memo's revision",
      );
      const memo = await dependencies.restoreMemoRevision(
        context.env.storage.db,
        getWorkspaceId(context),
        context.req.param("id"),
        context.req.param("revisionId"),
        getAuditActor(context),
        getActorLabel(context),
      );
      return context.json({ memo });
    } catch (error) {
      return handleAppError(context, error);
    }
  });

  const updateMemo = async (context: AppContext, memoId: string, input: MemoUpdateInput) => {
    try {
      const notebookAccess = await resolveRequestNotebookAccess(context);
      await assertMemoAccess(context, memoId, "write", notebookAccess, "update this memo");
      if (input.notebookId) {
        assertNotebookAccess(notebookAccess, "write", input.notebookId, "move this memo");
      }
    } catch (error) {
      return handleAppError(context, error);
    }
    const auth = context.get("auth");
    const previous = await dependencies.getMemoDetail(context.env.storage.db, getWorkspaceId(context), memoId);
    // 章节编辑只给出标题，服务端在已存正文里定位并合并；正文整体替换与章节编辑互斥。
    let patch = input;
    if (input.sectionOperations?.length) {
      if (input.contentMarkdown !== undefined || input.contentJson !== undefined) {
        return apiError(context, "invalid_params", "Send either contentMarkdown/contentJson or sectionOperations, never both.", 400);
      }
      if (!previous) return notFound(context, "Memo not found");
      let contentMarkdown: string;
      try {
        contentMarkdown = applyNoteSectionOperations(previous.contentMarkdown, input.sectionOperations);
      } catch (error) {
        return handleAppError(context, error);
      }
      // The section edit replaces the whole body with the merged result; every
      // other part of the note (images, attachments, tables) is preserved
      // because only the addressed section is rewritten.
      patch = { ...input, contentMarkdown };
    }
    const movedNotebook = patch.notebookId !== undefined && previous?.notebookId !== patch.notebookId;
    // Edits to an inbox note must be re-analyzed, matching the MCP update path.
    // A manual move or explicit destination keeps the user's choice (see
    // notebookClassificationChoice), so this only queues for an in-place edit.
    // No-op saves (same body and metadata) must not reset a settled job, which
    // would otherwise re-run the model on every redundant autosave.
    const contentTouched = patch.contentMarkdown !== undefined
      ? patch.contentMarkdown !== previous?.contentMarkdown
      : patch.contentJson !== undefined;
    const metaTouched = previous !== null
      && ((patch.title !== undefined && patch.title !== previous.title)
        || (patch.tags !== undefined && JSON.stringify(patch.tags) !== JSON.stringify(previous.tags)));
    const editedInPlace = !movedNotebook && patch.notebookId === undefined && (contentTouched || metaTouched);
    const inboxWork = movedNotebook
      ? () => notebookClassificationChoice(context.env, auth, [memoId], patch.notebookId!)
      : editedInPlace && previous
        ? () => requeueInboxClassification(context.env, auth, previous.notebookId, memoId)
        : null;
    const result = await dependencies.updateMemo(
      context.env.storage.db,
      getWorkspaceId(context),
      memoId,
      patch,
      getAuditActor(context),
      getActorLabel(context),
      true,
      inboxWork ? { before: [], after: inboxWork } : undefined,
    );
    if ("error" in result) {
      return context.json(
        {
          error: {
            code: result.error,
            message: result.message,
            ...(result.details ? { details: result.details } : {}),
          },
        },
        (result.status ?? (result.error === "not_found" ? 404 : 409)) as 400,
      );
    }
    if (result.releasedResources?.length) {
      await deleteReleasedResourceObjects(context.env, result.releasedResources);
    }
    // Only an in-place re-file is worth waking the queue; a manual move must
    // keep the user's destination and never trigger a model call.
    if (editedInPlace && result.memo.notebookId === previous?.notebookId) kickInboxClassification(context);
    return context.json({ memo: result.memo });
  };

  app.patch("/api/v1/memos/:id", zValidator("json", MemoUpdateSchema), async (context) => {
    const denied = requireScopes(context, "write:memos");
    if (denied) return denied;
    return updateMemo(context, context.req.param("id"), context.req.valid("json"));
  });

  app.post("/api/v1/memos/:id/save", zValidator("json", MemoUpdateSchema), async (context) => {
    const denied = requireScopes(context, "write:memos");
    if (denied) return denied;
    return updateMemo(context, context.req.param("id"), context.req.valid("json"));
  });

  app.delete("/api/v1/memos/:id", async (context) => {
    const denied = requireScopes(context, "write:memos");
    if (denied) return denied;

    try {
      await assertMemoAccess(
        context,
        context.req.param("id"),
        "write",
        await resolveRequestNotebookAccess(context),
        "delete this memo",
      );
      await dependencies.deleteMemo(
        context.env,
        getWorkspaceId(context),
        context.req.param("id"),
        context.req.query("permanent") === "1",
        getAuditActor(context),
      );
      return context.json({ ok: true });
    } catch (error) {
      return handleAppError(context, error);
    }
  });

  app.post("/api/v1/memos/:id/restore", async (context) => {
    const denied = requireScopes(context, "write:memos");
    if (denied) return denied;

    try {
      await assertMemoAccess(
        context,
        context.req.param("id"),
        "write",
        await resolveRequestNotebookAccess(context),
        "restore this memo",
      );
      const memo = await dependencies.restoreMemo(
        context.env.storage.db,
        getWorkspaceId(context),
        context.req.param("id"),
        getAuditActor(context),
      );
      return context.json({ memo });
    } catch (error) {
      return handleAppError(context, error);
    }
  });

  app.post("/api/v1/memos/:id/duplicate", zValidator("json", DuplicateMemoSchema), async (context) => {
    const denied = requireScopes(context, "write:memos");
    if (denied) return denied;

    try {
      const input = context.req.valid("json");
      const notebookAccess = await resolveRequestNotebookAccess(context);
      await assertMemoAccess(
        context,
        context.req.param("id"),
        "write",
        notebookAccess,
        "duplicate this memo",
      );
      if (input.notebookId) {
        assertNotebookAccess(notebookAccess, "write", input.notebookId, "duplicate a memo into this notebook");
      }
      const memo = await dependencies.duplicateMemo(
        context,
        context.req.param("id"),
        input,
        getAuditActor(context),
        getActorLabel(context),
      );
      return context.json({ memo }, 201);
    } catch (error) {
      return handleAppError(context, error);
    }
  });

  app.post("/api/v1/memos/merge", zValidator("json", MergeMemosSchema), async (context) => {
    const denied = requireScopes(context, "write:memos");
    if (denied) return denied;

    try {
      const input = context.req.valid("json");
      const notebookAccess = await resolveRequestNotebookAccess(context);
      await assertMemoIdsAccess(context, input.memoIds, notebookAccess, "merge these memos");
      if (input.notebookId) {
        assertNotebookAccess(notebookAccess, "write", input.notebookId, "merge memos into this notebook");
      }
      const memo = await dependencies.mergeMemos(
        context.env.storage.db,
        getWorkspaceId(context),
        input,
        getAuditActor(context),
        getActorLabel(context),
      );
      return context.json({ memo }, 201);
    } catch (error) {
      return handleAppError(context, error);
    }
  });
};

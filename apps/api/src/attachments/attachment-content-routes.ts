/**
 * 附件文本 HTTP 入口：与 MCP 共用内容提取和读取上限，只对文本结果返回分页 JSON。
 * 图片或不支持的格式不会静默转成下载或 OCR，沿用 422 错误。
 */
import type { Hono } from "hono";
import type { AppEnv } from "../api-context";
import { AppError } from "../common/app-error";
import { apiError } from "../common/http-errors";
import { readAttachmentContent } from "./attachment-content";
import { getWorkspaceId, requireScopes } from "../auth/request-auth";
import { assertNotebookAccess, resolveRequestNotebookAccess } from "../auth/token-notebook-access";

export function registerAttachmentContentRoute(app: Hono<AppEnv>) {
  app.get("/api/v1/attachment-content/:memoId/:resourceId", async (c) => {
    const denied = requireScopes(c, "read:memos", "read:resources");
    if (denied) return denied;
    const offset = Number(c.req.query("offset") ?? 0);
    try {
      // 附件文本与正文同级：受限 Token 只能读取授权笔记本内的笔记附件。
      const notebookAccess = await resolveRequestNotebookAccess(c);
      if (notebookAccess.restricted) {
        const memo = await c.env.storage.db.prepare(
          `SELECT notebook_id FROM memos WHERE id = ? AND workspace_id = ?`,
        ).bind(c.req.param("memoId"), getWorkspaceId(c)).first<{ notebook_id: string }>();
        if (memo) {
          assertNotebookAccess(notebookAccess, "read", memo.notebook_id, "read this attachment");
        }
      }
      const result = await readAttachmentContent(c.env, getWorkspaceId(c), { ...c.req.param(), offset, mode: "content" });
      if (result.format !== "text") return apiError(c, "attachment_format_unsupported", "Attachment text is unavailable.", 422);
      c.header("Cache-Control", "private, no-store");
      return c.json({
        text: result.text,
        nextOffset: result.nextOffset ?? null,
        totalCharacters: result.totalCharacters,
        ...("pageCount" in result ? { pageStart: result.pageStart, pageEnd: result.pageEnd, pageCount: result.pageCount } : {}),
      });
    } catch (error) {
      if (error instanceof AppError) return apiError(c, error.code, error.message, error.status);
      throw error;
    }
  });
}

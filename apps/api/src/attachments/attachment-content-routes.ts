import type { Hono } from "hono";
import type { AppEnv } from "../api-context";
import { AppError } from "../common/app-error";
import { apiError } from "../common/http-errors";
import { readAttachmentContent } from "./attachment-content";
import { getWorkspaceId, requireScopes } from "../auth/request-auth";

export function registerAttachmentContentRoute(app: Hono<AppEnv>) {
  app.get("/api/v1/attachment-content/:memoId/:resourceId", async (c) => {
    const denied = requireScopes(c, "read:memos", "read:resources");
    if (denied) return denied;
    const offset = Number(c.req.query("offset") ?? 0);
    try {
      const result = await readAttachmentContent(c.env, getWorkspaceId(c), { ...c.req.param(), offset, mode: "content" });
      if (result.format !== "text") return apiError(c, "attachment_format_unsupported", "Attachment text is unavailable.", 422);
      c.header("Cache-Control", "private, no-store");
      return c.json({ text: result.text, nextOffset: result.nextOffset ?? null });
    } catch (error) {
      if (error instanceof AppError) return apiError(c, error.code, error.message, error.status);
      throw error;
    }
  });
}

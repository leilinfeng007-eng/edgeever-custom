/**
 * 四类笔记本整理报告入口：只读返回每个固定类别对应的笔记本，以及未映射的旧笔记本。
 * 创建/改名由迁移 0100 与工作区种子完成，这里不写数据。
 */
import type { Hono } from "hono";
import type { AppEnv, Bindings } from "../api-context";
import { getWorkspaceId, requireScopes } from "../auth/request-auth";
import { listNoteCategories } from "./note-categories";

export type NoteCategoryRouteDependencies = {
  /** Same demo seed hook the notebook list uses, so demo notebooks never leak into the report. */
  prepareDemoData?: (env: Bindings) => Promise<void>;
};

export const registerNoteCategoryRoutes = (
  app: Hono<AppEnv>,
  dependencies: NoteCategoryRouteDependencies = {},
) => {
  app.get("/api/v1/workspaces/note-categories", async (c) => {
    const denied = requireScopes(c, "read:notebooks");
    if (denied) return denied;

    await dependencies.prepareDemoData?.(c.env);
    return c.json(await listNoteCategories(c.env.storage.db, getWorkspaceId(c)));
  });
};

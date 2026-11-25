/**
 * API Token 的笔记本白名单解析与执行辅助（移植自官方 v2.31.2 / PR #820）。
 * 未受限请求（交互式会话、未设置白名单的旧 Token）不产生额外查询；
 * 受限请求只按授权子树判定，越权统一抛 403 notebook_access_denied。
 */
import type { TokenNotebookAccess, TokenNotebookAccessLevel } from "@edgeever/shared";
import { AppError } from "../common/app-error";
import type { AppContext } from "../api-context";
import type { DatabaseAdapter } from "../storage/storage-contract";

/**
 * 单次请求解析后的有效笔记本范围。
 *
 * - `restricted: false` — 交互式会话，或未设置白名单的 Token；行为与加入本功能前完全一致。
 * - `restricted: true`  — 只能访问白名单笔记本子树。整组共用一个级别：
 *   "read" 只读，"write" 读写。不在白名单里的笔记本（包括新建的）不可见。
 */
export type NotebookAccess = {
  restricted: boolean;
  readableNotebookIds: string[];
  writableNotebookIds: string[];
  /** 兼容保留：受限 Token 一律不能创建顶级笔记本。 */
  defaultWrite: boolean;
};

export const UNRESTRICTED_NOTEBOOK_ACCESS: NotebookAccess = {
  restricted: false,
  readableNotebookIds: [],
  writableNotebookIds: [],
  defaultWrite: true,
};

/**
 * 解析 `notebook_access_json` 列。
 *
 * - NULL/undefined → `null`（旧 Token，不受限）。
 * - JSON 数组 → 其有效条目，可能为空数组。空数组表示受限但无授权（fail closed），
 *   绝不回退成不受限。
 * - 无法解析或不是数组 → `[]`：损坏的授权必须收窄权限而不是放宽。
 */
export const parseNotebookAccessJson = (value: string | null | undefined): TokenNotebookAccess[] | null => {
  if (value == null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const entries: TokenNotebookAccess[] = [];
    for (const item of parsed) {
      // 任一条目无效即整条记录不可用：丢弃它会把「格式错误」变成「没有显式授权」。
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      if (typeof entry.notebookId !== "string" || !entry.notebookId.trim()) return [];
      if (typeof entry.read !== "boolean" || typeof entry.write !== "boolean") return [];
      entries.push({
        notebookId: entry.notebookId,
        read: entry.read,
        write: entry.write,
      });
    }
    return entries;
  } catch {
    return [];
  }
};

/** 解析 `notebook_access_level` 列。未知/null 按 "read" 处理。 */
export const parseNotebookAccessLevel = (value: string | null | undefined): TokenNotebookAccessLevel =>
  value === "write" ? "write" : "read";

/**
 * 存储的授权列存在但不可用时返回 true。此类记录必须整体拒绝，
 * 不得回退到任何默认值。
 */
export const isCorruptedNotebookAccess = (value: string | null | undefined): boolean => {
  if (value == null) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return true;
    for (const item of parsed) {
      if (!item || typeof item !== "object") return true;
      const entry = item as Record<string, unknown>;
      if (typeof entry.notebookId !== "string" || !entry.notebookId.trim()) return true;
      if (typeof entry.read !== "boolean" || typeof entry.write !== "boolean") return true;
    }
    return false;
  } catch {
    return true;
  }
};

/**
 * D1 按整条语句统计绑定参数，逐个绑定数百个 id 会超限。
 * 笔记本 id 列表统一作为一个 JSON 数组绑定，经 json_each 展开，
 * 因此每条语句只绑定少量参数。
 */
export const notebookIdsBind = (notebookIds: string[]): string => JSON.stringify(notebookIds);

/** SQL 片段：列值命中给定笔记本 id 之一。 */
export const notebookInListSql = (notebookIdColumn: string, notebookIds: string[]) =>
  notebookIds.length === 0
    ? "0 = 1"
    : `${notebookIdColumn} IN (SELECT value FROM json_each(?))`;

/**
 * 解析请求的有效笔记本范围。`null` 条目（本功能上线前的所有 Token、交互式会话）
 * 保持不受限；空数组表示受限且无任何授权（fail closed）。
 *
 * 读取预算与一致性：白名单用一条带作用域的递归 CTE 展开，只读取被授权的子树，
 * 不扫全表；没有缓存，每次请求都读当前层级，任何实例上的移动/收窄立即生效。
 * 结果规模随授权子树大小增长，与工作区总笔记本数无关。
 *
 * 两级查询都用 INDEXED BY 固定访问路径：新建库（无 ANALYZE 统计）时规划器可能
 * 选择 idx_notebooks_deleted 全扫活跃笔记本。固定主键（种子）与 idx_notebooks_parent
 * （递归）可保证无论统计状态都按定向索引展开。
 */
export const resolveNotebookAccess = async (
  db: DatabaseAdapter,
  workspaceId: string,
  entries: TokenNotebookAccess[] | null | undefined,
  level: TokenNotebookAccessLevel = "read",
): Promise<NotebookAccess> => {
  if (entries == null) {
    return UNRESTRICTED_NOTEBOOK_ACCESS;
  }

  const whitelist = entries.map((entry) => entry.notebookId);
  if (whitelist.length === 0) {
    // 不访问数据库直接失败关闭。
    return {
      restricted: true,
      readableNotebookIds: [],
      writableNotebookIds: [],
      defaultWrite: level === "write",
    };
  }

  // 只展开白名单子树。UNION 去重「子本与父本同时列出」；种子与递归都带
  // is_deleted = 0，因此已删除的笔记本、以及被移出授权子树的笔记立即不可见。
  const rows = await db.prepare(
    `WITH RECURSIVE accessible(id) AS (
       SELECT id
       FROM notebooks INDEXED BY sqlite_autoindex_notebooks_1
       WHERE workspace_id = ? AND is_deleted = 0 AND id IN (SELECT value FROM json_each(?))

       UNION

       SELECT n.id
       FROM accessible a
       JOIN notebooks n INDEXED BY idx_notebooks_parent ON n.parent_id = a.id
       WHERE n.workspace_id = ? AND n.is_deleted = 0
     )
     SELECT id FROM accessible`,
  ).bind(workspaceId, notebookIdsBind(whitelist), workspaceId).all<{ id: string }>();

  const readable = rows.results.map((row) => row.id);
  return {
    restricted: true,
    readableNotebookIds: readable,
    writableNotebookIds: level === "write" ? [...readable] : [],
    defaultWrite: level === "write",
  };
};

/** memo 行的 SQL 片段：笔记所在笔记本可访问。 */
export const memoNotebookAccessSql = (
  memoNotebookColumn: string,
  access: NotebookAccess,
  kind: "read" | "write",
) => {
  if (!access.restricted) return "1 = 1";
  const notebookIds = kind === "read" ? access.readableNotebookIds : access.writableNotebookIds;
  return notebookInListSql(memoNotebookColumn, notebookIds);
};

/** 与 readable/writable 片段对应的绑定值，顺序一致。 */
export const notebookAccessBinds = (access: NotebookAccess, kind: "read" | "write"): string[] => {
  if (!access.restricted) return [];
  const notebookIds = kind === "read" ? access.readableNotebookIds : access.writableNotebookIds;
  return notebookIds.length === 0 ? [] : [notebookIdsBind(notebookIds)];
};

export const hasNotebook = (access: NotebookAccess, kind: "read" | "write", notebookId: string) => {
  if (!access.restricted) return true;
  const ids = kind === "read" ? access.readableNotebookIds : access.writableNotebookIds;
  return ids.includes(notebookId);
};

/** 笔记本不可用时抛 403。 */
export const assertNotebookAccess = (
  access: NotebookAccess,
  kind: "read" | "write",
  notebookId: string,
  action: string,
) => {
  if (!hasNotebook(access, kind, notebookId)) {
    throw new AppError(
      "notebook_access_denied",
      `This API token does not have ${kind} access to the notebook needed to ${action}. Update the token's notebook access in EdgeEver settings.`,
      403,
    );
  }
};

/** 用一次 JSON 绑定校验整批笔记；不存在的 id 交给业务层报错。 */
export const assertMemoNotebookWriteAccess = async (
  db: DatabaseAdapter,
  workspaceId: string,
  memoIds: string[],
  access: NotebookAccess,
  action: string,
  deletedState?: 0 | 1,
) => {
  if (!access.restricted || memoIds.length === 0) return;
  const uniqueIds = [...new Set(memoIds)];
  const deletedFilter = deletedState === undefined ? "" : " AND is_deleted = ?";
  const bindings = deletedState === undefined ? [workspaceId] : [workspaceId, deletedState];
  // 带删除状态过滤时 SQLite 可能改走工作区的 feed 索引。
  // 用初始 schema 就在的主键索引按 id 定位。
  const rows = await db.prepare(
    `SELECT id, notebook_id FROM memos INDEXED BY sqlite_autoindex_memos_1
     WHERE workspace_id = ?${deletedFilter} AND ${notebookInListSql("id", uniqueIds)}`,
  ).bind(...bindings, notebookIdsBind(uniqueIds)).all<{ id: string; notebook_id: string }>();

  for (const row of rows.results) {
    assertNotebookAccess(access, "write", row.notebook_id, action);
  }
};

/**
 * 解析当前请求的有效笔记本范围。交互式会话与未受限 Token 不访问数据库，
 * 保持原有开销。
 */
export const resolveRequestNotebookAccess = async (c: AppContext): Promise<NotebookAccess> => {
  const auth = c.get("auth");
  if (!auth || auth.kind !== "agent" || auth.notebookAccess == null) {
    return UNRESTRICTED_NOTEBOOK_ACCESS;
  }
  return resolveNotebookAccess(c.env.storage.db, auth.workspaceId, auth.notebookAccess, auth.notebookAccessLevel);
};

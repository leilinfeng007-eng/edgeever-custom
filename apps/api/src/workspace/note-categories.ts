/**
 * 四类笔记本整理报告：只读地归纳工作区里「等待分类 / 工作项目 / 系统问题记录 /
 * 个人学习 / 临时记录」分别对应哪个笔记本，并列出没有映射到任何一类的旧笔记本。
 *
 * 创建新的笔记本由迁移 0100（已有实例）与工作区初始化种子（新实例）各自负责，
 * 本模块不写入数据，避免两套逻辑重复创建同名笔记本。
 */
import {
  DEFAULT_NOTEBOOK_SEEDS,
  defaultNotebookId,
} from "@edgeever/shared/default-workspace-seeds";
import type { DatabaseAdapter } from "../storage/storage-contract";

export type NoteCategoryKey = "inbox" | "projects" | "system-issues" | "learning" | "temp";

export type NoteCategoryDefinition = {
  key: NoteCategoryKey;
  /** Display name of the seeded category (zh-CN, the installation language). */
  name: string;
  slug: string;
  sortOrder: number;
  /** Names an existing workspace may already use for this category. */
  aliases: readonly string[];
};

// Seeded names in every shipped language are accepted as aliases: a workspace
// that localized its notebooks before this change still matches by name.
const EXTRA_ALIASES: Record<NoteCategoryKey, readonly string[]> = {
  inbox: [],
  projects: ["工作项目", "工作專案", "Work Projects"],
  "system-issues": ["系统问题记录", "系統問題記錄", "System Issues", "系统问题", "系統問題"],
  // The pre-0100 seed name, so an untouched "学习资料" is adopted as 个人学习.
  learning: [
    "个人学习", "個人學習", "Personal Learning",
    "学习资料", "學習資料", "Learning Resources", "Material de aprendizaje",
    "Lernmaterialien", "Ressources d'apprentissage", "学習資料",
    "Materiały do nauki", "Учебные материалы",
  ],
  temp: ["临时记录", "臨時記錄", "Temp Notes"],
};

export const NOTE_CATEGORY_DEFINITIONS: readonly NoteCategoryDefinition[] = DEFAULT_NOTEBOOK_SEEDS
  .map((seed) => ({
    key: seed.key,
    name: seed.names["zh-CN"],
    slug: seed.slug,
    sortOrder: seed.sortOrder,
    aliases: [...new Set([...Object.values(seed.names), ...EXTRA_ALIASES[seed.key]])],
  }))
  .sort((left, right) => left.sortOrder - right.sortOrder);

// Demo notebooks are installation content, not a note category: they never
// appear as a category target, and they are not "unmapped" legacy notebooks.
const DEMO_SLUGS = new Set(["demo-features", "demo-features-zh", "feature-demos"]);
const DEMO_NAMES = new Set([
  "功能演示", "edgeever 功能演示", "edgeever feature demos",
  "中文功能演示", "英文功能演示", "feature demos",
]);

const normalizeName = (value: string) => value.trim().toLocaleLowerCase("en-US");

export type NoteCategoryMatch = {
  key: NoteCategoryKey;
  name: string;
  notebookId: string | null;
};

export type NoteCategoryUnmapped = { id: string; name: string };

export type NoteCategoryReport = {
  categories: NoteCategoryMatch[];
  unmapped: NoteCategoryUnmapped[];
};

type NotebookCandidateRow = {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string | null;
  sort_order: number;
  is_deleted: number;
};

const isDemoNotebook = (row: { id: string; name: string; slug: string | null }) =>
  DEMO_SLUGS.has((row.slug ?? "").trim()) || DEMO_NAMES.has(normalizeName(row.name));

const LEGACY_INBOX_ID = "nb_inbox";

/** Active notebooks plus the ids that belong to the demo tree (roots and descendants). */
const readWorkspaceNotebooks = async (db: DatabaseAdapter, workspaceId: string) => {
  const rows = (await db.prepare(
    `SELECT id, parent_id, name, slug, sort_order, is_deleted
     FROM notebooks
     WHERE workspace_id = ?
     ORDER BY sort_order ASC, name ASC, id ASC`,
  ).bind(workspaceId).all<NotebookCandidateRow>()).results;

  const demoIds = new Set(rows.filter(isDemoNotebook).map((row) => row.id));
  // A child of a demo notebook is demo content even when its own name differs.
  let changed = demoIds.size > 0;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (demoIds.has(row.id)) continue;
      if (row.parent_id && demoIds.has(row.parent_id)) {
        demoIds.add(row.id);
        changed = true;
      }
    }
  }

  return { rows: rows.filter((row) => row.is_deleted === 0), demoIds };
};

const isInboxRow = (row: NotebookCandidateRow, workspaceId: string) =>
  row.id === `${workspaceId}_inbox` || row.id === LEGACY_INBOX_ID || (row.slug ?? "").trim() === "inbox";

// 0 = canonical id, 1 = slug, 2 = name alias. Lower is a stronger match, so a
// renamed notebook never loses to another notebook that merely shares a name.
const matchScore = (
  row: NotebookCandidateRow,
  definition: NoteCategoryDefinition,
  workspaceId: string,
): number | null => {
  if (isDemoNotebook(row)) return null;
  if (isInboxRow(row, workspaceId)) return definition.key === "inbox" ? 0 : null;
  if (definition.key === "inbox") return null;
  if (row.id === defaultNotebookId(workspaceId, definition.key)) return 0;
  if ((row.slug ?? "").trim() === definition.slug) return 1;
  const name = normalizeName(row.name);
  if (definition.aliases.some((alias) => normalizeName(alias) === name)) return 2;
  return null;
};

/**
 * Read-only report: the notebook behind each fixed category, plus the legacy
 * notebooks that map to no category (for example 灵感创作 / 生活个人).
 * Only top-level notebooks are reported as unmapped; children belong to a parent.
 */
export const listNoteCategories = async (
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<NoteCategoryReport> => {
  const { rows, demoIds } = await readWorkspaceNotebooks(db, workspaceId);
  const claimed = new Set<string>();

  const categories = NOTE_CATEGORY_DEFINITIONS.map((definition): NoteCategoryMatch => {
    let best: { row: NotebookCandidateRow; score: number } | null = null;
    for (const row of rows) {
      if (claimed.has(row.id)) continue;
      const score = matchScore(row, definition, workspaceId);
      if (score === null) continue;
      if (!best || score < best.score) best = { row, score };
    }
    if (!best) return { key: definition.key, name: definition.name, notebookId: null };
    claimed.add(best.row.id);
    return { key: definition.key, name: best.row.name, notebookId: best.row.id };
  });

  const unmapped = rows
    .filter((row) => row.parent_id === null && !demoIds.has(row.id) && !claimed.has(row.id)
      && !isInboxRow(row, workspaceId))
    .map((row) => ({ id: row.id, name: row.name }));

  return { categories, unmapped };
};

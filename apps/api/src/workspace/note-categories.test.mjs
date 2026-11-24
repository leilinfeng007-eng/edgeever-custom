import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSelfHostedStorageAdapter } from "../storage/self-hosted-storage-adapter.ts";
import { listNoteCategories, NOTE_CATEGORY_DEFINITIONS } from "./note-categories.ts";
import { createDefaultNotebookRows } from "./workspace-provisioning.ts";

const migrationFiles = globSync("migrations/*.sql").sort();
const CATEGORY_MIGRATION = "migrations/0100_note_categories.sql";

const directories = [];
const opened = [];
afterEach(() => {
  opened.splice(0).forEach((sqlite) => sqlite.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

const openDatabase = () => {
  const directory = mkdtempSync(join(tmpdir(), "edgeever-note-categories-test-"));
  directories.push(directory);
  const sqlite = new Database(":memory:");
  opened.push(sqlite);
  sqlite.exec("PRAGMA foreign_keys = ON");
  return { sqlite, db: createSelfHostedStorageAdapter(sqlite, directory).db };
};

const migrate = (sqlite, filter = () => true) => {
  for (const file of migrationFiles.filter(filter)) sqlite.exec(readFileSync(file, "utf8"));
};

const migrateCategoryChanges = (sqlite) => sqlite.exec(readFileSync(CATEGORY_MIGRATION, "utf8"));

// An installation that stopped right before this change.
const legacyInstallation = () => {
  const database = openDatabase();
  migrate(database.sqlite, (file) => file < CATEGORY_MIGRATION);
  return database;
};

const addWorkspace = (sqlite, workspaceId, name = workspaceId) => sqlite
  .query("INSERT INTO workspaces (id, name, is_personal) VALUES (?, ?, 1)")
  .run(workspaceId, name);

const addNotebook = (sqlite, row) => sqlite.query(
  `INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, icon, color, sort_order, is_deleted)
   VALUES (?, ?, ?, ?, ?, 'notebook', NULL, ?, ?)`,
).run(row.id, row.workspaceId, row.parentId ?? null, row.name, row.slug ?? null, row.sortOrder ?? 0, row.isDeleted ?? 0);

const addMemo = (sqlite, memoId, notebookId) => sqlite.query(
  `INSERT INTO memos (id, notebook_id, title, excerpt, tags_json) VALUES (?, ?, ?, '', '[]')`,
).run(memoId, notebookId, memoId);

const snapshot = (sqlite, workspaceId) => ({
  notebookCount: sqlite.query("SELECT COUNT(*) AS count FROM notebooks WHERE workspace_id = ?").get(workspaceId).count,
  memos: sqlite.query(
    `SELECT m.id, m.notebook_id FROM memos m
     JOIN notebooks n ON n.id = m.notebook_id
     WHERE n.workspace_id = ? ORDER BY m.id`,
  ).all(workspaceId),
  resources: sqlite.query(
    `SELECT r.id, r.memo_id FROM resources r
     JOIN memos m ON m.id = r.memo_id
     JOIN notebooks n ON n.id = m.notebook_id
     WHERE n.workspace_id = ? ORDER BY r.id`,
  ).all(workspaceId),
});

const notebookOf = (sqlite, id) => sqlite
  .query("SELECT id, parent_id, name, slug, sort_order, is_deleted FROM notebooks WHERE id = ?")
  .get(id);

describe("note category definitions", () => {
  test("describe the inbox and the four fixed categories in sidebar order", () => {
    expect(NOTE_CATEGORY_DEFINITIONS.map(({ key, slug, sortOrder }) => ({ key, slug, sortOrder }))).toEqual([
      { key: "inbox", slug: "inbox", sortOrder: 10 },
      { key: "projects", slug: "work-projects", sortOrder: 20 },
      { key: "system-issues", slug: "system-issues", sortOrder: 25 },
      { key: "learning", slug: "learning-resources", sortOrder: 30 },
      { key: "temp", slug: "temp-notes", sortOrder: 40 },
    ]);
  });
});

describe("a fresh installation", () => {
  test("reports the inbox plus the four categories and keeps 灵感创作/生活个人 unmapped", async () => {
    const { sqlite, db } = openDatabase();
    migrate(sqlite);

    const report = await listNoteCategories(db, "ws_default");
    expect(report.categories).toEqual([
      { key: "inbox", name: "等待分类", notebookId: "nb_inbox" },
      { key: "projects", name: "工作项目", notebookId: "nb_projects" },
      { key: "system-issues", name: "系统问题记录", notebookId: "ws_default_system_issues" },
      { key: "learning", name: "个人学习", notebookId: "nb_learning" },
      { key: "temp", name: "临时记录", notebookId: "ws_default_temp" },
    ]);
    expect(report.unmapped).toEqual([
      { id: "nb_creative", name: "灵感创作" },
      { id: "nb_personal", name: "生活个人" },
    ]);
  });

  test("never reports demo notebooks as a category or as an unmapped notebook", async () => {
    const { sqlite, db } = openDatabase();
    migrate(sqlite);
    sqlite.exec(`
      INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, sort_order)
      VALUES ('nb_demo_features', 'ws_default', NULL, 'EdgeEver 功能演示', 'demo-features', 21),
             ('nb_demo_features_zh', 'ws_default', 'nb_demo_features', '中文功能演示', 'demo-features-zh', 1),
             ('nb_demo_features_en', 'ws_default', 'nb_demo_features', '英文功能演示', 'feature-demos', 2),
             ('nb_temp_lookalike', 'ws_default', NULL, '临时记录', 'demo-features-zh', 41);
    `);

    const report = await listNoteCategories(db, "ws_default");
    expect(report.categories.map(({ key, notebookId }) => ({ key, notebookId }))).toEqual([
      { key: "inbox", notebookId: "nb_inbox" },
      { key: "projects", notebookId: "nb_projects" },
      { key: "system-issues", notebookId: "ws_default_system_issues" },
      // The demo-slug notebook named 临时记录 must not be adopted as the category.
      { key: "learning", notebookId: "nb_learning" },
      { key: "temp", notebookId: "ws_default_temp" },
    ]);
    expect(report.unmapped.map(({ id }) => id)).toEqual(["nb_creative", "nb_personal"]);
  });
});

describe("migration 0100", () => {
  test("renames an untouched 学习资料, creates the missing categories and keeps every note in place", async () => {
    const { sqlite, db } = legacyInstallation();
    addWorkspace(sqlite, "ws_legacy");
    addNotebook(sqlite, { id: "ws_legacy_inbox", workspaceId: "ws_legacy", name: "等待分类", slug: "inbox", sortOrder: 10 });
    addNotebook(sqlite, { id: "ws_legacy_learning", workspaceId: "ws_legacy", name: "学习资料", slug: "learning-resources", sortOrder: 30 });
    addNotebook(sqlite, { id: "ws_legacy_creative", workspaceId: "ws_legacy", name: "灵感创作", slug: "creative-ideas", sortOrder: 40 });
    addNotebook(sqlite, { id: "ws_legacy_personal", workspaceId: "ws_legacy", name: "生活个人", slug: "personal-life", sortOrder: 50 });
    addNotebook(sqlite, { id: "ws_legacy_demo", workspaceId: "ws_legacy", name: "EdgeEver 功能演示", slug: "demo-features", sortOrder: 21 });
    addNotebook(sqlite, { id: "ws_legacy_demo_zh", workspaceId: "ws_legacy", parentId: "ws_legacy_demo", name: "中文功能演示", slug: "demo-features-zh", sortOrder: 1 });
    // A notebook named 学习资料 that the owner created under another parent is not the learning category.
    addNotebook(sqlite, { id: "ws_legacy_nested", workspaceId: "ws_legacy", parentId: "ws_legacy_creative", name: "学习资料", slug: "notes", sortOrder: 1 });
    addMemo(sqlite, "memo_learning", "ws_legacy_learning");
    addMemo(sqlite, "memo_inbox", "ws_legacy_inbox");
    sqlite.exec(`INSERT INTO resources (id, memo_id, object_key, kind) VALUES ('res_learning', 'memo_learning', 'k1', 'attachment')`);
    const before = snapshot(sqlite, "ws_legacy");

    migrateCategoryChanges(sqlite);

    expect(notebookOf(sqlite, "ws_legacy_learning")).toMatchObject({
      name: "个人学习", slug: "learning-resources", sort_order: 30, is_deleted: 0,
    });
    expect(notebookOf(sqlite, "ws_legacy_projects")).toMatchObject({ name: "工作项目", slug: "work-projects", sort_order: 20, is_deleted: 0, parent_id: null });
    expect(notebookOf(sqlite, "ws_legacy_system_issues")).toMatchObject({ name: "系统问题记录", slug: "system-issues", sort_order: 25, is_deleted: 0 });
    expect(notebookOf(sqlite, "ws_legacy_temp")).toMatchObject({ name: "临时记录", slug: "temp-notes", sort_order: 40, is_deleted: 0 });
    // Unmapped legacy notebooks and the demo tree are untouched.
    expect(notebookOf(sqlite, "ws_legacy_creative")).toMatchObject({ name: "灵感创作", slug: "creative-ideas", sort_order: 40 });
    expect(notebookOf(sqlite, "ws_legacy_personal")).toMatchObject({ name: "生活个人", slug: "personal-life", sort_order: 50 });
    expect(notebookOf(sqlite, "ws_legacy_demo")).toMatchObject({ name: "EdgeEver 功能演示", slug: "demo-features", parent_id: null });
    expect(notebookOf(sqlite, "ws_legacy_demo_zh")).toMatchObject({ name: "中文功能演示", slug: "demo-features-zh", parent_id: "ws_legacy_demo" });
    expect(notebookOf(sqlite, "ws_legacy_inbox")).toMatchObject({ name: "等待分类", slug: "inbox" });
    expect(notebookOf(sqlite, "ws_legacy_nested")).toMatchObject({ name: "学习资料", slug: "notes" });
    // Notes and attachments keep their notebook.
    expect(snapshot(sqlite, "ws_legacy")).toEqual({ ...before, notebookCount: before.notebookCount + 3 });
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);

    const report = await listNoteCategories(db, "ws_legacy");
    expect(report.categories.map(({ key, notebookId }) => ({ key, notebookId }))).toEqual([
      { key: "inbox", notebookId: "ws_legacy_inbox" },
      { key: "projects", notebookId: "ws_legacy_projects" },
      { key: "system-issues", notebookId: "ws_legacy_system_issues" },
      { key: "learning", notebookId: "ws_legacy_learning" },
      { key: "temp", notebookId: "ws_legacy_temp" },
    ]);
    expect(report.unmapped).toEqual([
      { id: "ws_legacy_creative", name: "灵感创作" },
      { id: "ws_legacy_personal", name: "生活个人" },
    ]);
  });

  test("keeps a user-chosen learning name and reuses notebooks the owner already renamed or created", async () => {
    const { sqlite, db } = legacyInstallation();
    addWorkspace(sqlite, "ws_custom");
    addNotebook(sqlite, { id: "ws_custom_inbox", workspaceId: "ws_custom", name: "收集箱", slug: "inbox", sortOrder: 10 });
    addNotebook(sqlite, { id: "ws_custom_learning", workspaceId: "ws_custom", name: "我的学习库", slug: "learning-resources", sortOrder: 30 });
    addNotebook(sqlite, { id: "nb_work_renamed", workspaceId: "ws_custom", name: "工作项目", slug: "wo-de-gong-zuo", sortOrder: 20 });
    addNotebook(sqlite, { id: "nb_temp_custom", workspaceId: "ws_custom", name: "临时记录", slug: "lin-shi-ji-lu", sortOrder: 44 });

    migrateCategoryChanges(sqlite);

    // A custom learning name is preserved; the categories reuse what exists.
    expect(notebookOf(sqlite, "ws_custom_learning")).toMatchObject({ name: "我的学习库", slug: "learning-resources" });
    expect(notebookOf(sqlite, "nb_work_renamed")).toMatchObject({ name: "工作项目", slug: "wo-de-gong-zuo" });
    expect(notebookOf(sqlite, "nb_temp_custom")).toMatchObject({ name: "临时记录", slug: "lin-shi-ji-lu" });
    expect(notebookOf(sqlite, "ws_custom_projects")).toBeNull();
    expect(notebookOf(sqlite, "ws_custom_temp")).toBeNull();
    expect(notebookOf(sqlite, "ws_custom_system_issues")).toMatchObject({ name: "系统问题记录" });
    // The renamed inbox keeps its name and identity.
    expect(notebookOf(sqlite, "ws_custom_inbox")).toMatchObject({ name: "收集箱", slug: "inbox" });

    const report = await listNoteCategories(db, "ws_custom");
    expect(report.categories).toEqual([
      { key: "inbox", name: "收集箱", notebookId: "ws_custom_inbox" },
      { key: "projects", name: "工作项目", notebookId: "nb_work_renamed" },
      { key: "system-issues", name: "系统问题记录", notebookId: "ws_custom_system_issues" },
      { key: "learning", name: "我的学习库", notebookId: "ws_custom_learning" },
      { key: "temp", name: "临时记录", notebookId: "nb_temp_custom" },
    ]);
    expect(report.unmapped).toEqual([]);
  });

  test("does not resurrect a trashed notebook that already holds the learning id", async () => {
    const { sqlite, db } = legacyInstallation();
    addWorkspace(sqlite, "ws_deleted");
    addNotebook(sqlite, { id: "ws_deleted_inbox", workspaceId: "ws_deleted", name: "等待分类", slug: "inbox", sortOrder: 10 });
    sqlite.exec(`
      INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, sort_order, is_deleted, deleted_at)
      VALUES ('ws_deleted_learning', 'ws_deleted', NULL, '学习资料', 'learning-resources', 30, 1, '2026-01-01T00:00:00.000Z');
    `);

    migrateCategoryChanges(sqlite);

    // The trashed row keeps its id and stays deleted: the migration must not
    // reuse or restore it, and it must not fail on the primary key either.
    expect(notebookOf(sqlite, "ws_deleted_learning")).toMatchObject({ name: "学习资料", is_deleted: 1 });
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(notebookOf(sqlite, "ws_deleted_projects")).toMatchObject({ name: "工作项目" });
    expect(notebookOf(sqlite, "ws_deleted_system_issues")).toMatchObject({ name: "系统问题记录" });
    expect(notebookOf(sqlite, "ws_deleted_temp")).toMatchObject({ name: "临时记录" });
    const report = await listNoteCategories(db, "ws_deleted");
    expect(report.categories.find(({ key }) => key === "learning")).toEqual({
      key: "learning", name: "个人学习", notebookId: null,
    });
  });

  test("is idempotent: a second run creates and renames nothing", () => {
    const { sqlite } = legacyInstallation();
    addWorkspace(sqlite, "ws_repeat");
    addNotebook(sqlite, { id: "ws_repeat_inbox", workspaceId: "ws_repeat", name: "等待分类", slug: "inbox", sortOrder: 10 });
    addNotebook(sqlite, { id: "ws_repeat_learning", workspaceId: "ws_repeat", name: "学习资料", slug: "learning-resources", sortOrder: 30 });

    migrateCategoryChanges(sqlite);
    const first = sqlite.query("SELECT id, name, slug, sort_order FROM notebooks WHERE workspace_id = 'ws_repeat' ORDER BY id").all();
    migrateCategoryChanges(sqlite);
    migrateCategoryChanges(sqlite);
    const third = sqlite.query("SELECT id, name, slug, sort_order FROM notebooks WHERE workspace_id = 'ws_repeat' ORDER BY id").all();

    expect(third).toEqual(first);
    expect(third).toHaveLength(5);
    expect(third.map((row) => row.slug).sort()).toEqual([
      "inbox", "learning-resources", "system-issues", "temp-notes", "work-projects",
    ]);
  });

  test("adds nothing to a workspace that provisioning already seeded", async () => {
    const { sqlite, db } = legacyInstallation();
    addWorkspace(sqlite, "ws_provisioned");
    for (const notebook of createDefaultNotebookRows("ws_provisioned", "zh-CN")) {
      sqlite.query(
        `INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, icon, color, sort_order)
         VALUES (?, 'ws_provisioned', NULL, ?, ?, 'notebook', ?, ?)`,
      ).run(notebook.id, notebook.name, notebook.slug, notebook.color, notebook.sortOrder);
    }
    const before = sqlite.query("SELECT id, name, slug, sort_order FROM notebooks WHERE workspace_id = 'ws_provisioned' ORDER BY id").all();

    migrateCategoryChanges(sqlite);

    expect(before).toHaveLength(5);
    expect(sqlite.query("SELECT id, name, slug, sort_order FROM notebooks WHERE workspace_id = 'ws_provisioned' ORDER BY id").all()).toEqual(before);
    const report = await listNoteCategories(db, "ws_provisioned");
    expect(report.categories.every(({ notebookId }) => notebookId !== null)).toBe(true);
    expect(report.unmapped).toEqual([]);
  });

  test("recognises localized and differently-cased names without duplicating a category", async () => {
    const { sqlite, db } = legacyInstallation();
    addWorkspace(sqlite, "ws_l10n");
    addNotebook(sqlite, { id: "ws_l10n_inbox", workspaceId: "ws_l10n", name: "Inbox", slug: "inbox", sortOrder: 10 });
    addNotebook(sqlite, { id: "ws_l10n_learning", workspaceId: "ws_l10n", name: "Учебные материалы", slug: "learning-resources", sortOrder: 30 });
    // English names the owner typed in another case, still the seeded category names.
    addNotebook(sqlite, { id: "nb_l10n_projects", workspaceId: "ws_l10n", name: "work projects", slug: "gong-zuo-xiang-mu", sortOrder: 20 });
    addNotebook(sqlite, { id: "nb_l10n_temp", workspaceId: "ws_l10n", name: "temp notes", slug: "lin-shi", sortOrder: 40 });

    migrateCategoryChanges(sqlite);

    // A seeded translation in another script is still the untouched default name.
    expect(notebookOf(sqlite, "ws_l10n_learning")).toMatchObject({ name: "个人学习", slug: "learning-resources" });
    expect(notebookOf(sqlite, "ws_l10n_projects")).toBeNull();
    expect(notebookOf(sqlite, "ws_l10n_temp")).toBeNull();
    expect(notebookOf(sqlite, "ws_l10n_system_issues")).toMatchObject({ name: "系统问题记录" });
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);

    const report = await listNoteCategories(db, "ws_l10n");
    expect(report.categories).toEqual([
      { key: "inbox", name: "Inbox", notebookId: "ws_l10n_inbox" },
      { key: "projects", name: "work projects", notebookId: "nb_l10n_projects" },
      { key: "system-issues", name: "系统问题记录", notebookId: "ws_l10n_system_issues" },
      { key: "learning", name: "个人学习", notebookId: "ws_l10n_learning" },
      { key: "temp", name: "temp notes", notebookId: "nb_l10n_temp" },
    ]);
    expect(report.unmapped).toEqual([]);
  });

  test("fills in the categories of a workspace whose notebooks were all trashed", async () => {
    const { sqlite, db } = legacyInstallation();
    addWorkspace(sqlite, "ws_trashed");
    sqlite.exec(`
      INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, sort_order, is_deleted, deleted_at)
      VALUES ('ws_trashed_inbox', 'ws_trashed', NULL, '等待分类', 'inbox', 10, 1, '2026-01-01T00:00:00.000Z'),
             ('ws_trashed_learning', 'ws_trashed', NULL, '学习资料', 'learning-resources', 30, 1, '2026-01-01T00:00:00.000Z');
    `);

    migrateCategoryChanges(sqlite);

    // Trashed rows keep their name, id and deleted state: nothing is restored.
    expect(notebookOf(sqlite, "ws_trashed_inbox")).toMatchObject({ name: "等待分类", is_deleted: 1 });
    expect(notebookOf(sqlite, "ws_trashed_learning")).toMatchObject({ name: "学习资料", is_deleted: 1 });
    expect(notebookOf(sqlite, "ws_trashed_projects")).toMatchObject({ name: "工作项目", is_deleted: 0 });
    expect(notebookOf(sqlite, "ws_trashed_system_issues")).toMatchObject({ name: "系统问题记录", is_deleted: 0 });
    expect(notebookOf(sqlite, "ws_trashed_temp")).toMatchObject({ name: "临时记录", is_deleted: 0 });
    // The trashed learning id is taken, so no second 个人学习 notebook is created.
    expect(sqlite.query("SELECT COUNT(*) AS count FROM notebooks WHERE workspace_id = 'ws_trashed' AND name = '个人学习'").get().count).toBe(0);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM notebooks WHERE workspace_id = 'ws_trashed'").get().count).toBe(5);

    const report = await listNoteCategories(db, "ws_trashed");
    expect(report.categories.map(({ key, notebookId }) => ({ key, notebookId }))).toEqual([
      { key: "inbox", notebookId: null },
      { key: "projects", notebookId: "ws_trashed_projects" },
      { key: "system-issues", notebookId: "ws_trashed_system_issues" },
      { key: "learning", notebookId: null },
      { key: "temp", notebookId: "ws_trashed_temp" },
    ]);
    expect(report.unmapped).toEqual([]);
  });
});

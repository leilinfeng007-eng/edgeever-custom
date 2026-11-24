import { describe, expect, test } from "bun:test";
import {
  createDefaultNotebookRows,
  createWorkspaceDefaultSeedStatements,
  ensureUserWorkspace,
  isInboxNotebook,
  workspaceInboxId,
} from "./workspace-provisioning.ts";

const statement = (sql, calls) => ({
  bind(...values) {
    calls.push({ sql, values });
    return this;
  },
  async first() {
    return sql.includes("FROM workspace_members WHERE user_id")
      ? { workspace_id: "ws_existing", role: "member" }
      : null;
  },
  async run() {
    return { success: true };
  },
});

describe("workspace provisioning", () => {
  test("uses a stable workspace-scoped inbox id", () => {
    expect(workspaceInboxId("ws_1")).toBe("ws_1_inbox");
    expect(createDefaultNotebookRows("ws_1")[0]).toMatchObject({
      id: "ws_1_inbox",
      slug: "inbox",
    });
    expect(isInboxNotebook({ id: "ws_1_inbox", slug: "shou-ji-xiang" }, "ws_1")).toBe(true);
  });

  test("seeds the inbox and the four fixed categories for a new workspace", () => {
    expect(createDefaultNotebookRows("ws_new", "zh-CN")).toEqual([
      { id: "ws_new_inbox", name: "等待分类", slug: "inbox", color: null, sortOrder: 10 },
      { id: "ws_new_projects", name: "工作项目", slug: "work-projects", color: null, sortOrder: 20 },
      { id: "ws_new_system_issues", name: "系统问题记录", slug: "system-issues", color: null, sortOrder: 25 },
      { id: "ws_new_learning", name: "个人学习", slug: "learning-resources", color: null, sortOrder: 30 },
      { id: "ws_new_temp", name: "临时记录", slug: "temp-notes", color: null, sortOrder: 40 },
    ]);

    // 灵感创作 / 生活个人 and the demo notebooks are no longer seeded.
    const slugs = createDefaultNotebookRows("ws_new").map((notebook) => notebook.slug);
    expect(slugs).not.toContain("creative-ideas");
    expect(slugs).not.toContain("personal-life");
    expect(slugs.some((slug) => slug.startsWith("demo-features") || slug === "feature-demos")).toBe(false);

    expect(createDefaultNotebookRows("ws_new", "en-US").map((notebook) => notebook.name)).toEqual([
      "Inbox", "Work Projects", "System Issues", "Personal Learning", "Temp Notes",
    ]);
  });

  test("does not restore defaults while resolving an existing workspace", async () => {
    const calls = [];
    let batchCount = 0;
    const db = {
      prepare: (sql) => statement(sql, calls),
      batch: async () => {
        batchCount += 1;
        return [];
      },
    };

    expect(await ensureUserWorkspace(db, "usr_existing", "writer")).toEqual({
      workspaceId: "ws_existing",
      role: "member",
    });
    expect(batchCount).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain("FROM workspace_members WHERE user_id");
    expect(calls[1].sql).toContain("FROM workspace_seed_localizations");
  });

  test("builds editable localized template and AI prompt statements for new workspaces", () => {
    const calls = [];
    const db = {
      prepare: (sql) => statement(sql, calls),
    };

    const statements = createWorkspaceDefaultSeedStatements(
      db,
      "ws_new",
      "2026-08-14T00:00:00.000Z",
      "en-US",
    );

    expect(statements.length).toBeGreaterThan(6);
    expect(calls[0].sql).toContain("INSERT OR IGNORE INTO memo_templates");
    expect(calls[0].values).toContain("ws_new_template_quick-note");
    expect(calls[0].values).toContain("Quick Spark");
    expect(calls.filter((call) => call.sql.includes("INSERT OR IGNORE INTO memo_templates"))).toHaveLength(6);
    expect(calls.some((call) => call.sql.includes("INSERT OR IGNORE INTO memo_templates")
      && call.values.includes("ws_new_template_ai-conversation"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("INSERT OR IGNORE INTO ai_prompt_templates"))).toBe(true);
  });

  test("seeds Japanese templates when Accept-Language prefers Japanese", () => {
    const calls = [];
    const db = {
      prepare: (sql) => statement(sql, calls),
    };

    createWorkspaceDefaultSeedStatements(
      db,
      "ws_ja",
      "2026-08-14T00:00:00.000Z",
      "ja-JP,ja;q=0.9",
    );

    expect(calls[0].values).toContain("ひらめきメモ");
  });

  test("seeds English templates when Accept-Language is unmatched", () => {
    const calls = [];
    const db = {
      prepare: (sql) => statement(sql, calls),
    };

    createWorkspaceDefaultSeedStatements(
      db,
      "ws_it",
      "2026-08-14T00:00:00.000Z",
      "it-IT,it;q=0.9",
    );

    expect(calls[0].values).toContain("Quick Spark");
  });
});

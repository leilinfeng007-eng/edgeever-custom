import { describe, expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { callMcpTool } from "../index.ts";
import { registerMemoRoutes } from "../notes/memo-routes.ts";
import { resolveNotebookAccess } from "../auth/token-notebook-access.ts";
import { findMemoDuplicates } from "../notes/memo-duplicate-service.ts";
import { searchMemoSummaries, listMemosForMcp } from "../notes/memo-service.ts";
import { listResourcesForMcp } from "../attachments/resource-service.ts";
import { listTagSummaries } from "../notes/tag-service.ts";
import { getWorkspaceStats } from "../workspace/workspace-stats-service.ts";

class SqliteD1PreparedStatement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new SqliteD1PreparedStatement(this.db, this.sql, bindings);
  }

  async all() {
    return { results: this.db.query(this.sql).all(...this.bindings), success: true, meta: {} };
  }

  async first() {
    return this.db.query(this.sql).get(...this.bindings) ?? null;
  }

  async run() {
    const result = this.db.query(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: result.changes } };
  }
}

class SqliteD1Database {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new SqliteD1PreparedStatement(this.db, sql);
  }

  async batch(statements) {
    return this.db.transaction(() => statements.map((statement) => {
      const result = this.db.query(statement.sql).run(...statement.bindings);
      return { success: true, meta: { changes: result.changes } };
    }))();
  }
}

const ALL_SCOPES = [
  "read:notebooks", "write:notebooks", "read:memos", "write:memos",
  "read:resources", "write:resources", "read:tags", "write:tags", "ai:generate",
];

// Mirrors the four fixed categories the fork seeds/migrates (0100).
const createFixture = () => {
  const sqlite = new Database(":memory:");
  for (const migration of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(migration, "utf8"));
  }
  sqlite.query("INSERT INTO workspaces (id, name, is_personal) VALUES (?, ?, 1)").run("ws_mcp", "MCP workspace");
  sqlite.query("INSERT INTO users (id, username, password_hash, display_name) VALUES ('usr_1', 'owner', 'x', 'Owner')").run();
  sqlite.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws_mcp', 'usr_1', 'owner')").run();
  // 等待分类 inbox, 工作项目 (granted), its child, and 系统问题记录 (not granted).
  sqlite.query(
    "INSERT INTO notebooks (id, workspace_id, name, slug) VALUES ('ws_mcp_inbox', 'ws_mcp', '等待分类', 'inbox')",
  ).run();
  sqlite.query("INSERT INTO notebooks (id, workspace_id, name) VALUES ('nb_work', 'ws_mcp', '工作项目')").run();
  sqlite.query("INSERT INTO notebooks (id, workspace_id, name, parent_id) VALUES ('nb_work_child', 'ws_mcp', '子项目', 'nb_work')").run();
  sqlite.query("INSERT INTO notebooks (id, workspace_id, name) VALUES ('nb_issues', 'ws_mcp', '系统问题记录')").run();

  const context = {
    env: { storage: { db: new SqliteD1Database(sqlite), resources: {} } },
    get: () => undefined,
  };

  const makeAuth = (notebookAccess, level) => ({
    kind: "agent",
    actorType: "agent",
    actorId: "tok_test",
    username: "test-agent",
    displayName: null,
    scopes: ALL_SCOPES,
    workspaceId: "ws_mcp",
    role: "member",
    notebookAccess: notebookAccess ?? null,
    notebookAccessLevel: level ?? "read",
  });

  return { sqlite, context, makeAuth };
};

const grantAll = (notebookIds, level = "write") =>
  notebookIds.map((notebookId) => ({ notebookId, read: true, write: level === "write" }));

describe("MCP notebook access enforcement", () => {
  test("restricted tokens only see and touch granted notebooks", async () => {
    const { context, makeAuth } = createFixture();
    const admin = makeAuth(null);
    const restricted = makeAuth(grantAll(["nb_work"]), "write");
    const call = (auth, tool, args) => callMcpTool(context, auth, tool, args);

    const allowedMemo = (await call(admin, "create_memo", {
      notebookId: "nb_work", title: "Allowed", contentMarkdown: "allowed body needle",
    })).memo;
    const childMemo = (await call(admin, "create_memo", {
      notebookId: "nb_work_child", title: "Child", contentMarkdown: "child body",
    })).memo;
    const secretMemo = (await call(admin, "create_memo", {
      notebookId: "nb_issues", title: "Secret", contentMarkdown: "secret needle",
    })).memo;

    // Listing and search are filtered to the granted subtree.
    const listed = await call(restricted, "list_memos", {});
    expect(listed.memos.map((memo) => memo.id).sort()).toEqual([allowedMemo.id, childMemo.id].sort());
    expect((await call(restricted, "search_memos", { query: "needle" })).memos.map((memo) => memo.id))
      .toEqual([allowedMemo.id]);
    expect((await call(restricted, "list_notebooks", {})).notebooks.map((nb) => nb.id).sort())
      .toEqual(["nb_work", "nb_work_child"]);

    // Direct reads outside the grant are refused.
    await expect(call(restricted, "get_memo", { memoId: secretMemo.id }))
      .rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
    expect((await call(restricted, "get_memo", { memoId: childMemo.id })).memo.id).toBe(childMemo.id);

    // Cross-notebook moves check both source and target.
    await expect(call(restricted, "move_memos", { memoIds: [allowedMemo.id], notebookId: "nb_issues" }))
      .rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
    await expect(call(restricted, "move_memos", { memoIds: [secretMemo.id], notebookId: "nb_work" }))
      .rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });

    // In-grant writes still work.
    const updated = await call(restricted, "update_memo", { memoId: allowedMemo.id, title: "Renamed" });
    expect(updated.memo.title).toBe("Renamed");
  });

  test("a read-level token reads granted notes but cannot write them", async () => {
    const { context, makeAuth } = createFixture();
    const admin = makeAuth(null);
    const reader = makeAuth(grantAll(["nb_work"], "read"), "read");
    const call = (auth, tool, args) => callMcpTool(context, auth, tool, args);

    const memo = (await call(admin, "create_memo", {
      notebookId: "nb_work", title: "Readable", contentMarkdown: "body",
    })).memo;

    expect((await call(reader, "get_memo", { memoId: memo.id })).memo.id).toBe(memo.id);
    await expect(call(reader, "update_memo", { memoId: memo.id, title: "No" }))
      .rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
    await expect(call(reader, "create_memo", { notebookId: "nb_work", title: "No", contentMarkdown: "x" }))
      .rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
  });

  test("an empty whitelist grants no access at all", async () => {
    const { context, makeAuth } = createFixture();
    const admin = makeAuth(null);
    const blocked = makeAuth([], "write");
    const call = (auth, tool, args) => callMcpTool(context, auth, tool, args);

    const memo = (await call(admin, "create_memo", {
      notebookId: "nb_work", title: "Any", contentMarkdown: "body",
    })).memo;

    expect((await call(blocked, "list_memos", {})).memos).toEqual([]);
    expect((await call(blocked, "list_notebooks", {})).notebooks).toEqual([]);
    await expect(call(blocked, "get_memo", { memoId: memo.id }))
      .rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
  });

  test("legacy (unrestricted) tokens keep the previous behaviour", async () => {
    const { context, makeAuth } = createFixture();
    const admin = makeAuth(null);
    const call = (auth, tool, args) => callMcpTool(context, auth, tool, args);

    const memo = (await call(admin, "create_memo", {
      notebookId: "nb_issues", title: "Anywhere", contentMarkdown: "body",
    })).memo;
    expect((await call(admin, "get_memo", { memoId: memo.id })).memo.id).toBe(memo.id);
    expect((await call(admin, "list_notebooks", {})).notebooks.length).toBe(4);
  });

  test("restricted tokens cannot read or manage workspace templates or AI instructions", async () => {
    const { context, makeAuth } = createFixture();
    const admin = makeAuth(null);
    const restricted = makeAuth(grantAll(["nb_work"]), "write");
    const call = (auth, tool, args) => callMcpTool(context, auth, tool, args);

    const template = (await call(admin, "create_note_template", {
      name: "Weekly", contentMarkdown: "template body",
    })).template;

    for (const [tool, args] of [
      ["list_note_templates", {}],
      ["get_note_template", { templateId: template.id }],
      ["update_note_template", { templateId: template.id, name: "Changed" }],
      ["delete_note_template", { templateId: template.id }],
      ["use_note_template", { templateId: template.id, notebookId: "nb_work" }],
      ["create_note_template", { name: "X", contentMarkdown: "y" }],
      ["list_ai_instructions", {}],
      ["create_ai_instruction", { name: "X", instruction: "y" }],
    ]) {
      await expect(call(restricted, tool, args))
        .rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
    }

    expect((await call(admin, "get_note_template", { templateId: template.id })).template.id).toBe(template.id);
  });

  test("workspace stats are filtered for restricted tokens", async () => {
    const { context, makeAuth } = createFixture();
    const admin = makeAuth(null);
    const restricted = makeAuth(grantAll(["nb_work"]), "write");
    const call = (auth, tool, args) => callMcpTool(context, auth, tool, args);

    await call(admin, "create_memo", { notebookId: "nb_work", title: "A", contentMarkdown: "a" });
    await call(admin, "create_memo", { notebookId: "nb_issues", title: "B", contentMarkdown: "b" });

    const stats = await call(restricted, "get_workspace_stats", {});
    expect(stats.memos.active).toBe(1);
    expect(stats.notebooks.active).toBe(2);
  });
});

describe("Fork-specific paths honour notebook access", () => {
  test("save_ai_conversation saves into a granted notebook and refuses an ungranted one", async () => {
    const { context, makeAuth } = createFixture();
    const restricted = makeAuth(grantAll(["nb_work"]), "write");
    const call = (auth, tool, args) => callMcpTool(context, auth, tool, args);

    const saved = await call(restricted, "save_ai_conversation", {
      message: "How do I fix the build?",
      response: "## 结论\n\nRun the build again.",
      notebookId: "nb_work",
      duplicate: "new",
    });
    expect(saved.memo.notebookId).toBe("nb_work");

    await expect(call(restricted, "save_ai_conversation", {
      message: "Other", response: "## 结论\n\nnope", notebookId: "nb_issues", duplicate: "new",
    })).rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
  });

  test("same-topic candidates never leak notes outside the grant", async () => {
    const { context, makeAuth } = createFixture();
    const admin = makeAuth(null);
    const restricted = makeAuth(grantAll(["nb_work"]), "write");
    const call = (auth, tool, args) => callMcpTool(context, auth, tool, args);

    // A same-title note lives in an ungranted notebook.
    await call(admin, "create_memo", {
      notebookId: "nb_issues", title: "Deploy checklist", contentMarkdown: "secret body",
    });

    // The restricted token does not see it as a duplicate candidate, so the save proceeds.
    const saved = await call(restricted, "save_ai_conversation", {
      message: "Deploy checklist",
      response: "## 结论\n\npublic body",
      notebookId: "nb_work",
      duplicate: "ask",
    });
    expect(saved.memo.notebookId).toBe("nb_work");
  });

  test("supplementing a note outside the grant is refused", async () => {
    const { context, makeAuth } = createFixture();
    const admin = makeAuth(null);
    const restricted = makeAuth(grantAll(["nb_work"]), "write");
    const call = (auth, tool, args) => callMcpTool(context, auth, tool, args);

    const secret = (await call(admin, "create_memo", {
      notebookId: "nb_issues", title: "Hidden", contentMarkdown: "## 结论\n\nold",
    })).memo;

    await expect(call(restricted, "save_ai_conversation", {
      message: "Follow up",
      response: "## 结论\n\nnew",
      memoId: secret.id,
      duplicate: "supplement",
    })).rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
  });

  test("idempotent replay is refused after access is narrowed", async () => {
    const { context, makeAuth } = createFixture();
    const restricted = makeAuth(grantAll(["nb_work"]), "write");
    const call = (auth, tool, args) => callMcpTool(context, auth, tool, args);

    const saved = await call(restricted, "save_ai_conversation", {
      message: "Idempotent question",
      response: "## 结论\n\nfirst",
      notebookId: "nb_work",
      duplicate: "new",
      idempotencyKey: "conv-1",
    });

    // Same token, same key: the replay returns the first result.
    const replay = await call(restricted, "save_ai_conversation", {
      message: "Idempotent question",
      response: "## 结论\n\nfirst",
      notebookId: "nb_work",
      duplicate: "new",
      idempotencyKey: "conv-1",
    });
    expect(replay.memo.id).toBe(saved.memo.id);
    expect(replay.idempotentReplay).toBe(true);

    // Access narrowed to nothing: the SAME retry must now be refused.
    const narrowed = makeAuth([], "write");
    await expect(call(narrowed, "save_ai_conversation", {
      message: "Idempotent question",
      response: "## 结论\n\nfirst",
      notebookId: "nb_work",
      duplicate: "new",
      idempotencyKey: "conv-1",
    })).rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
  });

  test("attachment reads and resource listings are gated", async () => {
    const { sqlite, context, makeAuth } = createFixture();
    const admin = makeAuth(null);
    const restricted = makeAuth(grantAll(["nb_work"]), "read");
    const call = (auth, tool, args) => callMcpTool(context, auth, tool, args);

    const allowed = (await call(admin, "create_memo", {
      notebookId: "nb_work", title: "Allowed", contentMarkdown: "body",
    })).memo;
    const secret = (await call(admin, "create_memo", {
      notebookId: "nb_issues", title: "Secret", contentMarkdown: "body",
    })).memo;

    const now = "2026-01-01T00:00:00.000Z";
    const insertResource = sqlite.query(
      `INSERT INTO resources (id, memo_id, bucket_name, object_key, storage_config_id, kind, mime_type, filename,
         byte_size, sha256, width, height, metadata_json, created_at, updated_at)
       VALUES (?, ?, 'b', ?, 'default', 'attachment', 'text/plain', 'note.txt', 4, 'x', NULL, NULL, '{}', ?, ?)`,
    );
    insertResource.run("res_allowed", allowed.id, "workspaces/ws_mcp/memos/allowed/note.txt", now, now);
    insertResource.run("res_secret", secret.id, "workspaces/ws_mcp/memos/secret/note.txt", now, now);

    // list_memo_resources refuses the ungranted memo.
    await expect(call(restricted, "list_memo_resources", { memoId: secret.id }))
      .rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
    expect((await call(restricted, "list_memo_resources", { memoId: allowed.id })).resources.map((r) => r.id))
      .toEqual(["res_allowed"]);

    // list_resources is filtered by notebook, not just memo ownership.
    const listed = await call(restricted, "list_resources", {});
    expect(listed.resources.map((r) => r.id)).toEqual(["res_allowed"]);

    // read_memo_attachment refuses the ungranted memo before touching storage.
    await expect(call(restricted, "read_memo_attachment", {
      memoId: secret.id, resourceId: "res_secret",
    })).rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
  });

  test("import dedup does not leak memos outside the grant", async () => {
    const { context, makeAuth } = createFixture();
    const admin = makeAuth(null);
    const restricted = makeAuth(grantAll(["nb_work"]), "write");
    const call = (auth, tool, args) => callMcpTool(context, auth, tool, args);

    // An admin imports one memo into the ungranted notebook under a source id.
    const imported = await call(admin, "import_memos", {
      source: "third-party-notion-11111111-1111-4111-8111-111111111111",
      notebookId: "nb_issues",
      items: [{ externalId: "ext-1", title: "Secret import", contentMarkdown: "secret body" }],
    });
    expect(imported.created).toBe(1);

    // The restricted token re-imports with the same source/externalId into a granted notebook.
    const result = await call(restricted, "import_memos", {
      source: "third-party-notion-11111111-1111-4111-8111-111111111111",
      notebookId: "nb_work",
      items: [{ externalId: "ext-1", title: "Secret import", contentMarkdown: "secret body" }],
    });
    expect(result.results[0]).toMatchObject({ status: "skipped", reason: "notebook_access_denied" });
    expect(result.results[0].memo).toBeUndefined();
  });

  test("REST and service-layer search/candidates share the same rules", async () => {
    const { context, makeAuth } = createFixture();
    const admin = makeAuth(null);
    const restricted = makeAuth(grantAll(["nb_work"]), "write");
    const call = (auth, tool, args) => callMcpTool(context, auth, tool, args);
    const db = context.env.storage.db;

    await call(admin, "create_memo", { notebookId: "nb_work", title: "Granted", contentMarkdown: "g needle" });
    await call(admin, "create_memo", { notebookId: "nb_issues", title: "Hidden", contentMarkdown: "h needle" });

    const access = await resolveNotebookAccess(db, "ws_mcp", restricted.notebookAccess, "write");
    expect((await searchMemoSummaries(db, {
      workspaceId: "ws_mcp", query: "needle", limit: 20, notebookAccess: access,
    })).map((m) => m.title)).toEqual(["Granted"]);
    expect((await listMemosForMcp(db, {
      workspaceId: "ws_mcp", limit: 20, offset: 0, includeContent: false, includeDeleted: false, notebookAccess: access,
    })).memos.map((m) => m.title)).toEqual(["Granted"]);
    expect(await findMemoDuplicates(db, "ws_mcp", { title: "Hidden", notebookAccess: access })).toEqual([]);
    expect((await listResourcesForMcp(db, "ws_mcp", 100, access)).resources).toEqual([]);
    expect(await listTagSummaries(db, "ws_mcp", access)).toEqual([]);
    expect((await getWorkspaceStats(db, "ws_mcp", access)).memos.active).toBe(1);
  });
});

describe("REST memo routes honour notebook access", () => {
  const createRestApp = (sqlite, auth) => {
    const app = new Hono();
    app.use("/api/v1/*", async (c, next) => {
      c.set("auth", auth);
      await next();
    });
    const db = new SqliteD1Database(sqlite);
    const deps = {
      clampNumber: (value, min, max) => Math.min(Math.max(value, min), max),
      createImageResource: async () => ({ id: "res_1" }),
      createMemo: async () => ({ id: "memo_created" }),
      createMemoEditSession: async () => ({ id: "edit_1" }),
      deleteMemo: async () => {},
      deleteMemos: async () => 0,
      duplicateMemo: async () => ({ id: "memo_copy" }),
      emptyTrash: async () => 0,
      getMemoDetail: async () => null,
      listMemos: async () => ({ memos: [], totalCount: 0, nextCursor: null }),
      listMemoRevisions: async () => [],
      mergeMemos: async () => ({ id: "memo_merged" }),
      moveMemos: async () => 0,
      restoreMemo: async () => ({ id: "memo_1" }),
      restoreMemoRevision: async () => ({ id: "memo_1" }),
      updateMemo: async () => ({ memo: { id: "memo_1" } }),
    };
    registerMemoRoutes(app, deps);
    return { app, db };
  };

  const restAuth = (notebookAccess, level) => ({
    kind: "agent",
    actorType: "agent",
    actorId: "tok_test",
    username: "rest-agent",
    displayName: null,
    scopes: ALL_SCOPES,
    workspaceId: "ws_mcp",
    role: "member",
    notebookAccess: notebookAccess ?? null,
    notebookAccessLevel: level ?? "read",
  });

  test("create into an ungranted notebook is refused", async () => {
    const { sqlite } = createFixture();
    const { app } = createRestApp(sqlite, restAuth(grantAll(["nb_work"]), "write"));
    const response = await app.request("/api/v1/memos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notebookId: "nb_issues", title: "No", contentMarkdown: "x" }),
    }, { storage: { db: new SqliteD1Database(sqlite), resources: {} } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "notebook_access_denied" } });
  });

  test("a read-level token cannot create", async () => {
    const { sqlite } = createFixture();
    const { app } = createRestApp(sqlite, restAuth(grantAll(["nb_work"], "read"), "read"));
    const response = await app.request("/api/v1/memos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notebookId: "nb_work", title: "No", contentMarkdown: "x" }),
    }, { storage: { db: new SqliteD1Database(sqlite), resources: {} } });
    expect(response.status).toBe(403);
  });

  test("emptying the trash is refused for any restricted token", async () => {
    const { sqlite } = createFixture();
    const { app } = createRestApp(sqlite, restAuth(grantAll(["nb_work"]), "write"));
    const response = await app.request("/api/v1/memos/trash/empty", { method: "DELETE" },
      { storage: { db: new SqliteD1Database(sqlite), resources: {} } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "notebook_access_denied" } });
  });

  test("an unrestricted legacy token keeps working", async () => {
    const { sqlite } = createFixture();
    const { app } = createRestApp(sqlite, restAuth(null));
    const response = await app.request("/api/v1/memos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notebookId: "nb_issues", title: "Ok", contentMarkdown: "x" }),
    }, { storage: { db: new SqliteD1Database(sqlite), resources: {} } });
    expect(response.status).toBe(201);
  });
});

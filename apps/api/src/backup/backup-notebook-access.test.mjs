import { describe, expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { registerBackupRoutes } from "./backup-routes.ts";

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

const createFixture = () => {
  const sqlite = new Database(":memory:");
  for (const migration of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(migration, "utf8"));
  }
  sqlite.query("INSERT INTO workspaces (id, name, is_personal) VALUES ('ws_bk', 'Backup', 1)").run();
  sqlite.query("INSERT INTO users (id, username, password_hash, display_name) VALUES ('usr_1', 'owner', 'x', 'Owner')").run();
  sqlite.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws_bk', 'usr_1', 'owner')").run();
  sqlite.query("INSERT INTO notebooks (id, workspace_id, name) VALUES ('nb_a', 'ws_bk', 'A')").run();
  sqlite.query("INSERT INTO notebooks (id, workspace_id, name) VALUES ('nb_b', 'ws_bk', 'B')").run();
  const now = "2026-01-01T00:00:00.000Z";
  for (const [memoId, notebookId] of [["memo_a", "nb_a"], ["memo_b", "nb_b"]]) {
    sqlite.query(
      `INSERT INTO memos (id, workspace_id, notebook_id, title, excerpt, tags_json, created_by, updated_by, created_at, updated_at)
       VALUES (?, 'ws_bk', ?, ?, '', '[]', 'test', 'test', ?, ?)`,
    ).run(memoId, notebookId, `Title ${memoId}`, now, now);
    sqlite.query(
      `INSERT INTO memo_contents (memo_id, content_json, content_markdown, content_text, content_hash, revision, created_at, updated_at)
       VALUES (?, '{"type":"doc"}', ?, ?, ?, 0, ?, ?)`,
    ).run(memoId, `body ${memoId}`, `body ${memoId}`, `hash-${memoId}`, now, now);
  }
  return { sqlite, db: new SqliteD1Database(sqlite) };
};

const ALL_SCOPES = ["read:memos", "write:memos", "read:resources", "write:resources", "read:notebooks", "write:notebooks"];

const agentAuth = (notebookAccess, level) => ({
  kind: "agent",
  actorType: "agent",
  actorId: "tok_backup",
  username: "backup-agent",
  displayName: null,
  scopes: ALL_SCOPES,
  workspaceId: "ws_bk",
  role: "member",
  notebookAccess: notebookAccess ?? null,
  notebookAccessLevel: level ?? "read",
});

const createDependencies = () => ({
  clampNumber: (value, min, max) => Math.min(Math.max(value, min), max),
  getMemoDetail: async () => null,
  mapMemoDetail: (row) => ({ id: row.id, title: row.title }),
  restoreJsonMemos: async () => {},
  restoreJsonNotebooks: async () => {},
  sha256Bytes: async () => "checksum",
  initiateResourceRestoreUpload: async () => { throw new Error("Unexpected restore upload"); },
});

const createApp = (db, auth) => {
  const app = new Hono();
  app.use("/api/v1/*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  registerBackupRoutes(app, createDependencies());
  return { app, environment: { storage: { db, resources: {} } } };
};

describe("/backups/json honouring notebook access", () => {
  test("a notebook-restricted token is refused", async () => {
    const { db } = createFixture();
    const { app, environment } = createApp(db, agentAuth([{ notebookId: "nb_a", read: true, write: false }], "read"));
    const response = await app.request("/api/v1/backups/json", {}, environment);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "notebook_access_denied" } });
  });

  test("an empty whitelist is refused too (no silent partial backup)", async () => {
    const { db } = createFixture();
    const { app, environment } = createApp(db, agentAuth([], "read"));
    const response = await app.request("/api/v1/backups/json", {}, environment);
    expect(response.status).toBe(403);
  });

  test("an unrestricted legacy token keeps working", async () => {
    const { db } = createFixture();
    const { app, environment } = createApp(db, agentAuth(null));
    const response = await app.request("/api/v1/backups/json", {}, environment);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.memos.length).toBeGreaterThan(0);
  });

  test("the other workspace-wide exports are refused for the same token", async () => {
    const { db } = createFixture();
    const { app, environment } = createApp(db, agentAuth([{ notebookId: "nb_a", read: true, write: false }], "read"));
    for (const path of ["/api/v1/exports/markdown", "/api/v1/backups/data?kind=memos"]) {
      const response = await app.request(path, {}, environment);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "notebook_access_denied" } });
    }
  });

  test("scope denial still wins over the restriction check", async () => {
    const { db } = createFixture();
    const readOnlyAuth = { ...agentAuth([{ notebookId: "nb_a", read: true, write: false }]), scopes: ["read:memos"] };
    const { app, environment } = createApp(db, readOnlyAuth);
    const response = await app.request("/api/v1/backups/json", {}, environment);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
  });
});

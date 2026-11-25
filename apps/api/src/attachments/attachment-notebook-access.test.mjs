import { describe, expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { callMcpTool } from "../index.ts";
import { resolveNotebookAccess } from "../auth/token-notebook-access.ts";

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

const createFixture = () => {
  const sqlite = new Database(":memory:");
  for (const migration of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(migration, "utf8"));
  }
  sqlite.query("INSERT INTO workspaces (id, name, is_personal) VALUES ('ws_up', 'Uploads', 1)").run();
  sqlite.query("INSERT INTO users (id, username, password_hash, display_name) VALUES ('usr_1', 'owner', 'x', 'Owner')").run();
  sqlite.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws_up', 'usr_1', 'owner')").run();
  sqlite.query("INSERT INTO notebooks (id, workspace_id, name) VALUES ('nb_a', 'ws_up', 'A')").run();
  sqlite.query("INSERT INTO notebooks (id, workspace_id, name) VALUES ('nb_b', 'ws_up', 'B')").run();

  const context = {
    env: { storage: { db: new SqliteD1Database(sqlite), resources: {} } },
    req: { url: "http://127.0.0.1:8787/mcp" },
    get: () => undefined,
  };

  const makeAuth = (notebookAccess, level, scopes = ALL_SCOPES) => ({
    kind: "agent",
    actorType: "agent",
    actorId: "tok_upload",
    username: "upload-agent",
    displayName: null,
    scopes,
    workspaceId: "ws_up",
    role: "member",
    notebookAccess: notebookAccess ?? null,
    notebookAccessLevel: level ?? "read",
  });

  const insertUploaded = (id, { apiTokenId = "tok_upload", state = "uploaded" } = {}) => {
    const now = "2026-01-01T00:00:00.000Z";
    const future = "2099-01-01T00:00:00.000Z";
    sqlite.query(
      `INSERT INTO pending_resources (
         id, workspace_id, token_hash, state, kind, mime_type, filename, byte_size, object_key,
         bucket_name, storage_config_id, sha256, metadata_json, actor_type, actor_id, api_token_id,
         created_at, upload_expires_at, uploaded_at, expires_at
       ) VALUES (?, 'ws_up', ?, ?, 'attachment', 'text/plain', 'note.txt', 4, ?, 'b', 'default',
                 'checksum', '{}', 'agent', ?, ?, ?, ?, ?, ?)`,
    ).run(id, `hash-${id}`, state, `workspaces/ws_up/uploads/${id}`, "tok_upload", apiTokenId, now, future, now, future);
  };

  return { sqlite, context, makeAuth, insertUploaded };
};

const grant = (notebookIds, level = "write") =>
  notebookIds.map((notebookId) => ({ notebookId, read: true, write: level === "write" }));

const call = (context, auth, tool, args) => callMcpTool(context, auth, tool, args);

const resourceCount = (sqlite) => sqlite.query("SELECT COUNT(*) AS c FROM resources").get().c;

describe("attachment staging stays workspace-scoped", () => {
  test("staging needs write:resources, not a notebook grant", async () => {
    const { context, makeAuth } = createFixture();
    const withoutResourceScope = makeAuth(grant(["nb_a"]), "write",
      ALL_SCOPES.filter((scope) => scope !== "write:resources"));

    await expect(call(context, withoutResourceScope, "create_resource_upload_url", {
      kind: "attachment", mimeType: "text/plain", filename: "note.txt", byteSize: 4,
    })).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  test("a restricted token may stage a workspace upload (no memo yet)", async () => {
    const { context, makeAuth } = createFixture();
    const restricted = makeAuth(grant(["nb_a"]), "write");
    // Staging has no memo/notebook owner, so it is not narrowed here; the
    // guard applies when the file is bound to a note.
    const staged = await call(context, restricted, "create_resource_upload_url", {
      kind: "attachment", mimeType: "text/plain", filename: "note.txt", byteSize: 4,
    });
    expect(staged.uploadUrl).toBeString();
    expect(staged.headers.Authorization).toStartWith("Bearer ");
  });
});

describe("binding a staged file enforces the destination notebook", () => {
  test("binding into a granted notebook succeeds and creates the resource", async () => {
    const { context, sqlite, makeAuth, insertUploaded } = createFixture();
    const restricted = makeAuth(grant(["nb_a"]), "write");
    insertUploaded("res_ok");

    const created = await call(context, restricted, "create_memo", {
      notebookId: "nb_a",
      title: "with attachment",
      contentMarkdown: "body",
      resourceIds: ["res_ok"],
    });
    expect(created.memo.notebookId).toBe("nb_a");
    expect(resourceCount(sqlite)).toBe(1);
    expect(sqlite.query("SELECT memo_id FROM resources WHERE id = 'res_ok'").get().memo_id).toBe(created.memo.id);
  });

  test("binding into an ungranted notebook is refused and leaves no binding", async () => {
    const { context, sqlite, makeAuth, insertUploaded } = createFixture();
    const restricted = makeAuth(grant(["nb_a"]), "write");
    insertUploaded("res_denied");

    await expect(call(context, restricted, "create_memo", {
      notebookId: "nb_b",
      title: "blocked",
      contentMarkdown: "body",
      resourceIds: ["res_denied"],
    })).rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });

    // No cross-notebook binding and no orphan memo were produced.
    // (The workspace seed note in nb_inbox is unrelated, so scope the count.)
    expect(resourceCount(sqlite)).toBe(0);
    expect(sqlite.query("SELECT COUNT(*) AS c FROM memos WHERE notebook_id IN ('nb_a','nb_b')").get().c).toBe(0);
    // The staged file is still pending, so nothing was silently consumed.
    expect(sqlite.query("SELECT state FROM pending_resources WHERE id = 'res_denied'").get().state).toBe("uploaded");
  });

  test("a read-level token cannot bind even inside the granted notebook", async () => {
    const { context, sqlite, makeAuth, insertUploaded } = createFixture();
    const reader = makeAuth(grant(["nb_a"], "read"), "read");
    insertUploaded("res_read_only");

    await expect(call(context, reader, "create_memo", {
      notebookId: "nb_a", title: "no", contentMarkdown: "body", resourceIds: ["res_read_only"],
    })).rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
    expect(resourceCount(sqlite)).toBe(0);
  });

  test("update_memo cannot pull a staged file into an ungranted notebook", async () => {
    const { context, sqlite, makeAuth, insertUploaded } = createFixture();
    const admin = makeAuth(null);
    const restricted = makeAuth(grant(["nb_a"]), "write");
    const memo = (await call(context, admin, "create_memo", {
      notebookId: "nb_a", title: "target", contentMarkdown: "body",
    })).memo;
    insertUploaded("res_move");

    await expect(call(context, restricted, "update_memo", {
      memoId: memo.id,
      notebookId: "nb_b",
      contentMarkdown: "moved body",
      resourceIds: ["res_move"],
    })).rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });

    expect(resourceCount(sqlite)).toBe(0);
    expect(sqlite.query("SELECT notebook_id FROM memos WHERE id = ?").get(memo.id).notebook_id).toBe("nb_a");
  });

  test("insert_memo_resource refuses a memo outside the grant", async () => {
    const { context, sqlite, makeAuth } = createFixture();
    const admin = makeAuth(null);
    const restricted = makeAuth(grant(["nb_a"]), "write");
    const hidden = (await call(context, admin, "create_memo", {
      notebookId: "nb_b", title: "hidden", contentMarkdown: "## A\n\nbody",
    })).memo;
    const now = "2026-01-01T00:00:00.000Z";
    sqlite.query(
      `INSERT INTO resources (id, memo_id, bucket_name, object_key, storage_config_id, kind, mime_type, filename,
         byte_size, sha256, metadata_json, created_at, updated_at)
       VALUES ('res_bound', ?, 'b', 'key', 'default', 'attachment', 'text/plain', 'n.txt', 4, 'x', '{}', ?, ?)`,
    ).run(hidden.id, now, now);

    await expect(call(context, restricted, "insert_memo_resource", {
      memoId: hidden.id, resourceId: "res_bound", anchor: { section: "A" },
    })).rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
  });
});

describe("attachment ownership follows the note's current notebook", () => {
  test("after a note is moved out of the grant its attachment is no longer readable", async () => {
    const { context, sqlite, makeAuth } = createFixture();
    const admin = makeAuth(null);
    const restricted = makeAuth(grant(["nb_a"], "read"), "read");
    const memo = (await call(context, admin, "create_memo", {
      notebookId: "nb_a", title: "movable", contentMarkdown: "body",
    })).memo;
    const now = "2026-01-01T00:00:00.000Z";
    sqlite.query(
      `INSERT INTO resources (id, memo_id, bucket_name, object_key, storage_config_id, kind, mime_type, filename,
         byte_size, sha256, metadata_json, created_at, updated_at)
       VALUES ('res_follow', ?, 'b', 'key', 'default', 'attachment', 'text/plain', 'n.txt', 4, 'x', '{}', ?, ?)`,
    ).run(memo.id, now, now);

    // Readable while the note sits in the granted notebook.
    expect((await call(context, restricted, "list_memo_resources", { memoId: memo.id })).resources.map((r) => r.id))
      .toEqual(["res_follow"]);

    // An unrestricted actor moves the note to an ungranted notebook.
    await call(context, admin, "move_memos", { memoIds: [memo.id], notebookId: "nb_b" });

    // The same attachment is now refused purely on current ownership.
    await expect(call(context, restricted, "list_memo_resources", { memoId: memo.id }))
      .rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
    await expect(call(context, restricted, "read_memo_attachment", {
      memoId: memo.id, resourceId: "res_follow",
    })).rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
  });

  test("attachment summary is refused for a note outside the grant", async () => {
    const { context, makeAuth } = createFixture();
    const admin = makeAuth(null);
    const restricted = makeAuth(grant(["nb_a"]), "write");
    const hidden = (await call(context, admin, "create_memo", {
      notebookId: "nb_b", title: "hidden", contentMarkdown: "body",
    })).memo;

    await expect(call(context, restricted, "update_attachment_summary", {
      memoId: hidden.id, expectedRevision: hidden.revision,
    })).rejects.toMatchObject({ code: "notebook_access_denied", status: 403 });
  });
});

describe("resolveNotebookAccess source of truth", () => {
  test("grants are not cached, so a moved note follows the new hierarchy", async () => {
    const { sqlite } = createFixture();
    const db = new SqliteD1Database(sqlite);
    const access = await resolveNotebookAccess(db, "ws_up", grant(["nb_a"], "write"), "write");
    expect(access.readableNotebookIds).toEqual(["nb_a"]);

    sqlite.query("UPDATE notebooks SET parent_id = 'nb_a' WHERE id = 'nb_b'").run();
    const after = await resolveNotebookAccess(db, "ws_up", grant(["nb_a"], "write"), "write");
    expect([...after.readableNotebookIds].sort()).toEqual(["nb_a", "nb_b"]);
  });
});

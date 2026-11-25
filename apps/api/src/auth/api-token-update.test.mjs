import { describe, expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { registerApiTokenRoutes } from "./api-token-routes.ts";
import { authenticateRequest } from "./auth-service.ts";
import { sha256 } from "../common/hash-utils.ts";
import { resolveNotebookAccess } from "./token-notebook-access.ts";

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
  sqlite.query("INSERT INTO workspaces (id, name, is_personal) VALUES ('ws_t', 'Test', 1)").run();
  sqlite.query("INSERT INTO users (id, username, password_hash, display_name) VALUES ('usr_1', 'owner', 'x', 'Owner')").run();
  sqlite.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws_t', 'usr_1', 'owner')").run();
  for (const id of ["nb_a", "nb_b", "nb_c"]) {
    sqlite.query("INSERT INTO notebooks (id, workspace_id, name) VALUES (?, 'ws_t', ?)").run(id, id);
  }
  return { sqlite, db: new SqliteD1Database(sqlite) };
};

const userAuth = {
  kind: "user",
  actorType: "user",
  actorId: "usr_1",
  username: "owner",
  displayName: "Owner",
  scopes: [],
  workspaceId: "ws_t",
  role: "owner",
};

const createApp = (db, auth) => {
  const app = new Hono();
  app.use("/api/v1/*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  registerApiTokenRoutes(app, { sha256: async (value) => `hash:${value}` });
  return { app, environment: { storage: { db, resources: {} } } };
};

const request = (app, environment, path, init = {}) =>
  app.request(path, { headers: { "content-type": "application/json" }, ...init }, environment);

describe("API token notebook grants: create and update", () => {
  test("omitted notebookAccess creates a zero-access restricted token", async () => {
    const { db } = createFixture();
    const { app, environment } = createApp(db, userAuth);
    const response = await request(app, environment, "/api/v1/api-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "Scoped", scopes: ["read:memos"] }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.apiToken.notebookAccess).toEqual([]);
    expect(body.apiToken.notebookAccessLevel).toBe("read");
  });

  test("explicit null creates an unrestricted (legacy-equivalent) token", async () => {
    const { db } = createFixture();
    const { app, environment } = createApp(db, userAuth);
    const response = await request(app, environment, "/api/v1/api-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "Full", scopes: ["read:memos"], notebookAccess: null }),
    });
    expect((await response.json()).apiToken.notebookAccess).toBeNull();
  });

  test("an explicit whitelist is stored and resolved to its subtree", async () => {
    const { sqlite, db } = createFixture();
    sqlite.query("INSERT INTO notebooks (id, workspace_id, name, parent_id) VALUES ('nb_a_child', 'ws_t', 'Child', 'nb_a')").run();
    const { app, environment } = createApp(db, userAuth);
    const response = await request(app, environment, "/api/v1/api-tokens", {
      method: "POST",
      body: JSON.stringify({
        name: "Whitelisted",
        scopes: ["read:memos"],
        notebookAccess: [{ notebookId: "nb_a", read: true, write: true }],
        notebookAccessLevel: "write",
      }),
    });
    const body = await response.json();
    expect(body.apiToken.notebookAccess).toEqual([{ notebookId: "nb_a", read: true, write: true }]);
    expect(body.apiToken.notebookAccessLevel).toBe("write");

    const access = await resolveNotebookAccess(db, "ws_t", body.apiToken.notebookAccess, body.apiToken.notebookAccessLevel);
    expect([...access.readableNotebookIds].sort()).toEqual(["nb_a", "nb_a_child"]);
    expect([...access.writableNotebookIds].sort()).toEqual(["nb_a", "nb_a_child"]);
  });

  test("unknown notebook ids are rejected", async () => {
    const { db } = createFixture();
    const { app, environment } = createApp(db, userAuth);
    const response = await request(app, environment, "/api/v1/api-tokens", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad", scopes: ["read:memos"],
        notebookAccess: [{ notebookId: "nb_missing", read: true, write: false }],
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "unknown_notebook" } });
  });

  test("PATCH changes permissions in place without changing the token value", async () => {
    const { db } = createFixture();
    const { app, environment } = createApp(db, userAuth);
    const created = await (await request(app, environment, "/api/v1/api-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "Rotating", scopes: ["read:memos"], notebookAccess: null }),
    })).json();

    const patched = await request(app, environment, `/api/v1/api-tokens/${created.apiToken.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        notebookAccess: [{ notebookId: "nb_b", read: true, write: true }],
        notebookAccessLevel: "write",
      }),
    });
    expect(patched.status).toBe(200);
    const body = await patched.json();
    expect(body.apiToken.token).toBe(created.token);
    expect(body.apiToken.name).toBe("Rotating");
    expect(body.apiToken.notebookAccess).toEqual([{ notebookId: "nb_b", read: true, write: true }]);
    expect(body.apiToken.notebookAccessLevel).toBe("write");
  });

  test("PATCH null removes the restriction", async () => {
    const { db } = createFixture();
    const { app, environment } = createApp(db, userAuth);
    const created = await (await request(app, environment, "/api/v1/api-tokens", {
      method: "POST",
      body: JSON.stringify({
        name: "Narrowing", scopes: ["read:memos"],
        notebookAccess: [{ notebookId: "nb_a", read: true, write: false }],
      }),
    })).json();

    const patched = await request(app, environment, `/api/v1/api-tokens/${created.apiToken.id}`, {
      method: "PATCH",
      body: JSON.stringify({ notebookAccess: null }),
    });
    expect((await patched.json()).apiToken.notebookAccess).toBeNull();
  });

  test("a name-only PATCH keeps stored grants (and a corrupted record verbatim)", async () => {
    const { sqlite, db } = createFixture();
    const { app, environment } = createApp(db, userAuth);
    const created = await (await request(app, environment, "/api/v1/api-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "Keep", scopes: ["read:memos"], notebookAccess: null }),
    })).json();

    // Simulate a corrupted grant record written by an older build.
    sqlite.query("UPDATE api_tokens SET notebook_access_json = 'not json', notebook_access_level = 'write' WHERE id = ?")
      .run(created.apiToken.id);

    const patched = await request(app, environment, `/api/v1/api-tokens/${created.apiToken.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(patched.status).toBe(200);
    const body = await patched.json();
    expect(body.apiToken.name).toBe("Renamed");
    // The corrupted JSON stays byte-identical; it must not be rewritten to "[]".
    expect(sqlite.query("SELECT notebook_access_json FROM api_tokens WHERE id = ?").get(created.apiToken.id))
      .toEqual({ notebook_access_json: "not json" });
    // A corrupted record parses to an empty whitelist, so it grants nothing.
    expect(body.apiToken.notebookAccess).toEqual([]);
  });

  test("API tokens cannot manage tokens", async () => {
    const { db } = createFixture();
    const { app, environment } = createApp(db, { ...userAuth, kind: "agent", actorType: "agent" });
    const response = await request(app, environment, "/api/v1/api-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "Nope", scopes: ["read:memos"] }),
    });
    expect(response.status).toBe(403);
  });
});

describe("bearer authentication carries notebook grants", () => {
  test("a stored grant record resolves into the request auth context", async () => {
    const { sqlite, db } = createFixture();
    const { environment } = createApp(db, userAuth);
    const token = "eev_granted_token_value";
    sqlite.query(
      `INSERT INTO api_tokens (id, workspace_id, name, token_hash, token_value, scopes_json, notebook_access_json, notebook_access_level, created_at)
       VALUES ('tok_granted', 'ws_t', 'Bearer', ?, ?, '["read:memos","write:memos"]', ?, 'write', '2026-01-01T00:00:00.000Z')`,
    ).run(
      await sha256(token),
      token,
      JSON.stringify([{ notebookId: "nb_a", read: true, write: true }]),
    );

    const authenticated = await authenticateRequest(
      {
        env: environment,
        req: {
          header: (name) => (String(name).toLowerCase() === "authorization" ? `Bearer ${token}` : undefined),
          raw: new Request("http://localhost/"),
        },
        get: () => undefined,
      },
      false,
    );
    expect(authenticated.notebookAccess).toEqual([{ notebookId: "nb_a", read: true, write: true }]);
    expect(authenticated.notebookAccessLevel).toBe("write");

    const access = await resolveNotebookAccess(db, "ws_t", authenticated.notebookAccess, authenticated.notebookAccessLevel);
    expect(access.restricted).toBe(true);
    expect(access.readableNotebookIds).toEqual(["nb_a"]);
  });

  test("a legacy token row with NULL grants stays unrestricted", async () => {
    const { sqlite, db } = createFixture();
    const { environment } = createApp(db, userAuth);
    const token = "eev_legacy_token_value";
    sqlite.query(
      `INSERT INTO api_tokens (id, workspace_id, name, token_hash, token_value, scopes_json, created_at)
       VALUES ('tok_legacy', 'ws_t', 'Legacy', ?, ?, '["read:memos"]', '2026-01-01T00:00:00.000Z')`,
    ).run(await sha256(token), token);

    const authenticated = await authenticateRequest(
      {
        env: environment,
        req: {
          header: (name) => (String(name).toLowerCase() === "authorization" ? `Bearer ${token}` : undefined),
          raw: new Request("http://localhost/"),
        },
        get: () => undefined,
      },
      false,
    );
    expect(authenticated.notebookAccess).toBeNull();
    expect(authenticated.notebookAccessLevel).toBe("read");
  });
});

import { describe, expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  isCorruptedNotebookAccess,
  parseNotebookAccessJson,
  parseNotebookAccessLevel,
} from "./token-notebook-access.ts";

const allMigrations = () => globSync("migrations/*.sql").sort();

const runMigrations = (sqlite, files) => {
  for (const file of files) sqlite.exec(readFileSync(file, "utf8"));
};

const atMost = (name) => (file) => file.localeCompare(`migrations/${name}`) <= 0;

describe("0103 upgrade from 0102", () => {
  test("existing rows survive the upgrade with their previous (unrestricted) access", () => {
    const files = allMigrations();
    const target = "0103_api_token_notebook_whitelist.sql";
    expect(files).toContain(`migrations/${target}`);

    // Build a database exactly as it stood at 0102.
    const sqlite = new Database(":memory:");
    runMigrations(sqlite, files.filter(atMost("0102_mcp_idempotency_receipts.sql")));

    sqlite.query("INSERT INTO workspaces (id, name, is_personal) VALUES ('ws_old', 'Old', 1)").run();
    const insert = sqlite.query(
      `INSERT INTO api_tokens (id, workspace_id, name, token_hash, token_value, scopes_json, created_at)
       VALUES (?, 'ws_old', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    );
    insert.run("tok_ro", "Read only", "hash-ro", "eev_ro", '["read:memos","read:notebooks"]');
    insert.run("tok_full", "Full", "hash-full", "eev_full",
      '["read:notebooks","write:notebooks","read:memos","write:memos","read:resources","write:resources","read:tags","write:tags","ai:generate"]');

    // Apply only the new migration.
    sqlite.exec(readFileSync(`migrations/${target}`, "utf8"));

    const rows = sqlite.query(
      "SELECT id, notebook_access_json, notebook_access_level, scopes_json FROM api_tokens ORDER BY id",
    ).all();
    expect(rows).toEqual([
      {
        id: "tok_full",
        notebook_access_json: null,
        notebook_access_level: null,
        scopes_json: '["read:notebooks","write:notebooks","read:memos","write:memos","read:resources","write:resources","read:tags","write:tags","ai:generate"]',
      },
      {
        id: "tok_ro",
        notebook_access_json: null,
        notebook_access_level: null,
        scopes_json: '["read:memos","read:notebooks"]',
      },
    ]);

    // Legacy rows parse as unrestricted, so their behaviour is unchanged.
    for (const row of rows) {
      expect(parseNotebookAccessJson(row.notebook_access_json)).toBeNull();
      expect(parseNotebookAccessLevel(row.notebook_access_level)).toBe("read");
      expect(isCorruptedNotebookAccess(row.notebook_access_json)).toBe(false);
    }
  });

  test("the new columns accept only the documented level values", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite, allMigrations());
    sqlite.query("INSERT INTO workspaces (id, name, is_personal) VALUES ('ws_t', 'T', 1)").run();
    sqlite.query(
      `INSERT INTO api_tokens (id, workspace_id, name, token_hash, scopes_json, notebook_access_level, created_at)
       VALUES ('tok_a', 'ws_t', 'A', 'h', '["read:memos"]', 'write', '2026-01-01T00:00:00.000Z')`,
    ).run();
    expect(() => sqlite.query(
      `INSERT INTO api_tokens (id, workspace_id, name, token_hash, scopes_json, notebook_access_level, created_at)
       VALUES ('tok_b', 'ws_t', 'B', 'h2', '["read:memos"]', 'bogus', '2026-01-01T00:00:00.000Z')`,
    ).run()).toThrow();
  });

  test("a fresh install ends with the same schema as an upgrade", () => {
    const fresh = new Database(":memory:");
    runMigrations(fresh, allMigrations());

    const upgraded = new Database(":memory:");
    const files = allMigrations();
    runMigrations(upgraded, files.filter(atMost("0102_mcp_idempotency_receipts.sql")));
    upgraded.exec(readFileSync("migrations/0103_api_token_notebook_whitelist.sql", "utf8"));

    const columns = (db) => db.query("PRAGMA table_info(api_tokens)").all().map((row) => row.name);
    expect(columns(upgraded)).toEqual(columns(fresh));
    expect(columns(fresh)).toContain("notebook_access_json");
    expect(columns(fresh)).toContain("notebook_access_level");
  });

  test("0103 is additive only: no existing column changes shape", () => {
    const sql = readFileSync("migrations/0103_api_token_notebook_whitelist.sql", "utf8");
    // No destructive or rewriting statements.
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql.match(/ALTER TABLE api_tokens ADD COLUMN/g)).toHaveLength(2);
  });
});

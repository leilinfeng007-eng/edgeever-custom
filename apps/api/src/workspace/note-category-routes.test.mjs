import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createSelfHostedStorageAdapter } from "../storage/self-hosted-storage-adapter.ts";
import { registerNoteCategoryRoutes } from "./note-category-routes.ts";

const migrationFiles = globSync("migrations/*.sql").sort();
const directories = [];
const opened = [];
afterEach(() => {
  opened.splice(0).forEach((sqlite) => sqlite.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

const workspaceId = "ws_default";
const auth = {
  kind: "user",
  actorType: "user",
  actorId: null,
  workspaceId,
  role: "owner",
  scopes: [],
  username: "test",
};

// The real app resolves the session/token in middleware; these tests only need
// the resulting auth context plus a way to drive each scope case.
const createApp = async (prepareDemoData) => {
  const directory = mkdtempSync(join(tmpdir(), "edgeever-note-category-routes-test-"));
  directories.push(directory);
  const sqlite = new Database(":memory:");
  opened.push(sqlite);
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of migrationFiles) sqlite.exec(readFileSync(file, "utf8"));

  const app = new Hono();
  app.use("*", async (c, next) => {
    const header = c.req.header("test-auth") ?? "user";
    if (header !== "none") {
      const kind = header.startsWith("agent") ? "agent" : "user";
      c.set("auth", {
        ...auth,
        kind,
        actorType: kind,
        actorId: kind === "agent" ? "test-token" : null,
        scopes: kind === "agent" && header === "agent-read" ? ["read:notebooks"] : kind === "agent" ? ["read:memos"] : [],
      });
    }
    await next();
  });
  registerNoteCategoryRoutes(app, { prepareDemoData });
  const env = { storage: createSelfHostedStorageAdapter(sqlite, directory) };
  return {
    sqlite,
    env,
    get: (headers) => app.request("/api/v1/workspaces/note-categories", { headers }, env),
  };
};

describe("GET /api/v1/workspaces/note-categories", () => {
  test("reports the inbox and the four categories in order for a signed-in user", async () => {
    const { get } = await createApp(undefined);
    const response = await get();

    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report.categories.map(({ key, notebookId }) => ({ key, notebookId }))).toEqual([
      { key: "inbox", notebookId: "nb_inbox" },
      { key: "projects", notebookId: "nb_projects" },
      { key: "system-issues", notebookId: "ws_default_system_issues" },
      { key: "learning", notebookId: "nb_learning" },
      { key: "temp", notebookId: "ws_default_temp" },
    ]);
    expect(report.categories.map(({ name }) => name)).toEqual(["等待分类", "工作项目", "系统问题记录", "个人学习", "临时记录"]);
    // Legacy notebooks stay visible as unmapped instead of being renamed or hidden.
    expect(report.unmapped).toEqual([
      { id: "nb_creative", name: "灵感创作" },
      { id: "nb_personal", name: "生活个人" },
    ]);
  });

  test("requires the read:notebooks scope", async () => {
    const { get } = await createApp(undefined);
    expect((await get({ "test-auth": "none" })).status).toBe(401);
    expect((await get({ "test-auth": "agent-read" })).status).toBe(200);
    expect((await get({ "test-auth": "agent-no-scope" })).status).toBe(403);
  });

  test("runs the demo seed hook first so demo notebooks never reach the report", async () => {
    let calls = 0;
    const { sqlite, get } = await createApp(async () => {
      calls += 1;
      sqlite.exec(`
        INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, sort_order)
        VALUES ('nb_demo_features', '${workspaceId}', NULL, 'EdgeEver 功能演示', 'demo-features', 21),
               ('nb_demo_features_zh', '${workspaceId}', 'nb_demo_features', '中文功能演示', 'demo-features-zh', 1);
      `);
    });

    const report = await (await get()).json();

    expect(calls).toBe(1);
    expect(report.categories.map(({ notebookId }) => notebookId)).toEqual([
      "nb_inbox", "nb_projects", "ws_default_system_issues", "nb_learning", "ws_default_temp",
    ]);
    expect(report.unmapped.map(({ id }) => id)).toEqual(["nb_creative", "nb_personal"]);
  });
});

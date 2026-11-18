import { Database } from "bun:sqlite";
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processInboxClassification } from "./inbox-classification.ts";
import { executeWorkspaceTool } from "../mcp/mcp-tool-executor.ts";
import { createMemoRecord, getMemoDetail } from "../notes/memo-service.ts";
import { createSelfHostedStorageAdapter } from "../storage/self-hosted-storage-adapter.ts";

const workspaceId = "ws_default";
const noteMarkdown = "## 处理过程\n\nWeKnora 容器部署完成，验证健康接口返回正常。";
const auth = {
  kind: "agent",
  actorType: "agent",
  actorId: "classification-test-token",
  username: "test-agent",
  displayName: null,
  workspaceId,
  scopes: ["read:memos", "write:memos"],
  role: "owner",
};

async function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "edgeever-classification-test-"));
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const file of readdirSync("migrations").sort().filter(file => file.endsWith(".sql"))) {
      sqlite.exec(readFileSync(join("migrations", file), "utf8"));
    }
    const env = {
      storage: createSelfHostedStorageAdapter(sqlite, directory),
      EDGE_EVER_RUNTIME: "self-hosted-bun",
      EDGE_EVER_AUTO_CLASSIFY_WORKSPACE: workspaceId,
    };
    const context = { env, get: () => auth };
    const create = async (options = {}, identity = auth, ready = true) => {
      const { memo } = await executeWorkspaceTool(context, identity, "create_memo", {
        notebookId: "nb_inbox",
        title: "WeKnora 部署记录",
        contentMarkdown: noteMarkdown,
        tags: ["AI沉淀", "WeKnora"],
        ...options,
      });
      if (ready) sqlite.query("UPDATE inbox_classification_jobs SET available_at = 0 WHERE memo_id = ?").run(memo.id);
      return memo;
    };
    const get = id => getMemoDetail(env.storage.db, workspaceId, id);
    const job = id => sqlite.query("SELECT status, attempts, outcome FROM inbox_classification_jobs WHERE memo_id = ?").get(id);
    const classify = (decide, now) => processInboxClassification(env, new AbortController().signal, decide, now);
    await run({ sqlite, env, create, get, job, classify, context });
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("MCP inbox creation queues classification and moves the same note without changing its Markdown", async () => {
  await withFixture(async ({ sqlite, create, classify, get, job }) => {
    sqlite.query("INSERT INTO notebooks(id, workspace_id, name, parent_id) VALUES ('notes_project', ?, '个人 AI OS', 'nb_projects')").run(workspaceId);
    sqlite.query("INSERT INTO notebooks(id, workspace_id, name) VALUES ('local_examples', ?, 'EdgeEver 功能演示')").run(workspaceId);
    const memo = await create();
    expect(memo.notebookId).toBe("nb_inbox");
    expect(job(memo.id)).toMatchObject({ status: "pending", attempts: 0 });
    await classify(async ({ note, destinations }) => {
      expect(note.text).toContain("WeKnora");
      expect(destinations).toContainEqual({ id: "notes_project", path: "工作项目 / 个人 AI OS" });
      expect(destinations.some(item => item.id.startsWith("nb_demo_features") || item.id === "local_examples")).toBe(false);
      return { notebookId: "notes_project", tags: ["weknora", "Docker", "#部署排查"] };
    });
    expect(await get(memo.id)).toMatchObject({
      id: memo.id, notebookId: "notes_project", title: memo.title, contentMarkdown: noteMarkdown,
      tags: ["AI沉淀", "WeKnora", "Docker", "部署排查"], revision: memo.revision + 1,
    });
    expect(job(memo.id)).toMatchObject({ status: "moved", outcome: "classified" });
    expect(sqlite.query("SELECT tags FROM memo_search_documents WHERE memo_id = ?").get(memo.id).tags).toContain("部署排查");
    await classify(() => { throw new Error("Completed jobs must not run again."); });
    expect((await get(memo.id)).revision).toBe(memo.revision + 1);
  });
});

test("direct destinations, manual notes, other workspaces and disabled instances bypass the classifier", async () => {
  await withFixture(async ({ sqlite, env, create, job, get }) => {
    const direct = await create({ notebookId: "nb_learning" });
    expect(direct.notebookId).toBe("nb_learning");
    expect(job(direct.id)).toBeNull();
    const manual = await createMemoRecord(env.storage.db, workspaceId, {
      notebookId: "nb_inbox", title: "手动录入", contentMarkdown: noteMarkdown,
    }, { actorType: "user", actorId: null }, "user");
    expect(job(manual.id)).toBeNull();
    sqlite.query("INSERT INTO workspaces (id, name, is_personal) VALUES ('ws_another', 'Other', 1)").run();
    sqlite.query("INSERT INTO notebooks (id, workspace_id, name, slug) VALUES ('ws_another_inbox', 'ws_another', '等待分类', 'inbox')").run();
    const other = await create({ notebookId: "ws_another_inbox" }, { ...auth, workspaceId: "ws_another" });
    expect(job(other.id)).toBeNull();
    env.EDGE_EVER_AUTO_CLASSIFY_WORKSPACE = undefined;
    const disabled = await create();
    expect(job(disabled.id)).toBeNull();
    expect((await get(disabled.id)).notebookId).toBe("nb_inbox");
  });
});

test("uncertain and unlisted destinations retain the original inbox note", async () => {
  await withFixture(async ({ create, get, job, classify }) => {
    const uncertain = await create();
    await classify(async () => ({ notebookId: null, tags: [] }));
    const invalid = await create();
    await classify(async () => ({ notebookId: "invented-or-foreign", tags: ["不应写入"] }));
    expect(job(uncertain.id)).toMatchObject({ status: "retained", outcome: "unclear" });
    expect(job(invalid.id)).toMatchObject({ status: "retained", outcome: "invalid_destination" });
    expect(await get(invalid.id)).toMatchObject({ notebookId: "nb_inbox", tags: invalid.tags, revision: invalid.revision });
  });
});

test("temporary provider failures retry and a claim interrupted by a restart can be acquired again", async () => {
  await withFixture(async ({ sqlite, create, classify, get, job }) => {
    const memo = await create();
    await classify(async () => { throw new Error("fixture model failed"); }, 1);
    expect(job(memo.id)).toMatchObject({ status: "pending", attempts: 1, outcome: "classification_failed" });
    await classify(async () => { throw new Error("Retry must wait"); }, 10_000);
    expect(job(memo.id).attempts).toBe(1);
    sqlite.query("UPDATE inbox_classification_jobs SET status = 'running', claim_token = 'interrupted-process', available_at = 90_000 WHERE memo_id = ?").run(memo.id);
    await classify(async () => ({ notebookId: "nb_projects", tags: [] }), 90_001);
    expect(job(memo.id)).toMatchObject({ status: "moved", attempts: 2 });
    expect((await get(memo.id)).notebookId).toBe("nb_projects");
  });
});

test("human moves and edits during inference take precedence", async () => {
  await withFixture(async ({ create, classify, get, job, context }) => {
    const memo = await create();
    await classify(async () => {
      await executeWorkspaceTool(context, auth, "update_memo", {
        memoId: memo.id, notebookId: "nb_learning", title: "用户已另行归档",
      });
      return { notebookId: "nb_projects", tags: ["不应写入"] };
    });
    expect(job(memo.id)).toMatchObject({ status: "retained", outcome: "source_changed" });
    expect(await get(memo.id)).toMatchObject({ notebookId: "nb_learning", title: "用户已另行归档", tags: memo.tags });
  });
});

test("a destination renamed during inference aborts the memo and tag mutation together", async () => {
  await withFixture(async ({ sqlite, create, classify, get, job }) => {
    const memo = await create();
    await classify(async () => {
      sqlite.query("UPDATE notebooks SET name = '更名工作项目' WHERE id = 'nb_projects'").run();
      return { notebookId: "nb_projects", tags: ["不应写入"] };
    });
    expect(job(memo.id)).toMatchObject({ status: "retained", outcome: "source_or_destination_changed" });
    expect(await get(memo.id)).toMatchObject({ notebookId: "nb_inbox", tags: memo.tags, revision: memo.revision });
  });
});


test("MCP completion postpones a queued classification and a stale decision cannot move the note", async () => {
  await withFixture(async ({ create, context, classify, get, job, sqlite }) => {
    const memo = await create({ contentMarkdown: "" }, auth, false);
    const available = () => sqlite.query("SELECT available_at FROM inbox_classification_jobs WHERE memo_id = ?").get(memo.id).available_at;
    await classify(() => { throw new Error("Unfinished note was classified."); }, available() - 1);
    expect(job(memo.id).attempts).toBe(0);
    const update = (contentMarkdown) => executeWorkspaceTool(context, auth, "update_memo", { memoId: memo.id, contentMarkdown });
    await update("first version");
    await classify(async ({ note }) => {
      expect(note.text).toBe("first version");
      await update("final text");
      return { notebookId: "nb_projects", tags: [] };
    }, available());
    expect(job(memo.id)).toMatchObject({ status: "pending", attempts: 0 });
    expect((await get(memo.id)).notebookId).toBe("nb_inbox");
    await classify(async ({ note }) => {
      expect(note.text).toBe("final text");
      return { notebookId: "nb_projects", reason: "明确的项目方案。", tags: [] };
    }, available());
    expect((await get(memo.id)).notebookId).toBe("nb_projects");
    expect(job(memo.id)).toMatchObject({ status: "moved", outcome: "classified" });
  });
});

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWorkspaceTool } from "./mcp-tool-executor.ts";
import { createSelfHostedStorageAdapter } from "../storage/self-hosted-storage-adapter.ts";

const workspaceId = "ws_default";
const auth = {
  kind: "agent",
  actorType: "agent",
  actorId: "conversation-test-token",
  username: "conversation-agent",
  displayName: null,
  workspaceId,
  scopes: ["read:memos", "write:memos", "read:resources", "write:resources"],
  role: "owner",
};

async function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "edgeever-ai-conversation-"));
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const file of readdirSync("migrations").sort().filter(name => name.endsWith(".sql"))) {
      sqlite.exec(readFileSync(join("migrations", file), "utf8"));
    }
    const env = {
      storage: createSelfHostedStorageAdapter(sqlite, directory),
      EDGE_EVER_RUNTIME: "self-hosted-bun",
      EDGE_EVER_AUTO_CLASSIFY_WORKSPACE: workspaceId,
    };
    const context = { env, get: () => auth };
    const call = (name, args) => executeWorkspaceTool(context, auth, name, args);
    const notebookId = slug => sqlite.query(
      "SELECT id FROM notebooks WHERE workspace_id = ? AND slug = ? LIMIT 1",
    ).get(workspaceId, slug)?.id;
    const jobCount = memoId => sqlite.query(
      "SELECT COUNT(*) AS count FROM inbox_classification_jobs WHERE memo_id = ?",
    ).get(memoId).count;
    await run({ sqlite, env, call, notebookId, jobCount });
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("saving a conversation uses the AI template, the object|topic title and the AI tag", async () => {
  await withFixture(async ({ call }) => {
    const saved = await call("save_ai_conversation", {
      message: "如何安排发布节奏？",
      response: "分三批发布。参考 https://example.com/release",
      object: "产品发布计划",
    });
    expect(saved.memo.title).toBe("产品发布计划｜如何安排发布节奏？");
    expect(saved.memo.notebookId).toBe("nb_inbox");
    expect(saved.memo.tags).toContain("AI沉淀");
    expect(saved.memo.contentMarkdown.startsWith("## 结论")).toBe(true);
    for (const heading of ["## 结论", "## 关键步骤 / 依据", "## 验证结果", "## 来源 / 链接"]) {
      expect(saved.memo.contentMarkdown.match(new RegExp(heading.replace(/[/]/g, "\\/"), "g"))).toHaveLength(1);
    }
    expect(saved.memo.contentMarkdown).toContain("- https://example.com/release");
    expect(saved.action).toBe("save_conversation");
    expect(saved.classificationQueued).toBe(true);
  });
});

test("an explicitly named note is supplemented in place and keeps its notebook", async () => {
  await withFixture(async ({ call, notebookId, jobCount }) => {
    const projects = notebookId("work-projects");
    const target = await call("create_memo", {
      notebookId: projects,
      title: "发布记录",
      contentMarkdown: "## 背景\n\n既有背景\n\n## 结论\n\n旧结论\n",
      tags: ["项目"],
    });
    const saved = await call("save_ai_conversation", {
      message: "发布节奏怎么定？",
      response: "分批发布",
      memoId: target.memo.id,
      expectedRevision: target.memo.revision,
      duplicate: "supplement",
      section: { heading: "结论", mode: "append" },
    });
    expect(saved.memo.id).toBe(target.memo.id);
    expect(saved.memo.notebookId).toBe(projects);
    expect(saved.memo.tags).toContain("项目");
    expect(saved.memo.tags).toContain("AI沉淀");
    expect(saved.memo.contentMarkdown).toContain("旧结论\n\n分批发布");
    expect(saved.memo.contentMarkdown).toContain("既有背景");
    expect(saved.action).toBe("supplement");
    expect(saved.moved).toBe(false);
    expect(jobCount(target.memo.id)).toBe(0);
  });
});

test("a same-topic merge moves the note to the inbox even with automatic classification off", async () => {
  await withFixture(async ({ call, notebookId, env, jobCount }) => {
    const projects = notebookId("work-projects");
    const target = await call("create_memo", {
      notebookId: projects,
      title: "发布记录",
      contentMarkdown: "## 背景\n\n既有背景\n",
    });
    env.EDGE_EVER_AUTO_CLASSIFY = "false";

    const merged = await call("save_ai_conversation", {
      message: "发布节奏怎么定？",
      response: "分批发布",
      memoId: target.memo.id,
      expectedRevision: target.memo.revision,
      duplicate: "merge",
    });
    expect(merged.memo.id).toBe(target.memo.id);
    expect(merged.memo.notebookId).toBe("nb_inbox");
    expect(merged.moved).toBe(true);
    expect(merged.placement).toBe("reclassify");
    // 自动分类关闭：进入等待分类但不产生任务。
    expect(merged.classificationQueued).toBe(false);
    expect(jobCount(target.memo.id)).toBe(0);

    const readBack = await call("get_memo", { memoId: target.memo.id });
    expect(readBack.memo.notebookId).toBe("nb_inbox");
    expect(readBack.memo.contentMarkdown).toContain("分批发布");
  });
});

test("a same-title conversation returns candidates instead of writing", async () => {
  await withFixture(async ({ call, sqlite, notebookId }) => {
    const projects = notebookId("work-projects");
    const existing = await call("create_memo", {
      notebookId: projects,
      title: "产品发布计划｜如何安排发布节奏？",
      contentMarkdown: "旧的发布记录",
    });
    let failure;
    try {
      await call("save_ai_conversation", {
        message: "如何安排发布节奏？",
        response: "分三批发布",
        object: "产品发布计划",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure?.code).toBe("duplicate_match_found");
    expect(failure?.status).toBe(409);
    expect(failure?.details?.candidates).toHaveLength(1);
    expect(failure.details.candidates[0]).toMatchObject({
      memoId: existing.memo.id,
      title: "产品发布计划｜如何安排发布节奏？",
      notebookId: projects,
    });
    expect(failure.details.candidates[0].excerpt).toBe("旧的发布记录");
    expect(sqlite.query("SELECT COUNT(*) AS count FROM memos WHERE workspace_id = ? AND title = ?")
      .get(workspaceId, "产品发布计划｜如何安排发布节奏？").count).toBe(1);
  });
});

test("two same-titled notes with different bodies each report their own excerpt and nothing is written", async () => {
  await withFixture(async ({ call, sqlite, notebookId }) => {
    const projects = notebookId("work-projects");
    // Same title, different bodies: both are same-topic candidates for this title.
    const first = await call("create_memo", {
      notebookId: projects,
      title: "发布计划",
      contentMarkdown: "先灰度百分之十的流量，观察一天。",
    });
    const second = await call("create_memo", {
      notebookId: projects,
      title: "发布计划",
      contentMarkdown: "保留上一版本镜像，异常时五分钟内回滚。",
      allowDuplicate: true,
    });
    const memoCountBefore = sqlite.query("SELECT COUNT(*) AS count FROM memos WHERE workspace_id = ?")
      .get(workspaceId).count;
    const revisionsBefore = sqlite.query(
      "SELECT memo_id, revision FROM memo_contents WHERE memo_id IN (?, ?) ORDER BY memo_id",
    ).all(first.memo.id, second.memo.id);

    let failure;
    try {
      await call("save_ai_conversation", {
        message: "发布计划怎么安排？",
        response: "先灰度再全量，并保留回滚镜像",
        title: "发布计划",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure?.code).toBe("duplicate_match_found");
    expect(failure.details.candidates).toHaveLength(2);

    // Each candidate carries the excerpt of its own body, not the other note's.
    const excerptById = new Map(failure.details.candidates.map((candidate) => [candidate.memoId, candidate.excerpt]));
    expect(excerptById.get(first.memo.id)).toContain("灰度百分之十");
    expect(excerptById.get(second.memo.id)).toContain("五分钟内回滚");
    expect(excerptById.get(first.memo.id)).not.toBe(excerptById.get(second.memo.id));
    for (const candidate of failure.details.candidates) {
      expect(candidate).toMatchObject({ title: "发布计划", notebookId: projects, reason: "same_title" });
      expect(candidate.excerpt.length).toBeGreaterThan(0);
      expect(candidate.excerpt.length).toBeLessThanOrEqual(200);
    }

    // Choosing to save separately afterwards is the only write.
    expect(sqlite.query("SELECT COUNT(*) AS count FROM memos WHERE workspace_id = ?")
      .get(workspaceId).count).toBe(memoCountBefore);
    expect(sqlite.query(
      "SELECT memo_id, revision FROM memo_contents WHERE memo_id IN (?, ?) ORDER BY memo_id",
    ).all(first.memo.id, second.memo.id)).toEqual(revisionsBefore);
  });
});

test("duplicate=new saves a separate note and duplicate=supplement without memoId is rejected", async () => {
  await withFixture(async ({ call, notebookId }) => {
    const projects = notebookId("work-projects");
    const existing = await call("create_memo", {
      notebookId: projects,
      title: "产品发布计划｜如何安排发布节奏？",
      contentMarkdown: "旧的发布记录",
    });
    const created = await call("save_ai_conversation", {
      message: "如何安排发布节奏？",
      response: "分三批发布",
      object: "产品发布计划",
      duplicate: "new",
    });
    expect(created.memo.id).not.toBe(existing.memo.id);
    expect(created.memo.notebookId).toBe("nb_inbox");
    expect(created.action).toBe("save_new");

    await expect(call("save_ai_conversation", {
      message: "另一个问题",
      response: "另一个回答",
      duplicate: "supplement",
    })).rejects.toMatchObject({ code: "invalid_params" });
  });
});

test("a retried conversation save with the same idempotency key applies once", async () => {
  await withFixture(async ({ call, sqlite, notebookId }) => {
    const projects = notebookId("work-projects");
    const target = await call("create_memo", {
      notebookId: projects, title: "补充目标", contentMarkdown: "## 验证结果\n\n第一版\n",
    });
    const args = {
      message: "验证结果？",
      response: "本地通过",
      memoId: target.memo.id,
      expectedRevision: target.memo.revision,
      duplicate: "supplement",
      idempotencyKey: "save-conversation-1",
    };
    const first = await call("save_ai_conversation", args);
    const retried = await call("save_ai_conversation", { ...args, expectedRevision: first.memo.revision });
    expect(retried.idempotentReplay).toBe(true);
    expect(retried.memo.revision).toBe(first.memo.revision);
    const readBack = await call("get_memo", { memoId: target.memo.id });
    expect(readBack.memo.contentMarkdown.match(/本地通过/g)).toHaveLength(1);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM memos WHERE workspace_id = ? AND title = ?")
      .get(workspaceId, "补充目标").count).toBe(1);
  });
});

test("a stale revision when supplementing names the current version", async () => {
  await withFixture(async ({ call, notebookId }) => {
    const projects = notebookId("work-projects");
    const target = await call("create_memo", {
      notebookId: projects, title: "并发补充", contentMarkdown: "## 结论\n\n原结论\n",
    });
    let failure;
    try {
      await call("save_ai_conversation", {
        message: "问题",
        response: "回答",
        memoId: target.memo.id,
        expectedRevision: target.memo.revision + 3,
        duplicate: "supplement",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure?.code).toBe("revision_conflict");
    expect(failure?.details).toMatchObject({
      currentRevision: target.memo.revision,
      memoId: target.memo.id,
    });
  });
});

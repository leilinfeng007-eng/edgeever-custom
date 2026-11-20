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
  actorId: "workflow-test-token",
  username: "workflow-agent",
  displayName: null,
  workspaceId,
  scopes: ["read:memos", "write:memos", "read:resources", "write:resources"],
  role: "owner",
};

async function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "edgeever-note-workflow-"));
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
    const notebookId = sqlite.query("SELECT id FROM notebooks WHERE workspace_id = ? ORDER BY id LIMIT 1").get(workspaceId)?.id;
    const countMemos = title => sqlite.query("SELECT COUNT(*) AS count FROM memos WHERE workspace_id = ? AND title = ? AND is_deleted = 0")
      .get(workspaceId, title).count;
    await run({ sqlite, env, context, call, notebookId, countMemos });
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("reuses exact repeats, blocks title-only merges, and keeps source retries idempotent", async () => {
  await withFixture(async ({ sqlite, call, countMemos }) => {
    const first = await call("create_memo", { title: "发布复盘", contentMarkdown: "同一份内容" });
    const second = await call("create_memo", { title: "发布复盘", contentMarkdown: "同一份内容" });
    expect(second.reused).toBe(true);
    expect(second.memo.id).toBe(first.memo.id);
    expect(countMemos("发布复盘")).toBe(1);

    await expect(call("create_memo", { title: "发布复盘", contentMarkdown: "不同内容" }))
      .rejects.toMatchObject({ code: "duplicate_match_found", status: 409 });
    expect(countMemos("发布复盘")).toBe(1);

    await expect(call("create_memo", { title: "另一份复盘", contentMarkdown: "同一份内容" }))
      .rejects.toMatchObject({ code: "duplicate_match_found", status: 409 });
    expect(countMemos("另一份复盘")).toBe(0);

    const differentlyTitled = await call("create_memo", {
      title: "另一份复盘", contentMarkdown: "同一份内容", allowDuplicate: true,
    });
    expect(differentlyTitled.memo.title).toBe("另一份复盘");
    expect(differentlyTitled.memo.id).not.toBe(first.memo.id);
    expect(countMemos("另一份复盘")).toBe(1);

    const copy = await call("create_memo", { title: "发布复盘", contentMarkdown: "不同内容", allowDuplicate: true });
    expect(copy.memo.id).not.toBe(first.memo.id);
    expect(countMemos("发布复盘")).toBe(2);

    const sourced = await call("create_memo", {
      title: "同步记录", contentMarkdown: "v1", source: "agent-run", sourceId: "run-1", allowDuplicate: true,
    });
    const repeated = await call("create_memo", {
      title: "同步记录", contentMarkdown: "v2", source: "agent-run", sourceId: "run-1",
    });
    expect(repeated.reused).toBe(true);
    expect(repeated.updated).toBe(true);
    expect(repeated.memo.id).toBe(sourced.memo.id);
    expect(repeated.memo.contentMarkdown).toBe("v2");
    expect(countMemos("同步记录")).toBe(1);
    expect(sqlite.query("SELECT content_hash FROM memo_import_sources WHERE workspace_id = ? AND source = ? AND external_id = ?")
      .get(workspaceId, "agent-run", "run-1").content_hash).toBe(repeated.memo.contentHash);
  });
});

test("deduplicates inside the target notebook and never overwrites a manual edit", async () => {
  await withFixture(async ({ sqlite, call, notebookId }) => {
    const otherNotebookId = sqlite.query(
      "SELECT id FROM notebooks WHERE workspace_id = ? AND id <> ? AND is_deleted = 0 ORDER BY id LIMIT 1",
    ).get(workspaceId, notebookId).id;

    const original = await call("create_memo", {
      notebookId, title: "去重手改", contentMarkdown: "原始内容",
    });
    const repeat = await call("create_memo", {
      notebookId, title: "去重手改", contentMarkdown: "原始内容",
    });
    expect(repeat.reused).toBe(true);
    expect(repeat.memo.id).toBe(original.memo.id);

    await call("update_memo", {
      memoId: original.memo.id,
      expectedRevision: original.memo.revision,
      autoClassify: false,
      contentMarkdown: "用户手动修改后的内容",
    });
    await expect(call("create_memo", {
      notebookId, title: "去重手改", contentMarkdown: "原始内容",
    })).rejects.toMatchObject({ code: "duplicate_match_found", status: 409 });

    const inFirst = await call("create_memo", {
      notebookId, title: "跨笔记本同内容", contentMarkdown: "相同正文",
    });
    const inSecond = await call("create_memo", {
      notebookId: otherNotebookId, title: "跨笔记本同内容", contentMarkdown: "相同正文",
    });
    expect(inSecond.memo.id).not.toBe(inFirst.memo.id);
    expect(inSecond.memo.notebookId).toBe(otherNotebookId);
  });
});

test("updates one unique section, preserves other content, and rejects ambiguous or stale edits", async () => {
  await withFixture(async ({ call, notebookId }) => {
    const created = await call("create_memo", {
      notebookId,
      title: "章节更新",
      contentMarkdown: "# 计划\n\n## 背景\n\n旧背景\n\n## 结果\n\n旧结果\n\n## 附件\n\n保持原样\n",
    });
    const appended = await call("update_memo", {
      memoId: created.memo.id,
      expectedRevision: created.memo.revision,
      sectionOperations: [{ heading: "背景", mode: "append", contentMarkdown: "新增背景" }],
    });
    expect(appended.memo.contentMarkdown).toContain("旧背景\n\n新增背景");
    expect(appended.memo.contentMarkdown).toContain("## 结果\n\n旧结果");
    expect(appended.memo.contentMarkdown).toContain("## 附件\n\n保持原样");

    const replaced = await call("update_memo", {
      memoId: created.memo.id,
      expectedRevision: appended.memo.revision,
      sectionOperations: [{ heading: "结果", mode: "replace", contentMarkdown: "新结果" }],
    });
    expect(replaced.memo.contentMarkdown).toContain("## 结果\n\n新结果");
    expect(replaced.memo.contentMarkdown).not.toContain("旧结果");
    expect(replaced.memo.contentMarkdown).toContain("旧背景\n\n新增背景");

    await expect(call("update_memo", {
      memoId: created.memo.id,
      expectedRevision: replaced.memo.revision,
      contentMarkdown: "全量替换",
      sectionOperations: [{ heading: "背景", mode: "append", contentMarkdown: "x" }],
    })).rejects.toMatchObject({ code: "invalid_params" });

    await expect(call("update_memo", {
      memoId: created.memo.id,
      expectedRevision: 0,
      sectionOperations: [{ heading: "背景", mode: "append", contentMarkdown: "并发写入" }],
    })).rejects.toMatchObject({ code: "revision_conflict", status: 409 });
    const unchanged = await call("get_memo", { memoId: created.memo.id });
    expect(unchanged.memo.contentMarkdown).not.toContain("并发写入");

    const ambiguous = await call("create_memo", {
      notebookId,
      title: "重复标题",
      contentMarkdown: "## 记录\n\nA\n\n## 记录\n\nB\n",
    });
    await expect(call("update_memo", {
      memoId: ambiguous.memo.id,
      expectedRevision: ambiguous.memo.revision,
      sectionOperations: [{ heading: "记录", mode: "append", contentMarkdown: "C" }],
    })).rejects.toMatchObject({ code: "section_ambiguous", status: 409 });
  });
});

test("selects a note template by purpose and cleans template instructions", async () => {
  await withFixture(async ({ sqlite, call }) => {
    const now = new Date().toISOString();
    sqlite.query(`INSERT INTO memo_templates (
      id, workspace_id, name, description, title, content_json, content_markdown, tags_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "tpl_meeting", workspaceId, "会议纪要", null, null, "{}", "# 会议纪要\n\n## 议题\n\n## 结论", '["meeting-template"]', now, now,
    );
    const created = await call("create_memo", {
      title: "定价评审会议纪要",
      purpose: "meeting",
      contentMarkdown: "# 会议纪要\n\n> 填写说明：只记录事实\n\n## 议题\n\n定价方案\n\n## 结论\n\n通过\n\n## 空章节\n",
    });
    expect(created.appliedTemplate).toMatchObject({ id: "tpl_meeting", name: "会议纪要" });
    expect(created.templateSelection).toBe("meeting");
    expect(created.memo.tags).toContain("meeting-template");
    expect(created.memo.contentMarkdown).toContain("定价方案");
    expect(created.memo.contentMarkdown).not.toContain("填写说明");
    expect(created.memo.contentMarkdown).not.toContain("空章节");
  });
});

test("re-classifies only after a real change and exposes MCP classification status", async () => {
  await withFixture(async ({ sqlite, call }) => {
    const created = await call("create_memo", { title: "自动归档记录", contentMarkdown: "## 过程\n\n第一版" });
    expect(created.memo.notebookId).toBe("nb_inbox");
    const status = await call("get_inbox_classification", { memoId: created.memo.id });
    expect(status).toMatchObject({ enabled: true, status: "pending", inInbox: true, attempts: 0 });

    sqlite.query("UPDATE inbox_classification_jobs SET status = 'retained', outcome = 'unclear', reason = 'no clear match' WHERE memo_id = ?")
      .run(created.memo.id);
    await call("update_memo", {
      memoId: created.memo.id,
      expectedRevision: created.memo.revision,
      contentMarkdown: created.memo.contentMarkdown,
    });
    expect((await call("get_inbox_classification", { memoId: created.memo.id })))
      .toMatchObject({ status: "retained", outcome: "unclear", reason: "no clear match" });

    const changed = await call("update_memo", {
      memoId: created.memo.id,
      expectedRevision: created.memo.revision,
      sectionOperations: [{ heading: "过程", mode: "append", contentMarkdown: "第二版" }],
    });
    expect(changed.memo.revision).toBeGreaterThan(created.memo.revision);
    expect((await call("get_inbox_classification", { memoId: created.memo.id })))
      .toMatchObject({ status: "pending", inInbox: true, outcome: null });
  });
});

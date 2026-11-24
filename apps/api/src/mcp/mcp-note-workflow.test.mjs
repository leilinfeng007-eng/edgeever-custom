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

test("a normal edit of a note in a real notebook stays there", async () => {
  await withFixture(async ({ sqlite, call }) => {
    const projects = sqlite.query(
      "SELECT id FROM notebooks WHERE workspace_id = ? AND slug = 'work-projects' LIMIT 1",
    ).get(workspaceId).id;
    const created = await call("create_memo", {
      notebookId: projects,
      title: "工作笔记",
      contentMarkdown: "## 背景\n\n原内容\n",
    });
    expect(created.memo.notebookId).toBe(projects);

    const updated = await call("update_memo", {
      memoId: created.memo.id,
      expectedRevision: created.memo.revision,
      sectionOperations: [{ heading: "背景", mode: "append", contentMarkdown: "补充内容" }],
    });
    expect(updated.memo.notebookId).toBe(projects);
    expect(updated.moved).toBe(false);
    expect(updated.classificationQueued).toBe(false);
    expect(updated.placement).toBe("keep");
    expect(updated.action).toBe("section_update");
    expect(sqlite.query("SELECT COUNT(*) AS count FROM inbox_classification_jobs WHERE memo_id = ?")
      .get(created.memo.id).count).toBe(0);

    const readBack = await call("get_memo", { memoId: created.memo.id });
    expect(readBack.memo.notebookId).toBe(projects);
    expect(readBack.memo.contentMarkdown).toContain("原内容\n\n补充内容");
  });
});

test("re-classification moves a note to the inbox even when automatic classification is off", async () => {
  await withFixture(async ({ sqlite, call, env }) => {
    const projects = sqlite.query(
      "SELECT id FROM notebooks WHERE workspace_id = ? AND slug = 'work-projects' LIMIT 1",
    ).get(workspaceId).id;
    const created = await call("create_memo", {
      notebookId: projects, title: "需重新分类", contentMarkdown: "## 记录\n\n内容\n",
    });
    env.EDGE_EVER_AUTO_CLASSIFY = "false";

    const moved = await call("update_memo", {
      memoId: created.memo.id,
      expectedRevision: created.memo.revision,
      autoClassify: true,
      sectionOperations: [{ heading: "记录", mode: "append", contentMarkdown: "更多" }],
    });
    expect(moved.memo.notebookId).toBe("nb_inbox");
    expect(moved.moved).toBe(true);
    expect(moved.placement).toBe("reclassify");
    // 自动分类关闭：移入收件箱，但不排队。
    expect(moved.classificationQueued).toBe(false);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM inbox_classification_jobs WHERE memo_id = ?")
      .get(created.memo.id).count).toBe(0);
  });
});

test("an explicit target notebook wins over a re-classification request", async () => {
  await withFixture(async ({ sqlite, call }) => {
    const learning = sqlite.query(
      "SELECT id FROM notebooks WHERE workspace_id = ? AND slug = 'learning-resources' LIMIT 1",
    ).get(workspaceId).id;
    const created = await call("create_memo", { title: "直接归属", contentMarkdown: "正文" });
    expect(created.memo.notebookId).toBe("nb_inbox");

    const updated = await call("update_memo", {
      memoId: created.memo.id,
      expectedRevision: created.memo.revision,
      notebookId: learning,
      autoClassify: true,
      contentMarkdown: "新正文",
    });
    expect(updated.memo.notebookId).toBe(learning);
    expect(updated.moved).toBe(true);
    expect(updated.placement).toBe("explicit_move");
  });
});

test("a sourced retry keeps a note where it is instead of re-filing it", async () => {
  await withFixture(async ({ sqlite, call }) => {
    const projects = sqlite.query(
      "SELECT id FROM notebooks WHERE workspace_id = ? AND slug = 'work-projects' LIMIT 1",
    ).get(workspaceId).id;
    await call("create_memo", {
      notebookId: projects, title: "同步来源", contentMarkdown: "v1", source: "agent-run", sourceId: "keep-1",
    });
    const repeated = await call("create_memo", {
      title: "同步来源", contentMarkdown: "v2", source: "agent-run", sourceId: "keep-1",
    });
    expect(repeated.updated).toBe(true);
    expect(repeated.memo.notebookId).toBe(projects);
    expect(repeated.moved).toBe(false);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM inbox_classification_jobs WHERE memo_id = ?")
      .get(repeated.memo.id).count).toBe(0);
  });
});

test("a stale revision reports the current revision without writing", async () => {
  await withFixture(async ({ call, notebookId }) => {
    const created = await call("create_memo", {
      notebookId, title: "并发保护", contentMarkdown: "## 记录\n\n第一版\n",
    });
    let failure;
    try {
      await call("update_memo", {
        memoId: created.memo.id,
        expectedRevision: created.memo.revision + 5,
        sectionOperations: [{ heading: "记录", mode: "append", contentMarkdown: "并发写入" }],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure?.code).toBe("revision_conflict");
    expect(failure?.status).toBe(409);
    expect(failure?.details).toMatchObject({
      expectedRevision: created.memo.revision + 5,
      currentRevision: created.memo.revision,
      memoId: created.memo.id,
      notebookId: created.memo.notebookId,
    });
    const readBack = await call("get_memo", { memoId: created.memo.id });
    expect(readBack.memo.contentMarkdown).not.toContain("并发写入");
  });
});

test("a missing or ambiguous section lists the headings instead of rewriting the note", async () => {
  await withFixture(async ({ call, notebookId }) => {
    const created = await call("create_memo", {
      notebookId, title: "章节定位", contentMarkdown: "## 背景\n\nA\n\n## 验证结果\n\nB\n\n## 验证结果\n\nC\n",
    });
    let missing;
    try {
      await call("update_memo", {
        memoId: created.memo.id,
        expectedRevision: created.memo.revision,
        sectionOperations: [{ heading: "结论", mode: "append", contentMarkdown: "x" }],
      });
    } catch (error) {
      missing = error;
    }
    expect(missing?.code).toBe("section_not_found");
    expect(missing?.details?.availableHeadings).toEqual(["背景", "验证结果"]);

    let ambiguous;
    try {
      await call("update_memo", {
        memoId: created.memo.id,
        expectedRevision: created.memo.revision,
        sectionOperations: [{ heading: "验证结果", mode: "append", contentMarkdown: "x" }],
      });
    } catch (error) {
      ambiguous = error;
    }
    expect(ambiguous?.code).toBe("section_ambiguous");
    expect(ambiguous?.details?.matchCount).toBe(2);
    const readBack = await call("get_memo", { memoId: created.memo.id });
    expect(readBack.memo.contentMarkdown).toBe(created.memo.contentMarkdown);
  });
});

test("an idempotency key applies a retried section append once", async () => {
  await withFixture(async ({ call, notebookId }) => {
    const created = await call("create_memo", {
      notebookId, title: "幂等追加", contentMarkdown: "## 验证结果\n\n第一版\n",
    });
    const first = await call("update_memo", {
      memoId: created.memo.id,
      expectedRevision: created.memo.revision,
      idempotencyKey: "append-verify-1",
      sectionOperations: [{ heading: "验证结果", mode: "append", contentMarkdown: "本地通过" }],
    });
    const retried = await call("update_memo", {
      memoId: created.memo.id,
      expectedRevision: first.memo.revision,
      idempotencyKey: "append-verify-1",
      sectionOperations: [{ heading: "验证结果", mode: "append", contentMarkdown: "本地通过" }],
    });
    expect(retried.idempotentReplay).toBe(true);
    expect(retried.changed).toBe(false);
    expect(retried.memo.revision).toBe(first.memo.revision);
    const readBack = await call("get_memo", { memoId: created.memo.id });
    expect(readBack.memo.contentMarkdown.match(/本地通过/g)).toHaveLength(1);

    // 同一段文字、不同 key 是用户有意重复追加。
    const deliberate = await call("update_memo", {
      memoId: created.memo.id,
      expectedRevision: first.memo.revision,
      idempotencyKey: "append-verify-2",
      sectionOperations: [{ heading: "验证结果", mode: "append", contentMarkdown: "本地通过" }],
    });
    expect(deliberate.changed).toBe(true);
    const twice = await call("get_memo", { memoId: created.memo.id });
    expect(twice.memo.contentMarkdown.match(/本地通过/g)).toHaveLength(2);
  });
});

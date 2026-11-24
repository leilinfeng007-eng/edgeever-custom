import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createSelfHostedStorageAdapter } from "../storage/self-hosted-storage-adapter.ts";
import { createMemoRecord, getMemoDetail, updateMemoRecord } from "../notes/memo-service.ts";
import { beginCompanionTurn, checkpointCompanionTurn } from "./companion-service.ts";
import { registerCompanionRoutes } from "./companion-routes.ts";
import { buildAiConversationMarkdown } from "./companion-save-response.ts";

const ANSWER = "## 分批发布\n\n1. 先灰度 10% 流量\n2. 观察 24 小时再全量\n\n参考 https://example.com/release";

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "edgeever-save-note-"));
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    for (const name of readdirSync("migrations").filter((n) => n.endsWith(".sql")).sort()) {
      sqlite.exec(readFileSync(`migrations/${name}`, "utf8"));
    }
    const scope = { workspaceId: "ws_save", ownerId: "save-owner" };
    sqlite.query("INSERT INTO workspaces(id,name) VALUES (?, 'Save')").run(scope.workspaceId);
    for (const [id, slug] of [["inbox", "inbox"], ["projects", null]]) {
      sqlite.query("INSERT INTO notebooks(id,workspace_id,name,slug) VALUES (?,?,?,?)")
        .run(id, scope.workspaceId, id, slug);
    }
    const auth = { ...scope, kind: "user", actorType: "user", actorId: scope.ownerId,
      scopes: [], role: "owner", username: "owner", displayName: null };
    const actor = { actorType: "user", actorId: scope.ownerId };
    const env = { storage: createSelfHostedStorageAdapter(sqlite, dir), EDGE_EVER_RUNTIME: "self-hosted-bun" };
    const context = { env, get: () => auth };
    const db = env.storage.db;
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("auth", auth); await next(); });
    registerCompanionRoutes(app, { isDemoMode: () => false });
    const request = (turnId, body, headers = {}) => app.request(
      `/api/v1/companion/turns/${turnId}/save-note`,
      { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
      env,
    );
    const note = (contentMarkdown, options = {}) => createMemoRecord(db, scope.workspaceId, {
      notebookId: options.notebookId ?? "projects",
      title: options.title ?? "记录",
      contentMarkdown,
      tags: options.tags,
    }, actor, "owner");
    const turn = async (options = {}) => {
      const row = await beginCompanionTurn(db, scope, {
        id: crypto.randomUUID(),
        threadId: crypto.randomUUID(),
        message: options.message ?? "如何安排发布节奏？\n后续再补细节",
        allowNotes: true,
        useMemory: false,
        locale: "zh-CN",
        ...(options.focus ? { focus: options.focus } : {}),
      }, "mock");
      await checkpointCompanionTurn(db, scope, row, options.answer ?? ANSWER, [], "completed");
      return row;
    };
    await run({ sqlite, scope, auth, actor, env, context, db, app, request, note, turn });
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a new note uses the AI conversation template, the object|topic title and the AI tag", () => fixture(async (f) => {
  const bound = await f.note("## 背景\n\n既有背景", { title: "产品发布计划" });
  const turn = await f.turn({ focus: { memoId: bound.id, title: "产品发布计划" } });
  const response = await f.request(turn.id, { action: "create" });
  expect(response.status).toBe(200);
  const { memo, reused } = await response.json();
  expect(reused).toBe(false);
  expect(memo.notebookId).toBe("inbox");
  expect(memo.title).toBe("产品发布计划｜如何安排发布节奏？");
  expect(memo.tags).toContain("AI沉淀");
  // The whole answer stays verbatim under 结论 and the template headings exist.
  expect(memo.contentMarkdown).toBe(buildAiConversationMarkdown({ message: turn.message, response: ANSWER }));
  expect(memo.contentMarkdown).toStartWith("## 结论\n\n## 分批发布\n\n1. 先灰度 10% 流量");
  expect(memo.contentMarkdown).toContain("## 关键步骤 / 依据");
  expect(memo.contentMarkdown).toContain("## 验证结果");
  expect(memo.contentMarkdown).toContain("## 来源 / 链接");
  expect(memo.contentMarkdown).toContain("- 如何安排发布节奏？");
  expect(memo.contentMarkdown).toContain("- https://example.com/release");
  // A newly created note is still auto-filed from the inbox.
  expect(f.sqlite.query("SELECT status FROM inbox_classification_jobs WHERE memo_id=?").get(memo.id).status).toBe("pending");
}));

test("an answer that already uses the template headings keeps its text and only gains sources", () => fixture(async (f) => {
  const answer = "## 结论\n\n已有结论原文\n\n## 验证结果\n\n- 本地已验证 https://example.com/a";
  const turn = await f.turn({ answer });
  const response = await f.request(turn.id, { action: "create" });
  expect(response.status).toBe(200);
  const { memo } = await response.json();
  expect(memo.contentMarkdown).toStartWith("## 结论\n\n已有结论原文");
  expect(memo.contentMarkdown).toContain("- 本地已验证 https://example.com/a");
  // No duplicated template: the untouched headings appear once and sources are added.
  expect(memo.contentMarkdown.match(/## 结论/g)).toHaveLength(1);
  expect(memo.contentMarkdown.match(/## 来源 \/ 链接/g)).toHaveLength(1);
  expect(memo.contentMarkdown).toContain("- https://example.com/a");
}));

test("a same-topic note asks first, then saves separately when the user chooses new", () => fixture(async (f) => {
  const turn = await f.turn();
  // The default 「对象｜主题」title of this answer, already used by a live note.
  const existing = await f.note("旧的发布记录", { title: "AI 对话｜如何安排发布节奏？" });
  const ask = await f.request(turn.id, { action: "create" });
  expect(ask.status).toBe(409);
  const conflict = await ask.json();
  expect(conflict.error.code).toBe("duplicate_match_found");
  expect(conflict.error.details.candidates).toHaveLength(1);
  expect(conflict.error.details.candidates[0]).toMatchObject({
    id: existing.id, title: "AI 对话｜如何安排发布节奏？", notebookId: "projects", reason: "same_title",
  });
  // Nothing was written for the rejected create.
  expect(f.sqlite.query("SELECT COUNT(*) n FROM memos WHERE workspace_id=?").get(f.scope.workspaceId).n).toBe(1);
  const created = await f.request(turn.id, { action: "create", duplicate: "new" });
  expect(created.status).toBe(200);
  const { memo } = await created.json();
  expect(memo.id).not.toBe(existing.id);
  expect(memo.notebookId).toBe("inbox");
  expect((await getMemoDetail(f.db, f.scope.workspaceId, existing.id)).contentMarkdown).toBe("旧的发布记录");
}));

test("identical content alone is reported as a same-content candidate", () => fixture(async (f) => {
  const turn = await f.turn();
  const body = buildAiConversationMarkdown({ message: turn.message, response: ANSWER });
  const existing = await f.note(body, { title: "完全不同的标题" });
  const ask = await f.request(turn.id, { action: "create" });
  expect(ask.status).toBe(409);
  const { error } = await ask.json();
  expect(error.details.candidates[0]).toMatchObject({ id: existing.id, reason: "same_content" });
  // A candidate carries a short body excerpt so a client can show it without reading the note.
  expect(error.details.candidates[0].excerpt).toContain("分批发布");
}));

test("supplementing a section keeps the other sections, the notebook, the tags and resource links", () => fixture(async (f) => {
  const original = [
    "## 背景",
    "",
    "既有背景 ![图](/api/v1/resources/res_keep/blob)",
    "",
    "## 结论",
    "",
    "旧结论",
    "",
  ].join("\n");
  const target = await f.note(original, { title: "发布记录", tags: ["项目"] });
  const turn = await f.turn();
  const payload = {
    action: "create", duplicate: "supplement", memoId: target.id,
    expectedRevision: target.revision, section: { heading: "结论", mode: "append" },
  };
  const response = await f.request(turn.id, payload);
  expect(response.status).toBe(200);
  const { memo } = await response.json();
  expect(memo.id).toBe(target.id);
  expect(memo.notebookId).toBe("projects");
  expect(memo.tags).toContain("项目");
  expect(memo.tags).toContain("AI沉淀");
  expect(memo.revision).toBe(target.revision + 1);
  expect(memo.contentMarkdown).toContain("既有背景 ![图](/api/v1/resources/res_keep/blob)");
  expect(memo.contentMarkdown).toContain("旧结论");
  expect(memo.contentMarkdown).toContain("1. 先灰度 10% 流量");
  expect(memo.contentMarkdown.match(/## 背景/g)).toHaveLength(1);
  expect(memo.contentMarkdown.match(/## 结论/g)).toHaveLength(1);
  // Supplementing an existing note never re-files it.
  expect(f.sqlite.query("SELECT status FROM inbox_classification_jobs WHERE memo_id=?").get(target.id)).toBeNull();
  // A retry of the same intent returns the same result instead of appending twice.
  const retry = await f.request(turn.id, payload);
  expect(retry.status).toBe(200);
  expect((await retry.json()).reused).toBe(true);
  const after = await getMemoDetail(f.db, f.scope.workspaceId, target.id);
  expect(after.revision).toBe(target.revision + 1);
  expect(after.contentMarkdown).toBe(memo.contentMarkdown);
}));

test("replacing a section rewrites only that section", () => fixture(async (f) => {
  const original = ["## 背景", "", "旧背景", "", "## 结论", "", "保留的结论", ""].join("\n");
  const target = await f.note(original, { title: "发布记录" });
  const turn = await f.turn();
  const response = await f.request(turn.id, {
    action: "create", duplicate: "supplement", memoId: target.id, expectedRevision: target.revision,
    section: { heading: "背景", mode: "replace" },
  });
  expect(response.status).toBe(200);
  const { memo } = await response.json();
  expect(memo.contentMarkdown).not.toContain("旧背景");
  expect(memo.contentMarkdown).toContain("## 结论\n\n保留的结论");
  expect(memo.contentMarkdown).toContain("1. 先灰度 10% 流量");
}));

test("section operations never guess: a missing or ambiguous heading is a 409", () => fixture(async (f) => {
  const target = await f.note(["## 背景", "", "背景正文", ""].join("\n"), { title: "发布记录" });
  const ambiguous = await f.note(
    ["## 结论", "", "第一段", "", "## 结论", "", "第二段", ""].join("\n"),
    { title: "重复章节" },
  );
  const turn = await f.turn();
  const missing = await f.request(turn.id, {
    action: "create", duplicate: "supplement", memoId: target.id, expectedRevision: target.revision,
    section: { heading: "结论", mode: "append" },
  });
  expect(missing.status).toBe(409);
  expect((await missing.json()).error.code).toBe("section_not_found");
  const both = await f.request(turn.id, {
    action: "create", duplicate: "supplement", memoId: ambiguous.id, expectedRevision: ambiguous.revision,
    section: { heading: "结论", mode: "append" },
  });
  expect(both.status).toBe(409);
  expect((await both.json()).error.code).toBe("section_ambiguous");
  // Neither note was touched.
  expect((await getMemoDetail(f.db, f.scope.workspaceId, target.id)).contentMarkdown).toBe("## 背景\n\n背景正文\n");
  expect((await getMemoDetail(f.db, f.scope.workspaceId, ambiguous.id)).revision).toBe(ambiguous.revision);
}));

test("a stale revision is rejected before anything is written", () => fixture(async (f) => {
  const target = await f.note("## 结论\n\n旧内容", { title: "发布记录" });
  const turn = await f.turn();
  await updateMemoRecord(f.db, f.scope.workspaceId, target.id, { contentMarkdown: "## 结论\n\n别人改过" }, f.actor, "owner");
  const stale = await f.request(turn.id, {
    action: "create", duplicate: "supplement", memoId: target.id, expectedRevision: target.revision,
    section: { heading: "结论", mode: "append" },
  });
  expect(stale.status).toBe(409);
  expect((await stale.json()).error.code).toBe("companion_action_conflict");
  const current = await getMemoDetail(f.db, f.scope.workspaceId, target.id);
  expect(current.contentMarkdown).toBe("## 结论\n\n别人改过");
  expect(current.revision).toBe(target.revision + 1);
}));

test("a retried create returns the first note instead of a second copy", () => fixture(async (f) => {
  const turn = await f.turn();
  const first = await (await f.request(turn.id, { action: "create" })).json();
  const retry = await f.request(turn.id, { action: "create" });
  expect(retry.status).toBe(200);
  const second = await retry.json();
  expect(second.reused).toBe(true);
  expect(second.memo.id).toBe(first.memo.id);
  expect(f.sqlite.query("SELECT COUNT(*) n FROM memos WHERE workspace_id=?").get(f.scope.workspaceId).n).toBe(1);
  const other = await f.request(turn.id, { action: "create" }, {});
  expect((await other.json()).memo.id).toBe(first.memo.id);
}));

test("a different duplicate choice after a save is treated as a new intent", () => fixture(async (f) => {
  const target = await f.note("## 结论\n\n旧内容", { title: "发布记录" });
  const turn = await f.turn();
  const created = await (await f.request(turn.id, { action: "create", duplicate: "new" })).json();
  const supplemented = await f.request(turn.id, {
    action: "create", duplicate: "supplement", memoId: target.id, expectedRevision: target.revision,
  });
  expect(supplemented.status).toBe(200);
  const { memo } = await supplemented.json();
  expect(memo.id).toBe(target.id);
  expect(memo.id).not.toBe(created.memo.id);
  expect(f.sqlite.query("SELECT COUNT(*) n FROM memos WHERE workspace_id=?").get(f.scope.workspaceId).n).toBe(2);
}));

test("an included section applies to the plain append action too", () => fixture(async (f) => {
  const target = await f.note("## 背景\n\n背景正文\n\n## 结论\n\n旧结论", { title: "发布记录" });
  const turn = await f.turn();
  const response = await f.request(turn.id, {
    action: "append", memoId: target.id, expectedRevision: target.revision,
    section: { heading: "结论", mode: "append" },
  });
  expect(response.status).toBe(200);
  const { memo } = await response.json();
  expect(memo.contentMarkdown).toContain("## 背景\n\n背景正文");
  expect(memo.contentMarkdown).toContain("旧结论");
  expect(memo.contentMarkdown).toContain(ANSWER.split("\n")[0]);
  expect(memo.contentMarkdown).not.toContain("旧结论\n\n---\n\n");
  // The note the user is editing keeps its explicit notebook.
  expect(memo.notebookId).toBe("projects");
}));

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createSelfHostedStorageAdapter } from "../storage/self-hosted-storage-adapter.ts";
import {
  createMemoEditSession,
  createMemoRecord,
  getMemoDetail,
  updateMemoRecord,
} from "./memo-service.ts";
import { registerMemoRoutes } from "./memo-routes.ts";

const NOTE = [
  "## 背景",
  "",
  "既有背景 ![图](/api/v1/resources/res_keep/blob)",
  "",
  "## 结论",
  "",
  "旧结论",
  "",
  "## 附录",
  "",
  "| 列 | 值 |",
  "| --- | --- |",
  "| a | 1 |",
  "",
].join("\n");

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "edgeever-sections-"));
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    for (const name of readdirSync("migrations").filter((n) => n.endsWith(".sql")).sort()) {
      sqlite.exec(readFileSync(`migrations/${name}`, "utf8"));
    }
    const workspaceId = "ws_sections";
    sqlite.query("INSERT INTO workspaces(id,name) VALUES (?, 'Sections')").run(workspaceId);
    for (const [id, slug] of [["inbox", "inbox"], ["projects", null]]) {
      sqlite.query("INSERT INTO notebooks(id,workspace_id,name,slug) VALUES (?,?,?,?)")
        .run(id, workspaceId, id, slug);
    }
    const auth = { kind: "user", actorType: "user", actorId: "usr_sections", username: "owner",
      displayName: null, scopes: ["read:memos", "write:memos"], workspaceId, role: "owner" };
    const actor = { actorType: "user", actorId: auth.actorId };
    const env = { storage: createSelfHostedStorageAdapter(sqlite, dir), EDGE_EVER_RUNTIME: "self-hosted-bun" };
    const db = env.storage.db;
    const context = { env, get: () => auth };
    const unused = async () => { throw new Error("not used by this test"); };
    const app = new Hono();
    app.use("/api/v1/*", async (c, next) => { c.set("auth", auth); await next(); });
    registerMemoRoutes(app, {
      clampNumber: (value, min, max) => Math.min(Math.max(value, min), max),
      createImageResource: unused,
      createMemo: (...args) => createMemoRecord(...args),
      createMemoEditSession: (...args) => createMemoEditSession(...args),
      deleteMemo: unused,
      deleteMemos: unused,
      emptyTrash: unused,
      getMemoDetail: (...args) => getMemoDetail(...args),
      listMemos: unused,
      listMemoRevisions: async () => [],
      duplicateMemo: unused,
      mergeMemos: unused,
      moveMemos: unused,
      restoreMemo: unused,
      restoreMemoRevision: unused,
      updateMemo: (...args) => updateMemoRecord(...args),
    });
    const note = (contentMarkdown, options = {}) => createMemoRecord(db, workspaceId, {
      notebookId: options.notebookId ?? "projects",
      title: options.title ?? "发布记录",
      contentMarkdown,
    }, actor, "owner");
    // A section edit still needs the bound edit session that every content save requires.
    const session = async (memoId) => createMemoEditSession(context, memoId);
    const patch = async (memoId, body) => {
      const current = await getMemoDetail(db, workspaceId, memoId);
      const edit = await session(memoId);
      return app.request(`/api/v1/memos/${memoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: current.revision,
          expectedContentHash: current.contentHash,
          editSessionId: edit.id,
          ...body,
        }),
      }, env);
    };
    await run({ sqlite, db, workspaceId, auth, actor, env, app, note, patch });
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a section operation appends to one section and keeps everything else", () => fixture(async (f) => {
  const memo = await f.note(NOTE);
  const response = await f.patch(memo.id, {
    sectionOperations: [{ heading: "结论", mode: "append", contentMarkdown: "补充的结论 https://example.com/source" }],
  });
  expect(response.status).toBe(200);
  const { memo: updated } = await response.json();
  expect(updated.revision).toBe(memo.revision + 1);
  expect(updated.contentMarkdown).toContain("旧结论\n\n补充的结论 https://example.com/source");
  expect(updated.contentMarkdown).toContain("既有背景 ![图](/api/v1/resources/res_keep/blob)");
  expect(updated.contentMarkdown).toContain("| a | 1 |");
  expect(updated.contentMarkdown).toContain("## 背景");
  expect(updated.contentMarkdown).toContain("## 附录");
  expect(updated.contentMarkdown.match(/## 结论/g)).toHaveLength(1);
}));

test("a section operation replaces only the addressed section", () => fixture(async (f) => {
  const memo = await f.note(NOTE);
  const response = await f.patch(memo.id, {
    sectionOperations: [{ heading: "背景", mode: "replace", contentMarkdown: "新的背景" }],
  });
  expect(response.status).toBe(200);
  const { memo: updated } = await response.json();
  expect(updated.contentMarkdown).toContain("## 背景\n\n新的背景");
  expect(updated.contentMarkdown).not.toContain("既有背景");
  expect(updated.contentMarkdown).toContain("旧结论");
  // The note-level edit still reaches the save route with the same body.
  const save = await f.app.request(`/api/v1/memos/${memo.id}/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: updated.revision,
      expectedContentHash: updated.contentHash,
      editSessionId: (await createMemoEditSession({ env: f.env, get: () => f.auth }, memo.id)).id,
      sectionOperations: [{ heading: "结论", mode: "append", contentMarkdown: "第二次补充" }],
    }),
  }, f.env);
  expect(save.status).toBe(200);
  expect((await save.json()).memo.contentMarkdown).toContain("旧结论\n\n第二次补充");
}));

test("a body replacement and a section operation are mutually exclusive", () => fixture(async (f) => {
  const memo = await f.note(NOTE);
  const response = await f.patch(memo.id, {
    contentMarkdown: "整体替换",
    sectionOperations: [{ heading: "结论", mode: "append", contentMarkdown: "x" }],
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_params");
  expect((await getMemoDetail(f.db, f.workspaceId, memo.id)).contentMarkdown).toBe(NOTE);
}));

test("a missing or ambiguous heading is a conflict and never a guess", () => fixture(async (f) => {
  const memo = await f.note(NOTE);
  const ambiguousNote = await f.note("## 结论\n\n一\n\n## 结论\n\n二\n", { title: "重复章节" });
  const missing = await f.patch(memo.id, {
    sectionOperations: [{ heading: "不存在", mode: "append", contentMarkdown: "x" }],
  });
  expect(missing.status).toBe(409);
  expect((await missing.json()).error.code).toBe("section_not_found");
  const ambiguous = await f.patch(ambiguousNote.id, {
    sectionOperations: [{ heading: "结论", mode: "append", contentMarkdown: "x" }],
  });
  expect(ambiguous.status).toBe(409);
  expect((await ambiguous.json()).error.code).toBe("section_ambiguous");
  expect((await getMemoDetail(f.db, f.workspaceId, memo.id)).contentMarkdown).toBe(NOTE);
  expect((await getMemoDetail(f.db, f.workspaceId, ambiguousNote.id)).contentMarkdown)
    .toBe("## 结论\n\n一\n\n## 结论\n\n二\n");
}));

test("a stale revision still blocks a section edit", () => fixture(async (f) => {
  const memo = await f.note(NOTE);
  const edit = await createMemoEditSession({ env: f.env, get: () => f.auth }, memo.id);
  await updateMemoRecord(f.db, f.workspaceId, memo.id, { contentMarkdown: "## 结论\n\n别人改过" }, f.actor, "owner");
  const response = await f.app.request(`/api/v1/memos/${memo.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: memo.revision,
      expectedContentHash: memo.contentHash,
      editSessionId: edit.id,
      sectionOperations: [{ heading: "结论", mode: "append", contentMarkdown: "x" }],
    }),
  }, f.env);
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("revision_conflict");
  expect((await getMemoDetail(f.db, f.workspaceId, memo.id)).contentMarkdown).toBe("## 结论\n\n别人改过");
}));

test("a section edit still equals the stored body when nothing changes", () => fixture(async (f) => {
  const memo = await f.note(NOTE);
  const response = await f.patch(memo.id, {
    sectionOperations: [{ heading: "结论", mode: "append", contentMarkdown: "" }],
  });
  // An empty append leaves the note as it was; the merge must stay idempotent.
  expect(response.status).toBe(200);
  const { memo: updated } = await response.json();
  expect(updated.revision).toBe(memo.revision);
  expect(updated.contentMarkdown).toBe(memo.contentMarkdown);
}));

test("a section edit of an inbox note is re-filed while a manual move keeps its destination", () => fixture(async (f) => {
  const memo = await f.note(NOTE, { notebookId: "inbox" });
  const edited = await f.patch(memo.id, {
    sectionOperations: [{ heading: "结论", mode: "append", contentMarkdown: "补充" }],
  });
  expect(edited.status).toBe(200);
  expect(f.sqlite.query("SELECT status FROM inbox_classification_jobs WHERE memo_id = ?").get(memo.id))
    .toMatchObject({ status: "pending" });
  // A section edit sent together with an explicit notebook is a manual move, so
  // the user's destination wins and the queue settles instead of guessing.
  f.sqlite.exec("UPDATE inbox_classification_jobs SET status = 'pending'");
  const moved = await f.patch(memo.id, {
    notebookId: "projects",
    sectionOperations: [{ heading: "结论", mode: "append", contentMarkdown: "又一次" }],
  });
  expect(moved.status).toBe(200);
  expect((await moved.json()).memo.notebookId).toBe("projects");
  expect(f.sqlite.query("SELECT status FROM inbox_classification_jobs WHERE memo_id = ?").get(memo.id).status)
    .not.toBe("pending");
}));

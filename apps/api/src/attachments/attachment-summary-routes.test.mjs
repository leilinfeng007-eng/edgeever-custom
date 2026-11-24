import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerAttachmentSummaryRoutes } from "./attachment-summary-routes.ts";

const agentAuth = {
  kind: "agent",
  actorType: "agent",
  actorId: "token_1",
  username: "automation",
  displayName: null,
  scopes: ["read:memos", "write:memos"],
  workspaceId: "ws_1",
  role: "member",
};

const pdfResource = {
  id: "res_pdf",
  memoId: "memo_1",
  originalMemoId: null,
  kind: "attachment",
  mimeType: "application/pdf",
  filename: "report.pdf",
  byteSize: 128,
  sha256: "hash",
  width: null,
  height: null,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  url: "/api/v1/resources/res_pdf/blob",
  source: { filename: "report.pdf", page: 2 },
};

const createMemo = (overrides = {}) => ({
  id: "memo_1",
  revision: 4,
  contentHash: "content-hash",
  contentJson: {
    type: "doc",
    content: [{
      type: "paragraph",
      content: [{
        type: "edgeeverPdfAttachment",
        attrs: { url: "/api/v1/resources/res_pdf/blob", label: "附件：report.pdf", filename: "report.pdf", source: "" },
      }],
    }],
  },
  contentMarkdown: "正文",
  ...overrides,
});

const createApp = (overrides = {}) => {
  const app = new Hono();
  app.onError((error, context) => context.json({ error: { message: error.message } }, 500));
  app.use("/api/v1/*", async (context, next) => {
    context.set("auth", agentAuth);
    await next();
  });
  const calls = { updates: [] };
  registerAttachmentSummaryRoutes(app, {
    getMemoDetail: async () => createMemo(),
    listResourcesForMemo: async () => [pdfResource],
    updateMemoRecord: async (_db, _workspaceId, memoId, input) => {
      calls.updates.push(input);
      return { memo: createMemo({ revision: 5, contentMarkdown: input.contentMarkdown }) };
    },
    ...overrides,
  });
  return { app, calls };
};

const post = (app, body) => app.request(
  "/api/v1/memos/memo_1/attachment-summary",
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  { storage: { db: {} } },
);

describe("attachment summary route", () => {
  test("appends the summary and writes it back with the CAS baseline", async () => {
    const { app, calls } = createApp();
    const response = await post(app, { expectedRevision: 4, expectedContentHash: "content-hash" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, changed: true, memo: { revision: 5 } });
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]).toMatchObject({ expectedRevision: 4, expectedContentHash: "content-hash" });
    expect(calls.updates[0].contentMarkdown).toBe(
      "正文\n\n## 附件汇总\n\n- [report.pdf](/api/v1/resources/res_pdf/blob?edgeever_summary=1) · P.2",
    );
  });

  test("is idempotent: an already up-to-date section is not rewritten", async () => {
    const { app, calls } = createApp({
      getMemoDetail: async () => createMemo({
        contentMarkdown: "正文\n\n## 附件汇总\n\n- [report.pdf](/api/v1/resources/res_pdf/blob?edgeever_summary=1) · P.2",
      }),
    });
    const response = await post(app, { expectedRevision: 4 });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, changed: false });
    expect(calls.updates).toHaveLength(0);
  });

  test("rewrites an old card-style summary once and keeps only one plain line", async () => {
    const oldFormat = "正文\n\n## 附件汇总\n\n- [附件：report.pdf](/api/v1/resources/res_pdf/blob) — report.pdf · P.2";
    const { app, calls } = createApp({
      getMemoDetail: async () => createMemo({ contentMarkdown: oldFormat }),
    });
    const response = await post(app, { expectedRevision: 4 });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, changed: true });
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].contentMarkdown).toBe(
      "正文\n\n## 附件汇总\n\n- [report.pdf](/api/v1/resources/res_pdf/blob?edgeever_summary=1) · P.2",
    );
  });

  test("reports 409 when the note moved on", async () => {
    const { app } = createApp();
    const stale = await post(app, { expectedRevision: 3 });
    expect(stale.status).toBe(409);

    const hashMiss = await post(app, { expectedRevision: 4, expectedContentHash: "other-hash" });
    expect(hashMiss.status).toBe(409);
  });

  test("leaves the note alone when there is nothing to summarize", async () => {
    const { app, calls } = createApp({
      getMemoDetail: async () => createMemo({ contentJson: { type: "doc", content: [] } }),
      listResourcesForMemo: async () => [],
    });
    const response = await post(app, { expectedRevision: 4 });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 0, changed: false });
    expect(calls.updates).toHaveLength(0);
  });

  test("requires an explicit revision and a write scope", async () => {
    const { app } = createApp();
    expect((await post(app, {})).status).toBe(400);

    const readOnly = new Hono();
    readOnly.use("/api/v1/*", async (context, next) => {
      context.set("auth", { ...agentAuth, scopes: ["read:memos"] });
      await next();
    });
    registerAttachmentSummaryRoutes(readOnly, {
      getMemoDetail: async () => createMemo(),
      listResourcesForMemo: async () => [pdfResource],
      updateMemoRecord: async () => ({ memo: createMemo() }),
    });
    expect((await post(readOnly, { expectedRevision: 4 })).status).toBe(403);
  });

  test("maps a service conflict to 409 instead of 500", async () => {
    const { app } = createApp({
      updateMemoRecord: async () => ({ error: "revision_conflict", message: "conflict", status: 409 }),
    });
    const response = await post(app, { expectedRevision: 4 });
    expect(response.status).toBe(409);
  });
});

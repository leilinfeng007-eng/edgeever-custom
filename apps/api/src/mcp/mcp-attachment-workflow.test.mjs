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
  actorId: "attachment-test-token",
  username: "attachment-agent",
  displayName: null,
  workspaceId,
  scopes: ["read:memos", "write:memos", "read:resources", "write:resources"],
  role: "owner",
};

const PDF_BASE64 = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");

async function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "edgeever-mcp-attachment-"));
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
    const context = { env, req: { url: "http://localhost/mcp" }, get: () => auth };
    const call = (name, args) => executeWorkspaceTool(context, auth, name, args);
    const notebookId = slug => sqlite.query(
      "SELECT id FROM notebooks WHERE workspace_id = ? AND slug = ? LIMIT 1",
    ).get(workspaceId, slug).id;
    await run({ sqlite, env, call, notebookId });
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("an attachment can be uploaded, inserted into a section and given a source", async () => {
  await withFixture(async ({ call, notebookId }) => {
    const projects = notebookId("work-projects");
    const memo = await call("create_memo", {
      notebookId: projects,
      title: "附件流程",
      contentMarkdown: "## 方法\n\n正文\n\n## 结论\n\n结果\n",
    });
    const uploaded = await call("upload_memo_attachment", {
      memoId: memo.memo.id,
      filename: "spec.pdf",
      mimeType: "application/pdf",
      dataBase64: PDF_BASE64,
      source: { page: 2, pageEnd: 4, chapter: "方法" },
    });
    const resourceId = uploaded.resource.id;
    expect(uploaded.resource.source).toMatchObject({ page: 2, pageEnd: 4, chapter: "方法" });

    const inserted = await call("insert_memo_resource", {
      memoId: memo.memo.id,
      resourceId,
      anchor: { section: "方法", position: "end" },
    });
    expect(inserted.changed).toBe(true);
    expect(inserted.memo.contentMarkdown).toContain("## 方法");
    expect(inserted.memo.contentMarkdown).toContain("spec.pdf");
    expect(inserted.memo.contentMarkdown.indexOf("spec.pdf"))
      .toBeLessThan(inserted.memo.contentMarkdown.indexOf("## 结论"));
    expect(inserted.action).toBe("insert_resource");

    const sourced = await call("set_attachment_source", {
      memoId: memo.memo.id,
      resourceId,
      source: { page: 5, chapter: "新方法" },
    });
    expect(sourced.resource.source).toMatchObject({ page: 5, chapter: "新方法" });
    expect(sourced.changed).toBe(true);

    const readBack = await call("list_memo_resources", { memoId: memo.memo.id });
    expect(readBack.resources.find(resource => resource.id === resourceId).source)
      .toMatchObject({ page: 5, chapter: "新方法" });
  });
});

test("inserting at a missing or ambiguous anchor keeps the note unchanged", async () => {
  await withFixture(async ({ call, notebookId }) => {
    const projects = notebookId("work-projects");
    const memo = await call("create_memo", {
      notebookId: projects,
      title: "锚点定位",
      contentMarkdown: "## 背景\n\n正文\n\n## 记录\n\nA\n\n## 记录\n\nB\n",
    });
    const uploaded = await call("upload_memo_attachment", {
      memoId: memo.memo.id, filename: "note.txt", mimeType: "text/plain",
      dataBase64: Buffer.from("hello").toString("base64"),
    });

    await expect(call("insert_memo_resource", {
      memoId: memo.memo.id, resourceId: uploaded.resource.id, anchor: { section: "缺少" },
    })).rejects.toMatchObject({ code: "section_not_found", details: { availableHeadings: ["背景", "记录"] } });

    await expect(call("insert_memo_resource", {
      memoId: memo.memo.id, resourceId: uploaded.resource.id, anchor: { section: "记录" },
    })).rejects.toMatchObject({ code: "section_ambiguous", details: { matchCount: 2 } });

    await expect(call("insert_memo_resource", {
      memoId: memo.memo.id, resourceId: uploaded.resource.id, anchor: { afterText: "不存在的锚点" },
    })).rejects.toMatchObject({ code: "anchor_not_found" });

    const readBack = await call("get_memo", { memoId: memo.memo.id });
    expect(readBack.memo.contentMarkdown).toBe(memo.memo.contentMarkdown);
    expect(readBack.memo.revision).toBe(memo.memo.revision);
  });
});

test("an attachment source updates and the summary keeps one link with the latest source", async () => {
  await withFixture(async ({ call, notebookId }) => {
    const projects = notebookId("work-projects");
    const memo = await call("create_memo", {
      notebookId: projects,
      title: "汇总连续更新",
      contentMarkdown: "## 依据\n\n正文\n",
    });
    const first = await call("upload_memo_attachment", {
      memoId: memo.memo.id, filename: "a.pdf", mimeType: "application/pdf", dataBase64: PDF_BASE64,
      source: { page: 1, chapter: "第一节" },
    });
    const second = await call("upload_memo_attachment", {
      memoId: memo.memo.id, filename: "b.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      dataBase64: Buffer.from("docx-bytes").toString("base64"),
      source: { sheet: "Sheet1", range: "A1:C9" },
    });
    await call("insert_memo_resource", {
      memoId: memo.memo.id, resourceId: first.resource.id, anchor: { section: "依据", position: "end" },
    });
    await call("insert_memo_resource", {
      memoId: memo.memo.id, resourceId: second.resource.id, anchor: { section: "依据", position: "end" },
    });

    const current = await call("get_memo", { memoId: memo.memo.id });
    const summarized = await call("update_attachment_summary", {
      memoId: memo.memo.id, expectedRevision: current.memo.revision,
    });
    expect(summarized.total).toBe(2);
    expect(summarized.changed).toBe(true);
    expect(summarized.memo.contentMarkdown.match(/## 附件汇总/g)).toHaveLength(1);
    expect(summarized.memo.contentMarkdown).toContain("edgeever_summary=1");
    expect(summarized.memo.contentMarkdown).toContain("P.1 · 章节：第一节");
    expect(summarized.memo.contentMarkdown).toContain("工作表：Sheet1 · 范围：A1:C9");
    // 正文里的附件卡片仍在。
    expect(summarized.memo.contentMarkdown).toContain("a.pdf");
    expect(summarized.memo.contentMarkdown).toContain("b.docx");
    const firstRevision = summarized.memo.revision;

    const repeated = await call("update_attachment_summary", {
      memoId: memo.memo.id, expectedRevision: firstRevision,
    });
    expect(repeated.changed).toBe(false);
    expect(repeated.memo.revision).toBe(firstRevision);

    const sourced = await call("set_attachment_source", {
      memoId: memo.memo.id, resourceId: first.resource.id, source: { page: 2, pageEnd: 3, chapter: "新来源" },
    });
    expect(sourced.resource.source).toMatchObject({ page: 2, pageEnd: 3, chapter: "新来源" });

    const afterSource = await call("get_memo", { memoId: memo.memo.id });
    const updated = await call("update_attachment_summary", {
      memoId: memo.memo.id, expectedRevision: afterSource.memo.revision,
    });
    expect(updated.changed).toBe(true);
    expect(updated.memo.contentMarkdown).toContain("P.2-3 · 章节：新来源");
    // 正文卡片保留一条，汇总行一条；同一附件不会在汇总里重复。
    const summarySection = updated.memo.contentMarkdown.split("## 附件汇总")[1];
    expect(summarySection.match(/a\.pdf\]\(/g)).toHaveLength(1);
    expect(summarySection.match(/b\.docx\]\(/g)).toHaveLength(1);
    expect(updated.memo.contentMarkdown.match(/## 附件汇总/g)).toHaveLength(1);
  });
});

test("the summary keeps attachment cards in the body and refreshes a legacy summary once", async () => {
  await withFixture(async ({ call, notebookId, sqlite }) => {
    const projects = notebookId("work-projects");
    const memo = await call("create_memo", {
      notebookId: projects,
      title: "旧汇总格式",
      contentMarkdown: "## 依据\n\n正文\n\n## 附件汇总\n\n- 旧格式清单\n",
    });
    const uploaded = await call("upload_memo_attachment", {
      memoId: memo.memo.id, filename: "legacy.txt", mimeType: "text/plain",
      dataBase64: Buffer.from("legacy").toString("base64"),
      source: { note: "旧来源" },
    });
    await call("insert_memo_resource", {
      memoId: memo.memo.id, resourceId: uploaded.resource.id, anchor: { section: "依据", position: "end" },
    });
    const current = await call("get_memo", { memoId: memo.memo.id });
    const summarized = await call("update_attachment_summary", {
      memoId: memo.memo.id, expectedRevision: current.memo.revision,
    });
    expect(summarized.memo.contentMarkdown).not.toContain("旧格式清单");
    expect(summarized.memo.contentMarkdown.match(/## 附件汇总/g)).toHaveLength(1);
    expect(summarized.memo.contentMarkdown).toContain("说明：旧来源");
    expect(sqlite.query("SELECT metadata_json FROM resources WHERE memo_id = ?").get(memo.memo.id))
      .toMatchObject({ metadata_json: expect.stringContaining("origin") });
  });
});

test("a stale revision blocks the summary write and clears source with null", async () => {
  await withFixture(async ({ call, notebookId }) => {
    const projects = notebookId("work-projects");
    const memo = await call("create_memo", {
      notebookId: projects, title: "汇总并发", contentMarkdown: "## 依据\n\n正文\n",
    });
    const uploaded = await call("upload_memo_attachment", {
      memoId: memo.memo.id, filename: "c.txt", mimeType: "text/plain",
      dataBase64: Buffer.from("c").toString("base64"),
      source: { page: 1 },
    });
    await call("insert_memo_resource", {
      memoId: memo.memo.id, resourceId: uploaded.resource.id, anchor: { section: "依据", position: "end" },
    });

    await expect(call("update_attachment_summary", {
      memoId: memo.memo.id, expectedRevision: 0,
    })).rejects.toMatchObject({ code: "revision_conflict", details: { currentRevision: expect.any(Number) } });

    const cleared = await call("set_attachment_source", {
      memoId: memo.memo.id, resourceId: uploaded.resource.id, source: null,
    });
    expect(cleared.resource.source).toBeNull();

    await expect(call("set_attachment_source", {
      memoId: memo.memo.id, resourceId: uploaded.resource.id, source: { page: 0 },
    })).rejects.toMatchObject({ code: "invalid_attachment_source" });
  });
});

test("a staged resource keeps its source when bound to a new note", async () => {
  await withFixture(async ({ call, notebookId }) => {
    const projects = notebookId("work-projects");
    const staged = await call("stage_memo_resource", {
      kind: "attachment",
      filename: "staged.pdf",
      mimeType: "application/pdf",
      dataBase64: PDF_BASE64,
      label: "staged.pdf",
      source: { page: 7, chapter: "附录" },
    });
    const memo = await call("create_memo", {
      notebookId: projects,
      title: "暂存绑定",
      contentMarkdown: `## 参考\n\n${staged.markdownLink}\n`,
      resourceIds: [staged.resourceId],
      requireResourcePlacement: true,
    });
    const resources = await call("list_memo_resources", { memoId: memo.memo.id });
    expect(resources.resources.find(resource => resource.id === staged.resourceId).source)
      .toMatchObject({ page: 7, chapter: "附录" });
  });
});

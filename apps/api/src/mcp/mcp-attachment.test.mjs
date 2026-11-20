import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { DEMO_ATTACHMENT_RESOURCES } from "../workspace/demo-attachments.ts";
import { sha256 } from "../common/hash-utils.ts";
import { fetchEdgeEverApp } from "../index.ts";
import { createSelfHostedStorageAdapter } from "../storage/self-hosted-storage-adapter.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const WORD = DEMO_ATTACHMENT_RESOURCES.find((resource) => resource.filename.endsWith(".docx"));
const PDF = DEMO_ATTACHMENT_RESOURCES.find((resource) => resource.filename.endsWith(".pdf"));
const scopes = ["read:memos", "write:memos", "read:resources", "write:resources"];
const executionContext = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const wordFile = (xml) => Buffer.from(zipSync({ "word/document.xml": strToU8(xml) })).toString("base64");
const wordXml = (body) => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;

async function withInstance(run) {
  const dir = await mkdtemp(join(tmpdir(), "edgeever-mcp-attachment-"));
  const sqlite = new Database(join(dir, "edgeever.sqlite"), { create: true });
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    const migrations = new URL("../../../../migrations/", import.meta.url);
    for (const migration of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
      sqlite.exec(await readFile(new URL(migration, migrations), "utf8"));
    }
    sqlite.exec(`INSERT INTO workspaces(id, name) VALUES ('ws_attachment_other', 'Other');
      INSERT INTO notebooks(id, workspace_id, name) VALUES ('nb_attachment_test', 'ws_default', 'Attachments');`);
    for (const [token, workspace, permissions] of [
      ["fixture-primary", "ws_default", scopes],
      ["fixture-no-resource", "ws_default", ["read:memos"]],
      ["fixture-no-memo", "ws_default", ["read:resources"]],
      ["fixture-other", "ws_attachment_other", scopes],
    ]) {
      sqlite.query("INSERT INTO api_tokens (id, workspace_id, name, token_hash, scopes_json) VALUES (?, ?, ?, ?, ?)")
        .run(token, workspace, token, await sha256(token), JSON.stringify(permissions));
    }
    const storage = createSelfHostedStorageAdapter(sqlite, join(dir, "resources"));
    const env = { storage, EDGE_EVER_AUTH_PASSWORD: "test-only", EDGE_EVER_RUNTIME: "self-hosted-bun" };
    let id = 0;
    const rpc = async (method, params, token = "fixture-primary") => {
      const response = await fetchEdgeEverApp(new Request("http://notes.example/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      }), env, executionContext);
      expect(response.status).toBe(200);
      const envelope = await response.json();
      expect(envelope.error).toBeUndefined();
      return envelope.result;
    };
    const tool = (name, args, token) => rpc("tools/call", { name, arguments: args }, token);
    const ok = async (name, args) => {
      const result = await tool(name, args);
      expect(result.isError).toBe(false);
      return result;
    };
    const create = async (title = "附件验收") => (await ok("create_memo", {
      title, notebookId: "nb_attachment_test", contentMarkdown: `笔记正文不包含附件内容：${title}`,
    })).structuredContent.memo.id;
    const upload = async (memoId, filename, mimeType, dataBase64, image = false) =>
      (await ok(image ? "upload_memo_image" : "upload_memo_attachment", {
        memoId, filename, mimeType, dataBase64,
      })).structuredContent.resource;
    const httpContent = (memoId, resourceId, offset = 0, token = "fixture-primary") =>
      fetchEdgeEverApp(new Request(`http://notes.example/api/v1/attachment-content/${memoId}/${resourceId}?offset=${offset}`, {
        headers: { Authorization: `Bearer ${token}` },
      }), env, executionContext);
    await run({ create, upload, ok, tool, rpc, sqlite, httpContent });
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("MCP returns attached original images, Word text, and original documents in different content blocks", async () => {
  await withInstance(async ({ create, upload, ok, rpc, httpContent }) => {
    const memoId = await create();
    const found = await ok("search_memos", { query: "附件验收" });
    expect(found.structuredContent.memos.map(memo => memo.id)).toContain(memoId);
    const catalog = await rpc("tools/list", {});
    expect(catalog.tools.find(({ name }) => name === "read_memo_attachment").annotations.readOnlyHint).toBe(true);
    const png = await upload(memoId, "原图.png", "image/png", PNG, true);
    const word = await upload(memoId, WORD.filename, WORD.mimeType, WORD.content);
    const pdf = await upload(memoId, PDF.filename, PDF.mimeType, PDF.content);
    const listed = (await ok("list_memo_resources", { memoId })).structuredContent.resources;
    expect(listed.map(({ id }) => id).sort()).toEqual([png.id, word.id, pdf.id].sort());

    const image = await ok("read_memo_attachment", { memoId, resourceId: png.id });
    expect(image.structuredContent).toMatchObject({ format: "image", attachment: { filename: "原图.png" } });
    expect(image.structuredContent.contentBlock).toBeUndefined();
    expect(image.content[1]).toEqual({ type: "image", mimeType: "image/png", data: PNG });
    expect(image.content[0].text).not.toContain(PNG);

    const text = await ok("read_memo_attachment", { memoId, resourceId: word.id });
    expect(text.structuredContent).toMatchObject({ format: "text", nextOffset: null });
    expect(text.content[1].type).toBe("text");
    expect(text.content[1].text).toContain("EdgeEver");
    expect(text.content[1].text.length).toBeGreaterThan(25);
    expect(text.structuredContent.text).toBe(text.content[1].text);
    const httpWord = await httpContent(memoId, word.id);
    expect(httpWord.status).toBe(200);
    expect(httpWord.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await httpWord.json()).toEqual({
      text: text.structuredContent.text,
      nextOffset: null,
      totalCharacters: text.structuredContent.totalCharacters,
    });
    expect((await httpContent(memoId, png.id)).status).toBe(422);
    expect((await httpContent(memoId, word.id, 0, "fixture-no-resource")).status).toBe(403);
    const tail = await httpContent(memoId, word.id, 4);
    expect(await tail.json()).toEqual({
      text: text.structuredContent.text.slice(4),
      nextOffset: null,
      totalCharacters: text.structuredContent.totalCharacters,
    });

    const nominal = await ok("read_memo_attachment", { memoId, resourceId: pdf.id });
    expect(nominal.structuredContent).toMatchObject({
      format: "text", nextOffset: null, pageStart: 1, pageEnd: 1, pageCount: 1,
    });
    expect(nominal.content[1]).toEqual({ type: "text", text: "EdgeEver demo PDF" });
    const httpPdf = await httpContent(memoId, pdf.id);
    expect(await httpPdf.json()).toEqual({
      text: "EdgeEver demo PDF", nextOffset: null, totalCharacters: 17, pageStart: 1, pageEnd: 1, pageCount: 1,
    });
    const original = await ok("read_memo_attachment", { memoId, resourceId: pdf.id, mode: "original" });
    expect(original.content[1]).toEqual({ type: "resource", resource: {
      uri: `edgeever://attachment/${pdf.id}`, mimeType: "application/pdf", blob: PDF.content,
    } });
    expect(original.content[0].text).not.toContain(PDF.content);
    const wordOriginal = await ok("read_memo_attachment", { memoId, resourceId: word.id, mode: "original" });
    expect(wordOriginal.content[1].resource.blob).toBe(WORD.content);
  });
});

test("MCP checks both scopes, exact parent memo, workspace, and deletion state", async () => {
  await withInstance(async ({ create, upload, tool, ok, sqlite }) => {
    const memoId = await create();
    const otherMemoId = await create("另一个笔记");
    const png = await upload(memoId, "pixel.png", "image/png", PNG, true);
    const args = { memoId, resourceId: png.id };
    for (const token of ["fixture-no-resource", "fixture-no-memo"]) {
      const result = await tool("read_memo_attachment", args, token);
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("forbidden");
    }
    for (const [payload, token] of [[args, "fixture-other"], [{ ...args, memoId: otherMemoId }, undefined]]) {
      const result = await tool("read_memo_attachment", payload, token);
      expect(result.structuredContent.error.code).toBe("attachment_not_found");
      expect(result.content).toHaveLength(1);
    }
    sqlite.query("UPDATE resources SET is_deleted = 1 WHERE id = ?").run(png.id);
    expect((await tool("read_memo_attachment", args)).structuredContent.error.code).toBe("attachment_not_found");
    sqlite.query("UPDATE resources SET is_deleted = 0 WHERE id = ?").run(png.id);
    await ok("trash_memos", { memoIds: [memoId] });
    expect((await tool("read_memo_attachment", args)).structuredContent.error.code).toBe("attachment_not_found");
  });
});

test("MCP pages extracted text without breaking Unicode and rejects invalid or oversized documents", async () => {
  await withInstance(async ({ create, upload, tool, ok, sqlite }) => {
    const memoId = await create();
    const first = "甲".repeat(11_999) + "😀";
    const structuredWord = wordFile(wordXml(`<w:p><w:r><w:t>${first}</w:t><w:tab/><w:t>乙 &amp; 丙</w:t></w:r></w:p><w:p><w:r><w:t>最后一段。</w:t></w:r></w:p>`));
    const valid = await upload(memoId, "part.docx", WORD.mimeType, structuredWord);
    const args = { memoId, resourceId: valid.id };
    const page = await ok("read_memo_attachment", args);
    expect(page.structuredContent.nextOffset).toBe(11_999);
    expect(page.content[1].text).toBe(first.slice(0, -2));
    const tail = await ok("read_memo_attachment", { ...args, offset: page.structuredContent.nextOffset });
    expect(tail.content[1].text).toBe("😀\t乙 & 丙\n最后一段。");
    expect(tail.structuredContent.nextOffset).toBeNull();

    const invalid = await upload(memoId, "bad.docx", WORD.mimeType, Buffer.from("broken archive").toString("base64"));
    expect((await tool("read_memo_attachment", { memoId, resourceId: invalid.id })).structuredContent.error.code).toBe("attachment_invalid_docx");
    const oversized = await upload(memoId, "large.docx", WORD.mimeType,
      wordFile(wordXml(`<w:p><w:r><w:t>${"a".repeat(2 * 1024 * 1024)}</w:t></w:r></w:p>`)));
    expect((await tool("read_memo_attachment", { memoId, resourceId: oversized.id })).structuredContent.error.code).toBe("attachment_too_large");
    const textFile = await upload(memoId, "数据.csv", "text/csv", Buffer.from("名称,值\n验证,42").toString("base64"));
    expect((await ok("read_memo_attachment", { memoId, resourceId: textFile.id })).content[1].text).toBe("名称,值\n验证,42");
    sqlite.query("UPDATE resources SET byte_size = ? WHERE id = ?").run(3 * 1024 * 1024, textFile.id);
    expect((await tool("read_memo_attachment", { memoId, resourceId: textFile.id, mode: "original" })).structuredContent.error.code).toBe("attachment_too_large");
  });
});

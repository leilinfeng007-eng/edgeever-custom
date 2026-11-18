/**
 * HTTP 与 MCP 共用的附件内容读取：验证工作区/笔记绑定、限制对象读取并提取 Word/UTF-8 文本。
 * 只返回内部数据；MCP image/resource 内容块由 mcp/mcp-attachment 组装。
 */
import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js/index-native.js";
import { XMLParser } from "fast-xml-parser";
import type { Bindings } from "../api-context";
import { AppError } from "../common/app-error";
import { resolveObjectStorage } from "../storage/object-storage";
import { getResourceRow } from "./resource-service";

const MIB = 1024 * 1024;
const IMAGE_LIMIT = 2 * MIB;
const ORIGINAL_LIMIT = 2 * MIB;
const DOCX_LIMIT = 8 * MIB;
const WORD_XML_LIMIT = 2 * MIB;
const TEXT_LIMIT = MIB;
const PAGE_CHARACTERS = 12_000;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json"]);

const tooLarge = (bytes: number) =>
  new AppError("attachment_too_large", `This attachment exceeds the MCP read limit of ${bytes / MIB} MiB for this format.`, 413);

async function readBounded(body: ReadableStream<Uint8Array>, size: number, limit: number) {
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
    await body.cancel();
    throw tooLarge(limit);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > size) {
        await reader.cancel();
        throw new AppError("attachment_size_mismatch", "Attachment storage returned an unexpected length.", 502);
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== size) throw new AppError("attachment_size_mismatch", "Attachment storage returned an unexpected length.", 502);
  return bytes;
}

type WordNode = Record<string, WordNode[] | string>;

function extractWordText(nodes: WordNode[]): string {
  const parts: string[] = [];
  const stack = [{ nodes, index: 0, suffix: "" }];
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    if (frame.index === frame.nodes.length) {
      if (frame.suffix) parts.push(frame.suffix);
      stack.pop();
      continue;
    }
    const node = frame.nodes[frame.index++]!;
    const [name, children] = Object.entries(node)[0] ?? [];
    if (name === "t" && Array.isArray(children)) {
      for (const child of children) if (typeof child["#text"] === "string") parts.push(child["#text"]);
    } else if (name === "tab") {
      parts.push("\t");
    } else if (name === "br" || name === "cr") {
      parts.push("\n");
    } else if (Array.isArray(children)) {
      stack.push({ nodes: children, index: 0, suffix: name === "p" ? "\n" : "" });
    }
  }
  return parts.join("").trim();
}

// 只提取主文档正文；不读取页眉页脚、嵌入图片或旧 .doc，不保留排版，也不做 OCR。
// 压缩大小与 XML 解压大小分别限制；流式累计再次检查，避免仅信任 ZIP 目录中的大小。
async function readDocxText(bytes: Uint8Array) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false, checkCrc32: true });
  try {
    const entries = await reader.getEntries();
    const documents = entries.filter((entry) => entry.filename === "word/document.xml");
    const document = documents[0];
    if (!document || documents.length !== 1 || document.directory || document.encrypted) {
      throw new Error("Invalid Word document part");
    }
    if (document.uncompressedSize > WORD_XML_LIMIT) throw tooLarge(WORD_XML_LIMIT);

    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: string[] = [];
    let inflated = 0;
    await document.getData(new WritableStream<Uint8Array>({
      write(chunk) {
        inflated += chunk.byteLength;
        if (inflated > WORD_XML_LIMIT) throw tooLarge(WORD_XML_LIMIT);
        parts.push(decoder.decode(chunk, { stream: true }));
      },
    }), { checkCrc32: true });
    parts.push(decoder.decode());
    const xml = parts.join("");
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error("Document type declarations are unsupported");
    const tree = new XMLParser({ preserveOrder: true, removeNSPrefix: true, parseTagValue: false, trimValues: false }).parse(xml) as WordNode[];
    const root = tree.find((node) => Array.isArray(node.document))?.document;
    const body = Array.isArray(root) ? root.find((node) => Array.isArray(node.body))?.body : null;
    if (!Array.isArray(body)) throw new Error("Word document body is missing");
    return extractWordText(body);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("attachment_invalid_docx", "The Word document is invalid or encrypted.", 422);
  } finally {
    await reader.close();
  }
}

export async function readAttachmentContent(env: Bindings, workspaceId: string, args: {
  memoId: string; resourceId: string; mode?: unknown; offset?: unknown;
}) {
  const { memoId, resourceId } = args;
  const row = await getResourceRow(env.storage.db, workspaceId, resourceId, false, memoId);
  if (!row) throw new AppError("attachment_not_found", "Attachment not found in this note.", 404);

  const mimeType = row.mime_type?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
  const attachment = { id: row.id, memoId, filename: row.filename, mimeType, byteSize: row.byte_size };
  const isDocx = mimeType === DOCX_MIME || (mimeType === "application/octet-stream" && /\.docx$/i.test(row.filename ?? ""));
  const isText = TEXT_TYPES.has(mimeType) || (mimeType === "application/octet-stream" && /\.(txt|md|csv|tsv|json)$/i.test(row.filename ?? ""));
  if (args.mode !== undefined && args.mode !== "content" && args.mode !== "original") {
    throw new AppError("invalid_params", "mode must be content or original.", 400);
  }
  const format = args.mode === "original" ? "original" : IMAGE_TYPES.has(mimeType) ? "image" : "text";
  const offset = args.offset ?? 0;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || (offset && format !== "text")) {
    throw new AppError("invalid_params", "offset must be a non-negative integer and only applies to text.", 400);
  }
  if (format === "text" && !isDocx && !isText) {
    throw new AppError("attachment_format_unsupported", "This format has no text extractor. Request mode=original to receive the file through MCP.", 422);
  }
  const limit = format === "image" ? IMAGE_LIMIT : format === "original" ? ORIGINAL_LIMIT : isDocx ? DOCX_LIMIT : TEXT_LIMIT;
  if (row.byte_size > limit) throw tooLarge(limit);
  const source = await resolveObjectStorage(env, row.storage_config_id);
  const object = await source.store.get(row.object_key);
  if (!object) throw new AppError("attachment_not_found", "Attachment file is missing from storage.", 404);
  const bytes = await readBounded(object.body, object.size, limit);

  if (format === "image") {
    return { attachment, format: "image" as const, data: bytes };
  }
  if (format === "original") {
    return { attachment, format: "original" as const, data: bytes };
  }

  let text: string;
  if (isDocx) {
    text = await readDocxText(bytes);
  } else {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new AppError("attachment_invalid_text", "The attachment is not valid UTF-8 text.", 422); }
  }
  if (offset > text.length) throw new AppError("invalid_params", "offset is beyond the end of the attachment.", 400);
  let end = Math.min(text.length, offset + PAGE_CHARACTERS);
  // offset 与 nextOffset 使用 JS UTF-16 索引；缩短页尾可避免将一个代理对拆到两页。
  // 调用方续读应直接使用 nextOffset，不要按 UTF-8 字节数或码点数重新计算。
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!)) end--;
  return {
    attachment, format: "text" as const, nextOffset: end < text.length ? end : null, totalCharacters: text.length,
    text: text.slice(offset, end),
  };
}


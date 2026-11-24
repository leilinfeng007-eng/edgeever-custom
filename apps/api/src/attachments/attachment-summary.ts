/**
 * 「附件汇总」章节：把一条笔记里真正带进来的附件收成一段可重复生成的清单。
 *
 * 规则（与前端节点、MCP 约束一致）：
 * - 只收 `kind === "attachment"` 或 PDF 的资源；图片不进汇总。
 * - 顺序 = 首次出现顺序（正文节点在前、资源列表在后），按资源 id 去重。
 * - 每行 `- [filename](/api/v1/resources/<id>/blob?edgeever_summary=1) · <来源>`；
 *   文件名可点击打开，没有来源写「来源未提供」。
 * - 已有 `## 附件汇总` 整段替换，否则追加到正文末尾；重复执行结果完全一致。
 *
 * 汇总行必须保持普通链接：URL 带 `edgeever_summary=1` 时文件/PDF tokenizer
 * 不会把它升级成附件节点，因此不会在汇总里再出现一张带来源编辑的附件卡片。
 */
import {
  ATTACHMENT_SUMMARY_HEADING,
  formatAttachmentSource,
  getAttachmentFilenameFromLabel,
  getResourceIdFromUrl,
  isPdfAttachment,
  parseAttachmentSourceOrNull,
  toAttachmentSummaryLink,
  type AttachmentSource,
  type Resource,
  type TiptapDoc,
  type TiptapNode,
  type TiptapTextNode,
} from "@edgeever/shared";

export const ATTACHMENT_SUMMARY_MISSING_SOURCE_TEXT = "来源未提供";

/** 参与汇总的一条候选附件；来源由调用方按「正文节点 > 资源 metadata」决定。 */
export type AttachmentSummaryEntry = {
  resourceId?: string | null;
  filename?: string | null;
  url?: string | null;
  kind?: string | null;
  mimeType?: string | null;
  source?: AttachmentSource | null;
};

export type AttachmentSummarySection = {
  /** 清单行（不含标题）。 */
  lines: string[];
  total: number;
  /** 完整章节 Markdown（`## 附件汇总` + 空行 + 行）；没有附件时为空字符串。 */
  markdown: string;
};

export type AttachmentSummaryApplication = {
  markdown: string;
  total: number;
  changed: boolean;
};

const SUMMARY_HEADING_LINE = new RegExp(`^\\s{0,3}##\\s+${ATTACHMENT_SUMMARY_HEADING}\\s*#*\\s*$`);
const SECTION_BOUNDARY_LINE = /^\s{0,3}#{1,2}\s+/;

/** `]`/`[` 会截断 Markdown 链接标签，这里只做最小转义。 */
const escapeLinkLabel = (value: string) => value.replace(/([\\[\]])/g, "\\$1").trim();

const resolveEntryFilename = (entry: AttachmentSummaryEntry) => {
  const filename = typeof entry.filename === "string" ? entry.filename.trim() : "";
  if (filename) return filename;
  return "";
};

const resolveEntryUrl = (entry: AttachmentSummaryEntry, resourceId: string) => {
  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  if (url) return url;
  return resourceId ? `/api/v1/resources/${encodeURIComponent(resourceId)}/blob` : "";
};

const resolveEntryKey = (entry: AttachmentSummaryEntry) => {
  const resourceId = typeof entry.resourceId === "string" ? entry.resourceId.trim() : "";
  if (resourceId) return `resource:${resourceId}`;
  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  if (url) return `url:${url}`;
  const filename = resolveEntryFilename(entry);
  return filename ? `filename:${filename}` : "";
};

/** 只汇总附件和 PDF；图片等其他资源不参与。 */
export const isSummaryAttachmentEntry = (entry: AttachmentSummaryEntry) =>
  entry.kind === "attachment" || isPdfAttachment(entry.mimeType, entry.filename);

export const buildAttachmentSummaryLine = (entry: AttachmentSummaryEntry) => {
  const resourceId = typeof entry.resourceId === "string" ? entry.resourceId.trim() : "";
  const filename = resolveEntryFilename(entry) || resourceId || "附件";
  const url = resolveEntryUrl(entry, resourceId);
  const source = entry.source ?? null;
  const sourceFilename = typeof source?.filename === "string" ? source.filename.trim() : "";
  const sourceUrl = typeof source?.url === "string" ? source.url.trim() : "";
  // The linked filename already shows the file, so do not repeat an identical
  // source filename. A different source file or URL is kept as extra context.
  const details = source
    ? formatAttachmentSource({
        ...source,
        filename: sourceFilename && sourceFilename !== filename ? sourceFilename : null,
        url: sourceUrl && sourceUrl !== url ? sourceUrl : null,
      })
    : null;
  const suffix = source
    ? details ? ` · ${details}` : ""
    : ` · ${ATTACHMENT_SUMMARY_MISSING_SOURCE_TEXT}`;
  return `- [${escapeLinkLabel(filename)}](${toAttachmentSummaryLink(url)})${suffix}`;
};

/** 生成汇总章节；顺序稳定、按资源 id 去重，重复执行结果一致。 */
export function buildAttachmentSummary(entries: readonly AttachmentSummaryEntry[]): AttachmentSummarySection {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const entry of entries) {
    if (!isSummaryAttachmentEntry(entry)) continue;
    const key = resolveEntryKey(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    lines.push(buildAttachmentSummaryLine(entry));
  }

  return {
    lines,
    total: lines.length,
    markdown: lines.length > 0 ? [`## ${ATTACHMENT_SUMMARY_HEADING}`, "", ...lines].join("\n") : "",
  };
}

/**
 * 把汇总章节合并进正文：整段替换已有章节，否则追加到末尾。
 * 没有附件时不动正文（返回 changed: false），避免空笔记被写入空章节。
 */
export function applyAttachmentSummary(
  markdown: string,
  entries: readonly AttachmentSummaryEntry[],
): AttachmentSummaryApplication {
  const section = buildAttachmentSummary(entries);
  const original = typeof markdown === "string" ? markdown : "";
  if (section.total === 0) return { markdown: original, total: 0, changed: false };

  const lines = original.split("\n");
  const headingIndex = lines.findIndex((line) => SUMMARY_HEADING_LINE.test(line));
  const sectionLines = section.markdown.split("\n");

  if (headingIndex === -1) {
    const head = original.replace(/\s+$/u, "");
    const next = head ? `${head}\n\n${section.markdown}` : section.markdown;
    return { markdown: next, total: section.total, changed: next !== original };
  }

  let end = headingIndex + 1;
  while (end < lines.length && !SECTION_BOUNDARY_LINE.test(lines[end]!)) end += 1;

  const before = lines.slice(0, headingIndex).join("\n").replace(/\s+$/u, "");
  const after = lines.slice(end).join("\n").replace(/^\s+/u, "");
  const next = [before, section.markdown, after].filter((part) => part.length > 0).join("\n\n");

  return { markdown: next, total: section.total, changed: next !== original };
}

const readNodeAttrs = (node: TiptapNode | TiptapTextNode): Record<string, unknown> => {
  if (node.type === "text") return {};
  const attrs = (node as TiptapNode).attrs;
  return attrs && typeof attrs === "object" ? attrs as Record<string, unknown> : {};
};

const toAttachmentEntry = (node: TiptapNode): AttachmentSummaryEntry | null => {
  if (node.type !== "edgeeverFileAttachment" && node.type !== "edgeeverPdfAttachment") return null;
  const attrs = readNodeAttrs(node);
  const url = typeof attrs.url === "string" ? attrs.url : "";
  const label = typeof attrs.label === "string" ? attrs.label : "";
  const filename = typeof attrs.filename === "string" && attrs.filename.trim()
    ? attrs.filename.trim()
    : getAttachmentFilenameFromLabel(label);
  return {
    resourceId: url ? getResourceIdFromUrl(url) : null,
    filename,
    url,
    // 正文节点里的附件/PDF 都算附件；图片走 image 节点，不在这里。
    kind: "attachment",
    mimeType: typeof attrs.mimeType === "string" && attrs.mimeType.trim()
      ? attrs.mimeType.trim()
      : node.type === "edgeeverPdfAttachment" ? "application/pdf" : null,
    // 节点 attrs.source 是 `formatAttachmentSource` 的文本，按同一套规则还原。
    source: parseAttachmentSourceOrNull(attrs.source),
  };
};

const collectNodeEntries = (doc: TiptapDoc): AttachmentSummaryEntry[] => {
  const entries: AttachmentSummaryEntry[] = [];
  const visit = (node: TiptapNode | TiptapTextNode) => {
    if (node.type === "text") return;
    const entry = toAttachmentEntry(node);
    if (entry) entries.push(entry);
    (node as TiptapNode).content?.forEach(visit);
  };
  doc.content?.forEach(visit);
  return entries;
};

/**
 * 合并两类来源：先按正文出现顺序取节点，再补上资源列表里没在正文出现的附件。
 * 来源优先级：正文节点 attrs.source > resources.metadata.origin > 缺失。
 */
export function collectAttachmentSummaryEntries(
  doc: TiptapDoc | null | undefined,
  resources: readonly Resource[],
): AttachmentSummaryEntry[] {
  const resourcesById = new Map<string, Resource>();
  for (const resource of resources) resourcesById.set(resource.id, resource);

  const entries: AttachmentSummaryEntry[] = [];
  const seen = new Set<string>();

  for (const entry of doc ? collectNodeEntries(doc) : []) {
    const resource = entry.resourceId ? resourcesById.get(entry.resourceId) : undefined;
    const merged: AttachmentSummaryEntry = {
      ...entry,
      filename: entry.filename || resource?.filename || "",
      url: entry.url || resource?.url || "",
      source: entry.source ?? resource?.source ?? null,
    };
    const key = resolveEntryKey(merged);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    entries.push(merged);
  }

  for (const resource of resources) {
    if (seen.has(`resource:${resource.id}`)) continue;
    const entry: AttachmentSummaryEntry = {
      resourceId: resource.id,
      filename: resource.filename ?? "",
      url: resource.url,
      kind: resource.kind,
      mimeType: resource.mimeType,
      source: resource.source ?? null,
    };
    // 图片等非附件资源不进汇总，连候选列表都不进。
    if (!isSummaryAttachmentEntry(entry)) continue;
    seen.add(`resource:${resource.id}`);
    entries.push(entry);
  }

  return entries;
}

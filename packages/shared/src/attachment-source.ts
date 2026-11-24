/**
 * 附件来源契约：描述「这个附件从哪一段资料里来的」，而不是附件本身的元数据。
 *
 * 存储位置（两处，正文节点优先）：
 * - `resources.metadata_json.origin`：规范化后的 `AttachmentSource`（服务端持久化）
 * - 正文节点 attrs `source`（`edgeeverFileAttachment` / `edgeeverPdfAttachment`）：
 *   `formatAttachmentSource()` 的格式化文本，Markdown 里落在链接 title 上
 *
 * 缺失字段一律留空，绝不猜测：页码只能来自显式输入。
 */

export const ATTACHMENT_SOURCE_SEPARATOR = " · ";

/** 单字段文本上限；超出按字符截断而不是丢弃整条来源。 */
export const ATTACHMENT_SOURCE_MAX_TEXT_LENGTH = 120;

/** 页码上限，防止用毫秒时间戳或行号冒充页码。 */
export const ATTACHMENT_SOURCE_MAX_PAGE = 100_000;

export type AttachmentSource = {
  /** 来源文件名（可以与资源文件名不同，例如从 report.pdf 摘出的片段）。 */
  filename?: string | null;
  /** PDF 起始页码（1 起）。 */
  page?: number | null;
  /** PDF 结束页码（含），需要 page 且不小于 page。 */
  pageEnd?: number | null;
  /** 章节名。 */
  chapter?: string | null;
  /** 工作表名。 */
  sheet?: string | null;
  /** 单元格或区域范围，例如 A1:C9。 */
  range?: string | null;
  /** 来源链接。 */
  url?: string | null;
  /** 其他来源说明，也是无法识别片段的落点。 */
  note?: string | null;
};

const FIELD_KEYS = ["filename", "chapter", "sheet", "range", "url", "note"] as const;

const normalizeText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  const characters = Array.from(collapsed);
  return characters.length > ATTACHMENT_SOURCE_MAX_TEXT_LENGTH
    ? characters.slice(0, ATTACHMENT_SOURCE_MAX_TEXT_LENGTH).join("").trim()
    : collapsed;
};

const normalizePage = (value: unknown): number | null => {
  let numeric: number;
  if (typeof value === "number") numeric = value;
  else if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) numeric = Number(value.trim());
  else return null;
  if (!Number.isFinite(numeric)) return null;
  const page = Math.trunc(numeric);
  return page >= 1 && page <= ATTACHMENT_SOURCE_MAX_PAGE ? page : null;
};

/**
 * 只接受对象：丢弃未知字段和非法值，返回只含有效字段的新对象。
 * 全空（含空对象、null、字符串等）返回 null，调用方据此判断「没有来源」。
 */
export function normalizeAttachmentSource(value: unknown): AttachmentSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const result: AttachmentSource = {};

  for (const key of FIELD_KEYS) {
    const text = normalizeText(record[key]);
    if (text) result[key] = text;
  }

  const page = normalizePage(record.page);
  if (page !== null) {
    result.page = page;
    const pageEnd = normalizePage(record.pageEnd);
    if (pageEnd !== null && pageEnd >= page && pageEnd !== page) result.pageEnd = pageEnd;
  }

  return Object.keys(result).length > 0 ? result : null;
}

const formatPage = (source: AttachmentSource) => {
  if (typeof source.page !== "number") return null;
  return typeof source.pageEnd === "number" && source.pageEnd > source.page
    ? `P.${source.page}-${source.pageEnd}`
    : `P.${source.page}`;
};

/**
 * 稳定、可读、可由 `parseAttachmentSource` 还原的一行文本。
 * 顺序固定：文件名 · 页码 · 章节 · 工作表 · 范围 · 链接 · 说明；缺失项整段省略。
 */
export function formatAttachmentSource(source: AttachmentSource | null | undefined): string | null {
  const normalized = normalizeAttachmentSource(source);
  if (!normalized) return null;

  const parts: string[] = [];
  if (normalized.filename) parts.push(normalized.filename);
  const page = formatPage(normalized);
  if (page) parts.push(page);
  if (normalized.chapter) parts.push(`章节：${normalized.chapter}`);
  if (normalized.sheet) parts.push(`工作表：${normalized.sheet}`);
  if (normalized.range) parts.push(`范围：${normalized.range}`);
  if (normalized.url) parts.push(normalized.url);
  if (normalized.note) parts.push(`说明：${normalized.note}`);

  return parts.length > 0 ? parts.join(ATTACHMENT_SOURCE_SEPARATOR) : null;
}

const PAGE_SEGMENT = /^(?:P\.?\s*|第\s*)(\d+)(?:\s*(?:-|–|—|~|至)\s*(\d+))?\s*页?$/i;
const LABELLED_SEGMENTS: Array<{ key: "chapter" | "sheet" | "range" | "note"; pattern: RegExp }> = [
  { key: "chapter", pattern: /^(?:章节|章|Chapter)\s*[：:]\s*(.*)$/i },
  { key: "sheet", pattern: /^(?:工作表|Sheet)\s*[：:]\s*(.*)$/i },
  { key: "range", pattern: /^(?:范围|区域|单元格|Range)\s*[：:]\s*(.*)$/i },
  { key: "note", pattern: /^(?:说明|备注|来源说明|Note)\s*[：:]\s*(.*)$/i },
];
const URL_SEGMENT = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/**
 * `formatAttachmentSource` 的逆操作。宽容解析：认不出的片段进 `note`，
 * 不做任何推断（例如裸数字不会被当成页码）。
 */
export function parseAttachmentSource(text: string): AttachmentSource {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return {};

  const parsed: AttachmentSource = {};
  const leftovers: string[] = [];

  for (const segment of raw.split(/\s*·\s*/)) {
    const value = segment.trim();
    if (!value) continue;

    const page = PAGE_SEGMENT.exec(value);
    if (page && parsed.page === undefined) {
      const start = normalizePage(page[1]);
      if (start !== null) {
        parsed.page = start;
        const end = normalizePage(page[2]);
        if (end !== null && end >= start && end !== start) parsed.pageEnd = end;
        continue;
      }
    }

    const labelled = LABELLED_SEGMENTS.find(({ key, pattern }) => parsed[key] === undefined && pattern.test(value));
    if (labelled) {
      const matched = labelled.pattern.exec(value);
      const content = normalizeText(matched?.[1]);
      if (content) {
        parsed[labelled.key] = content;
        continue;
      }
    }

    if (parsed.url === undefined && URL_SEGMENT.test(value)) {
      const url = normalizeText(value);
      if (url) {
        parsed.url = url;
        continue;
      }
    }

    if (parsed.filename === undefined && leftovers.length === 0 && parsed.url === undefined) {
      const filename = normalizeText(value);
      if (filename) {
        parsed.filename = filename;
        continue;
      }
    }

    leftovers.push(value);
  }

  if (leftovers.length > 0) {
    const note = [parsed.note, leftovers.join(ATTACHMENT_SOURCE_SEPARATOR)].filter(Boolean).join(ATTACHMENT_SOURCE_SEPARATOR);
    parsed.note = note;
  }

  return normalizeAttachmentSource(parsed) ?? {};
}

/** 节点 attrs / Markdown title 文本 → 规范化来源；空或全空返回 null。 */
export function parseAttachmentSourceOrNull(text: unknown): AttachmentSource | null {
  if (typeof text !== "string" || !text.trim()) return null;
  return normalizeAttachmentSource(parseAttachmentSource(text));
}

/** 规范化来源的显示文本；缺失返回 null。 */
export function formatAttachmentSourceText(source: AttachmentSource | null | undefined): string | null {
  return formatAttachmentSource(source);
}

/** 资源 metadata 里承载来源对象的键；与既有的 `metadata.source`（"upload"|"mcp"）互不覆盖。 */
export const ATTACHMENT_SOURCE_METADATA_KEY = "origin";

/** 读取 `resources.metadata_json`；损坏或非对象一律当作没有 metadata。 */
export function parseResourceMetadata(metadataJson: unknown): Record<string, unknown> {
  if (typeof metadataJson !== "string" || !metadataJson.trim()) return {};
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * `resources.metadata_json.origin` → 规范化来源；缺失或非法返回 null。
 * 服务端 `mapResource` 与前端展示共用，避免两侧各自解析。
 */
export function readAttachmentSourceFromMetadata(metadataJson: unknown): AttachmentSource | null {
  return normalizeAttachmentSource(parseResourceMetadata(metadataJson)[ATTACHMENT_SOURCE_METADATA_KEY]);
}

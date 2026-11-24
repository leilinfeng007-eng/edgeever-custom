import { toMarkdown } from "mdast-util-to-markdown";

const RESOURCE_PATH_PATTERN = /\/api\/v1\/resources\/([^/]+)\/blob(?:$|[?#])/;

// Resource nodes serialize without a surrounding paragraph/phrasing context.
// Escape entity-like label text there without changing destinations or titles.
export const resourceNodeToMarkdown = (node: Parameters<typeof toMarkdown>[0]): string => toMarkdown(node, {
  unsafe: [{ character: "&", after: "[#A-Za-z]", inConstruct: "label",
    notInConstruct: ["destinationRaw", "destinationLiteral", "titleQuote", "titleApostrophe"] }],
}).trimEnd();

export const resourceLinkToMarkdown = (label: string, url: string, title?: string | null): string => {
  const linkTitle = typeof title === "string" ? title.trim() : "";
  return resourceNodeToMarkdown({
    type: "link",
    url,
    // 附件来源文本落在链接 title 上；没有来源时不输出 title，旧笔记的 Markdown 保持不变。
    ...(linkTitle ? { title: linkTitle } : {}),
    children: [{ type: "text", value: label }],
  });
};

export const getResourceIdFromUrl = (href: string): string | null => {
  if (href.startsWith("edgeever-resource://")) {
    try {
      const parsed = new URL(href);
      const resourceId = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
      return resourceId || null;
    } catch {
      return null;
    }
  }

  try {
    const parsed = new URL(href, "http://edgeever.local");
    const match = parsed.pathname.match(RESOURCE_PATH_PATTERN);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
};

export const getAttachmentFilenameFromLabel = (label: string) =>
  label.replace(/^\s*(?:附件[：:]|Attachment:)\s*/i, "").trim();

/**
 * 附件汇总行使用普通链接而不是附件节点：URL 带这个参数时，文件/PDF
 * tokenizer 会保留为普通链接，文件名仍可点击打开，但不会再渲染出附件卡片。
 * 资源接口忽略未知查询参数，因此链接本身照常工作。
 */
export const ATTACHMENT_SUMMARY_LINK_PARAM = "edgeever_summary=1";

export const isAttachmentSummaryLink = (url: string): boolean =>
  typeof url === "string" && /(?:[?&])edgeever_summary=1(?:[&#]|$)/.test(url);

export const toAttachmentSummaryLink = (url: string): string => {
  const text = typeof url === "string" ? url.trim() : "";
  if (!text || isAttachmentSummaryLink(text)) return text;
  const hashIndex = text.indexOf("#");
  const base = hashIndex === -1 ? text : text.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : text.slice(hashIndex);
  return `${base}${base.includes("?") ? "&" : "?"}${ATTACHMENT_SUMMARY_LINK_PARAM}${hash}`;
};

/** Match API, desktop protocol, and identical staged URLs for the same stored file. */
export const resourceUrlsReferToSameAttachment = (left: string, right: string) => {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftId = getResourceIdFromUrl(left);
  const rightId = getResourceIdFromUrl(right);
  return Boolean(leftId && rightId && leftId === rightId);
};

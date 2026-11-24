import { mergeAttributes, Node } from "@tiptap/core";
import type { TiptapDoc, TiptapMark, TiptapNode, TiptapTextNode } from "./content";
import {
  getAttachmentFilenameFromLabel,
  isAttachmentSummaryLink,
  resourceLinkToMarkdown,
} from "./resource-links";
import { normalizeAttachmentByteSize } from "./attachment-metadata";
import { decodeString } from "micromark-util-decode-string";

export const PDF_ATTACHMENT_NODE_TYPE = "edgeeverPdfAttachment" as const;
export const PDF_DISPLAY_MODES = ["compact", "inline"] as const;
export type PdfDisplayMode = (typeof PDF_DISPLAY_MODES)[number];

export const resolvePdfDisplayMode = (value: unknown): PdfDisplayMode =>
  value === "inline" ? "inline" : "compact";

// 第三段可选 title 承载来源描述，与 FileAttachment 保持一致；没有 title 的旧链接照旧解析。
const PDF_LINK_PATTERN = /^\[((?:\\.|[^[\]\\])+)\]\(([^\s)]+)(?:\s+"((?:\\.|[^"\\])*)")?\)/;

export const isPdfAttachment = (mimeType: string | null | undefined, filename: string | null | undefined) =>
  mimeType?.toLowerCase() === "application/pdf" || filename?.trim().toLowerCase().endsWith(".pdf") === true;

export const PdfAttachment = Node.create({
  name: PDF_ATTACHMENT_NODE_TYPE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      url: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-pdf-url") || "",
        renderHTML: (attributes) => ({ "data-pdf-url": attributes.url || "" }),
      },
      label: {
        default: "PDF",
        parseHTML: (element) => element.getAttribute("data-pdf-label") || "PDF",
        renderHTML: (attributes) => ({ "data-pdf-label": attributes.label || "PDF" }),
      },
      filename: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-pdf-name") || "",
        renderHTML: (attributes) => ({ "data-pdf-name": attributes.filename || "" }),
      },
      mimeType: {
        default: "application/pdf",
        parseHTML: (element) => element.getAttribute("data-pdf-mime-type") || "application/pdf",
        renderHTML: (attributes) => ({ "data-pdf-mime-type": attributes.mimeType || "application/pdf" }),
      },
      byteSize: {
        default: null,
        parseHTML: (element) => normalizeAttachmentByteSize(element.getAttribute("data-pdf-byte-size")),
        renderHTML: (attributes) => {
          const byteSize = normalizeAttachmentByteSize(attributes.byteSize);
          return byteSize === null ? {} : { "data-pdf-byte-size": String(byteSize) };
        },
      },
      displayMode: {
        default: "compact",
        parseHTML: (element) => resolvePdfDisplayMode(element.getAttribute("data-pdf-display-mode")),
        renderHTML: (attributes) => ({
          "data-pdf-display-mode": resolvePdfDisplayMode(attributes.displayMode),
        }),
      },
      /**
       * 来源描述（`formatAttachmentSource` 的文本），空字符串表示未知。
       * Markdown 里对应链接 title；旧笔记没有 title 时保持空字符串。
       */
      source: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-pdf-source") || "",
        renderHTML: (attributes) => {
          const source = typeof attributes.source === "string" ? attributes.source.trim() : "";
          return source ? { "data-pdf-source": source } : {};
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="edgeever-pdf-attachment"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": "edgeever-pdf-attachment",
        class: "edgeever-pdf-attachment",
      }),
    ];
  },

  parseMarkdown: (token) => ({
    type: PDF_ATTACHMENT_NODE_TYPE,
    attrs: {
      url: token.url || "",
      label: token.label || "PDF",
      filename: getAttachmentFilenameFromLabel(token.label || "PDF"),
      mimeType: "application/pdf",
      byteSize: null,
      displayMode: "compact",
      source: token.source || "",
    },
  }),

  renderMarkdown: (node) =>
    resourceLinkToMarkdown(
      String(node.attrs?.label || "PDF"),
      String(node.attrs?.url || ""),
      typeof node.attrs?.source === "string" ? node.attrs.source : null,
    ),

  markdownTokenizer: {
    name: PDF_ATTACHMENT_NODE_TYPE,
    level: "inline",
    start(source: string) {
      const linkStart = source.indexOf("[");
      return linkStart;
    },
    tokenize(source: string) {
      const match = PDF_LINK_PATTERN.exec(source);
      if (!match) return undefined;
      // Summary rows use a plain link, even when the filename ends in .pdf.
      if (isAttachmentSummaryLink(match[2])) return undefined;
      const label = decodeString(match[1]);
      if (!isPdfAttachment(null, label) && !isPdfAttachment(null, match[2])) {
        return undefined;
      }
      return {
        type: PDF_ATTACHMENT_NODE_TYPE,
        raw: match[0],
        label,
        url: match[2],
        // 链接 title 承载来源描述；没有 title 时留空，不额外输出空 title。
        source: match[3] ? decodeString(match[3]) : "",
      };
    },
  },
});

const getLinkMark = (node: TiptapTextNode): TiptapMark | undefined =>
  node.marks?.find((mark) => mark.type === "link" && typeof mark.attrs?.href === "string");

const getLinkAttachmentAttrs = (link: TiptapMark | undefined, label: string) => ({
  filename: typeof link?.attrs?.attachmentFilename === "string"
    ? link.attrs.attachmentFilename
    : getAttachmentFilenameFromLabel(label),
  mimeType: typeof link?.attrs?.attachmentMimeType === "string"
    ? link.attrs.attachmentMimeType
    : "application/pdf",
  byteSize: normalizeAttachmentByteSize(link?.attrs?.attachmentByteSize),
  // 旧链接的 title 就是来源文本；没有 title 时留空，不写占位内容。
  source: typeof link?.attrs?.title === "string" ? link.attrs.title.trim() : "",
});

/** Upgrade legacy standalone PDF link paragraphs without changing their Markdown representation. */
export const upgradeStandalonePdfLinks = (doc: TiptapDoc): TiptapDoc => {
  let changed = false;
  const visit = (node: TiptapNode): TiptapNode => {
    if (node.type === "paragraph" && node.content?.length === 1) {
      const child = node.content[0];
      if (child.type === "text" && "text" in child) {
        const link = getLinkMark(child);
        const href = link?.attrs?.href;
        if (typeof href === "string" && !isAttachmentSummaryLink(href)
          && (isPdfAttachment(null, child.text) || isPdfAttachment(null, href))) {
          changed = true;
          return {
            ...node,
            content: [{
              type: PDF_ATTACHMENT_NODE_TYPE,
              attrs: {
                url: href,
                label: child.text,
                ...getLinkAttachmentAttrs(link, child.text),
                displayMode: "compact",
              },
            }],
          };
        }
      }
    }
    return node.content
      ? { ...node, content: node.content.map((child) => child.type === "text" ? child : visit(child)) }
      : node;
  };
  const content = doc.content.map(visit);
  return changed ? { ...doc, content } : doc;
};

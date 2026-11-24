import { describe, expect, test } from "bun:test";
import {
  docToMarkdown,
  markdownToDoc,
  FILE_ATTACHMENT_NODE_TYPE,
  PDF_ATTACHMENT_NODE_TYPE,
  resolveMemoContentDoc,
} from "./content.ts";

const firstInlineNode = (doc) => doc.content[0]?.content?.[0];

describe("file attachment source in Markdown", () => {
  test("carries the source through the link title and back", () => {
    const markdown = '[附件：季度评审.docx](/api/v1/resources/res_1/blob "季度评审.docx · 章节：方法")';
    const doc = markdownToDoc(markdown);
    const node = firstInlineNode(doc);

    expect(node).toMatchObject({
      type: FILE_ATTACHMENT_NODE_TYPE,
      attrs: { source: "季度评审.docx · 章节：方法", url: "/api/v1/resources/res_1/blob" },
    });
    expect(docToMarkdown(doc)).toBe(markdown);
  });

  test("keeps legacy links without a title byte-identical", () => {
    const markdown = "[附件：archive.zip](/api/v1/resources/res_zip/blob)";
    const doc = markdownToDoc(markdown);

    expect(firstInlineNode(doc)).toMatchObject({
      type: FILE_ATTACHMENT_NODE_TYPE,
      attrs: { source: "" },
    });
    expect(docToMarkdown(doc)).toBe(markdown);
  });

  test("upgrades a legacy link whose mark already carries a title", () => {
    const doc = resolveMemoContentDoc({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{
          type: "text",
          text: "附件：data.xlsx",
          marks: [{
            type: "link",
            attrs: { href: "/api/v1/resources/res_xlsx/blob", title: "data.xlsx · 工作表：明细 · 范围：A1:C9" },
          }],
        }],
      }],
    }, "");

    expect(firstInlineNode(doc)).toMatchObject({
      type: FILE_ATTACHMENT_NODE_TYPE,
      attrs: { source: "data.xlsx · 工作表：明细 · 范围：A1:C9" },
    });
  });
});

describe("attachment summary links", () => {
  test("keeps file and PDF summary rows as ordinary links", () => {
    const markdown = [
      "- [季度报告.pdf](/api/v1/resources/res_pdf/blob?edgeever_summary=1) · P.3-5",
      "- [明细.csv](/api/v1/resources/res_sheet/blob?edgeever_summary=1) · 来源未提供",
    ].join("\n");
    const doc = markdownToDoc(markdown);
    const json = JSON.stringify(doc);

    expect(json).not.toContain(FILE_ATTACHMENT_NODE_TYPE);
    expect(json).not.toContain(PDF_ATTACHMENT_NODE_TYPE);
    expect(json).toContain("edgeever_summary=1");
    expect(docToMarkdown(doc)).toBe(markdown);
  });

  test("still upgrades the same resource URL without the summary marker", () => {
    const doc = markdownToDoc("- [季度报告.pdf](/api/v1/resources/res_pdf/blob)");
    expect(JSON.stringify(doc)).toContain(PDF_ATTACHMENT_NODE_TYPE);
  });
});

describe("PDF attachment source in Markdown", () => {
  test("carries the source through the link title and back", () => {
    const markdown = '[附件：报告.pdf](/api/v1/resources/res_pdf/blob "报告.pdf · P.1-4")';
    const doc = markdownToDoc(markdown);

    expect(firstInlineNode(doc)).toMatchObject({
      type: PDF_ATTACHMENT_NODE_TYPE,
      attrs: { source: "报告.pdf · P.1-4", url: "/api/v1/resources/res_pdf/blob", displayMode: "compact" },
    });
    expect(docToMarkdown(doc)).toBe(markdown);
  });

  test("keeps legacy PDF links without a title unchanged", () => {
    const markdown = "[Attachment: report.pdf](/api/v1/resources/res_pdf/blob)";
    const doc = markdownToDoc(markdown);

    expect(firstInlineNode(doc)).toMatchObject({
      type: PDF_ATTACHMENT_NODE_TYPE,
      attrs: { source: "" },
    });
    expect(docToMarkdown(doc)).toBe(markdown);
  });

  test("does not invent a source for rich content that has none", () => {
    const richDoc = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{
          type: PDF_ATTACHMENT_NODE_TYPE,
          attrs: { label: "Attachment: report.pdf", url: "/api/v1/resources/res_pdf/blob", displayMode: "inline" },
        }],
      }],
    };

    expect(docToMarkdown(richDoc)).toBe("[Attachment: report.pdf](/api/v1/resources/res_pdf/blob)");
    expect(resolveMemoContentDoc(richDoc, "").content[0]?.content?.[0]?.attrs?.source ?? "").toBe("");
  });
});

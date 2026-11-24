import { describe, expect, test } from "bun:test";
import {
  applyAttachmentSummary,
  buildAttachmentSummary,
  collectAttachmentSummaryEntries,
} from "./attachment-summary.ts";

const pdfResource = {
  id: "res_pdf",
  memoId: "memo_1",
  originalMemoId: null,
  kind: "attachment",
  mimeType: "application/pdf",
  filename: "季度报告.pdf",
  byteSize: 1024,
  sha256: "hash",
  width: null,
  height: null,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  url: "/api/v1/resources/res_pdf/blob",
  source: { filename: "季度报告.pdf", page: 3, pageEnd: 5 },
};

const sheetResource = {
  ...pdfResource,
  id: "res_sheet",
  mimeType: "text/csv",
  filename: "明细.csv",
  url: "/api/v1/resources/res_sheet/blob",
  source: null,
};

const imageResource = {
  ...pdfResource,
  id: "res_img",
  kind: "image",
  mimeType: "image/png",
  filename: "截图.png",
  url: "/api/v1/resources/res_img/blob",
  source: null,
};

const paragraph = (node) => ({ type: "paragraph", content: [node] });

describe("attachment summary section", () => {
  test("lists attachments and PDFs in first-seen order and skips images", () => {
    const summary = buildAttachmentSummary([
      { resourceId: "res_pdf", filename: "季度报告.pdf", kind: "attachment", mimeType: "application/pdf", source: pdfResource.source },
      { resourceId: "res_img", filename: "截图.png", kind: "image", mimeType: "image/png" },
      { resourceId: "res_sheet", filename: "明细.csv", kind: "attachment", mimeType: "text/csv" },
    ]);

    expect(summary.total).toBe(2);
    expect(summary.lines).toEqual([
      "- [季度报告.pdf](/api/v1/resources/res_pdf/blob?edgeever_summary=1) · P.3-5",
      "- [明细.csv](/api/v1/resources/res_sheet/blob?edgeever_summary=1) · 来源未提供",
    ]);
    expect(summary.markdown).toBe([
      "## 附件汇总",
      "",
      "- [季度报告.pdf](/api/v1/resources/res_pdf/blob?edgeever_summary=1) · P.3-5",
      "- [明细.csv](/api/v1/resources/res_sheet/blob?edgeever_summary=1) · 来源未提供",
    ].join("\n"));
  });

  test("deduplicates by resource id and keeps the first position", () => {
    const summary = buildAttachmentSummary([
      { resourceId: "res_sheet", filename: "明细.csv", kind: "attachment" },
      { resourceId: "res_pdf", filename: "季度报告.pdf", kind: "attachment", source: pdfResource.source },
      { resourceId: "res_sheet", filename: "明细.csv", kind: "attachment", source: { sheet: "汇总" } },
    ]);

    expect(summary.lines).toHaveLength(2);
    expect(summary.lines[0]).toContain("明细.csv");
    expect(summary.lines[1]).toContain("季度报告.pdf");
  });

  test("appends the section once and stays byte-identical when repeated", () => {
    const body = "第一段正文\n\n第二段正文";
    const first = applyAttachmentSummary(body, [pdfResource, sheetResource, imageResource]);

    expect(first.total).toBe(2);
    expect(first.changed).toBe(true);
    expect(first.markdown.startsWith(`${body}\n\n## 附件汇总`)).toBe(true);

    const second = applyAttachmentSummary(first.markdown, [pdfResource, sheetResource, imageResource]);
    expect(second.markdown).toBe(first.markdown);
    expect(second.changed).toBe(false);
  });

  test("replaces an existing section in place and keeps the following content", () => {
    const markdown = [
      "# 笔记",
      "",
      "## 附件汇总",
      "",
      "- [附件：旧文件.pdf](/api/v1/resources/res_old/blob) — 来源未提供",
      "",
      "## 结论",
      "",
      "结论正文",
    ].join("\n");

    const applied = applyAttachmentSummary(markdown, [pdfResource]);

    expect(applied.changed).toBe(true);
    expect(applied.markdown).toBe([
      "# 笔记",
      "",
      "## 附件汇总",
      "",
      "- [季度报告.pdf](/api/v1/resources/res_pdf/blob?edgeever_summary=1) · P.3-5",
      "",
      "## 结论",
      "",
      "结论正文",
    ].join("\n"));
    expect(applyAttachmentSummary(applied.markdown, [pdfResource]).markdown).toBe(applied.markdown);
  });

  test("leaves the note untouched when there is nothing to summarize", () => {
    const markdown = "只有正文";
    expect(applyAttachmentSummary(markdown, [])).toEqual({ markdown, total: 0, changed: false });
    expect(applyAttachmentSummary(markdown, [imageResource])).toEqual({ markdown, total: 0, changed: false });
  });

  test("writes 来源未提供 when no source is known", () => {
    const applied = applyAttachmentSummary("正文", [sheetResource]);
    expect(applied.markdown).toContain("- [明细.csv](/api/v1/resources/res_sheet/blob?edgeever_summary=1) · 来源未提供");
  });

  test("rewrites an old card-style summary into one plain line per attachment", () => {
    const oldFormat = [
      "正文",
      "",
      "## 附件汇总",
      "",
      "- [附件：季度报告.pdf](/api/v1/resources/res_pdf/blob) — 季度报告.pdf · P.3-5",
      "",
      "## 结论",
      "",
      "结论正文",
    ].join("\n");
    const applied = applyAttachmentSummary(oldFormat, [pdfResource]);
    expect(applied.changed).toBe(true);
    expect(applied.markdown).toContain("- [季度报告.pdf](/api/v1/resources/res_pdf/blob?edgeever_summary=1) · P.3-5");
    expect(applied.markdown).not.toContain("[附件：");
    expect(applied.markdown).toContain("## 结论\n\n结论正文");
  });
});

describe("attachment summary entry collection", () => {
  test("prefers the node source and keeps document order", () => {
    const doc = {
      type: "doc",
      content: [
        paragraph({
          type: "edgeeverPdfAttachment",
          attrs: {
            url: "/api/v1/resources/res_pdf/blob",
            label: "附件：季度报告.pdf",
            filename: "季度报告.pdf",
            mimeType: "application/pdf",
            source: "季度报告.pdf · P.9",
          },
        }),
        paragraph({
          type: "edgeeverFileAttachment",
          attrs: {
            url: "/api/v1/resources/res_sheet/blob",
            label: "附件：明细.csv",
            filename: "明细.csv",
            mimeType: "text/csv",
            source: "",
          },
        }),
        paragraph({ type: "image", attrs: { src: "/api/v1/resources/res_img/blob" } }),
      ],
    };

    const entries = collectAttachmentSummaryEntries(doc, [pdfResource, sheetResource, imageResource]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ resourceId: "res_pdf", source: { filename: "季度报告.pdf", page: 9 } });
    // 节点没有来源时回落到资源 metadata.origin（这里为空 → 缺失）。
    expect(entries[1]).toMatchObject({ resourceId: "res_sheet", source: null });

    const summary = buildAttachmentSummary(entries);
    expect(summary.lines[0]).toContain("[季度报告.pdf]");
    expect(summary.lines[0]).toContain("· P.9");
    expect(summary.lines[1]).toContain("来源未提供");
  });

  test("falls back to the resource origin when the node has no source", () => {
    const doc = {
      type: "doc",
      content: [paragraph({
        type: "edgeeverPdfAttachment",
        attrs: { url: "/api/v1/resources/res_pdf/blob", label: "附件：季度报告.pdf", source: "" },
      })],
    };

    const entries = collectAttachmentSummaryEntries(doc, [pdfResource]);
    expect(entries[0]?.source).toEqual({ filename: "季度报告.pdf", page: 3, pageEnd: 5 });
  });

  test("adds attachments that only exist as resources", () => {
    const entries = collectAttachmentSummaryEntries({ type: "doc", content: [] }, [pdfResource, sheetResource, imageResource]);
    expect(entries.map((entry) => entry.resourceId)).toEqual(["res_pdf", "res_sheet"]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_SOURCE_MAX_PAGE,
  ATTACHMENT_SOURCE_MAX_TEXT_LENGTH,
  ATTACHMENT_SOURCE_METADATA_KEY,
  formatAttachmentSource,
  formatAttachmentSourceText,
  normalizeAttachmentSource,
  parseAttachmentSource,
  parseAttachmentSourceOrNull,
  readAttachmentSourceFromMetadata,
} from "./attachment-source.ts";

describe("attachment source round trip", () => {
  test("formats every field in a fixed order", () => {
    const source = {
      filename: "季度报告.pdf",
      page: 3,
      pageEnd: 5,
      chapter: "方法",
      sheet: "汇总",
      range: "A1:C9",
      url: "https://example.com/report",
      note: "客户提供",
    };

    expect(formatAttachmentSource(source)).toBe(
      "季度报告.pdf · P.3-5 · 章节：方法 · 工作表：汇总 · 范围：A1:C9 · https://example.com/report · 说明：客户提供",
    );
    expect(parseAttachmentSource(formatAttachmentSource(source) ?? "")).toEqual(source);
    expect(formatAttachmentSource(parseAttachmentSource(formatAttachmentSource(source) ?? "")))
      .toBe(formatAttachmentSource(source));
  });

  test("pages survive a single-page and a range round trip", () => {
    for (const page of ["P.7", "P.7-12"]) {
      const parsed = parseAttachmentSource(`report.pdf · ${page}`);
      expect(formatAttachmentSource(parsed)).toContain(page);
    }
    expect(parseAttachmentSource("P.7")).toEqual({ page: 7 });
    expect(parseAttachmentSource("第 7-12 页")).toEqual({ page: 7, pageEnd: 12 });
  });

  test("keeps unknown fragments as a note instead of guessing a page", () => {
    const parsed = parseAttachmentSource("report.pdf · 附录 B");
    expect(parsed).toEqual({ filename: "report.pdf", note: "附录 B" });
  });
});

describe("attachment source normalization", () => {
  test("drops missing and blank fields without inventing values", () => {
    expect(normalizeAttachmentSource({ filename: "  ", chapter: null, page: undefined })).toBeNull();
    expect(normalizeAttachmentSource({})).toBeNull();
    expect(normalizeAttachmentSource(null)).toBeNull();
    expect(normalizeAttachmentSource("report.pdf")).toBeNull();
    expect(normalizeAttachmentSource(["report.pdf"])).toBeNull();
    expect(normalizeAttachmentSource({ filename: " 报告.pdf ", unknown: "x" })).toEqual({ filename: "报告.pdf" });
  });

  test("rejects out-of-range pages", () => {
    expect(normalizeAttachmentSource({ page: 0 })).toBeNull();
    expect(normalizeAttachmentSource({ page: -3 })).toBeNull();
    expect(normalizeAttachmentSource({ page: ATTACHMENT_SOURCE_MAX_PAGE + 1 })).toBeNull();
    expect(normalizeAttachmentSource({ page: "abc" })).toBeNull();
    expect(normalizeAttachmentSource({ page: 2.7 })).toEqual({ page: 2 });
    expect(normalizeAttachmentSource({ page: ATTACHMENT_SOURCE_MAX_PAGE })).toEqual({ page: ATTACHMENT_SOURCE_MAX_PAGE });
    // 结束页不能早于起始页。
    expect(normalizeAttachmentSource({ page: 9, pageEnd: 4 })).toEqual({ page: 9 });
  });

  test("truncates long text instead of dropping the whole source", () => {
    const normalized = normalizeAttachmentSource({ filename: "长".repeat(ATTACHMENT_SOURCE_MAX_TEXT_LENGTH + 30) });
    expect(normalized?.filename).toHaveLength(ATTACHMENT_SOURCE_MAX_TEXT_LENGTH);
    expect(normalized?.filename).toBe("长".repeat(ATTACHMENT_SOURCE_MAX_TEXT_LENGTH));
  });

  test("parsing empty text yields no source", () => {
    expect(parseAttachmentSource("")).toEqual({});
    expect(parseAttachmentSourceOrNull("   ")).toBeNull();
    expect(parseAttachmentSourceOrNull(undefined)).toBeNull();
    expect(formatAttachmentSourceText(null)).toBeNull();
  });
});

describe("attachment source metadata contract", () => {
  test("reads the origin key without touching the legacy source string", () => {
    const metadata = JSON.stringify({
      source: "upload",
      [ATTACHMENT_SOURCE_METADATA_KEY]: { filename: "report.pdf", page: 3 },
    });

    expect(readAttachmentSourceFromMetadata(metadata)).toEqual({ filename: "report.pdf", page: 3 });
  });

  test("treats missing, invalid and empty metadata as no source", () => {
    expect(readAttachmentSourceFromMetadata(null)).toBeNull();
    expect(readAttachmentSourceFromMetadata("not json")).toBeNull();
    expect(readAttachmentSourceFromMetadata(JSON.stringify({ source: "upload" }))).toBeNull();
    expect(readAttachmentSourceFromMetadata(JSON.stringify({ [ATTACHMENT_SOURCE_METADATA_KEY]: {} }))).toBeNull();
  });
});

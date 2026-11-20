import { describe, expect, test } from "bun:test";
import { AppError } from "../common/app-error.ts";
import { applyNoteSectionOperations, cleanTemplateMarkdown } from "./mcp-note-sections.ts";

const note = `# 项目记录

开头说明。

## 背景

旧背景。

### 细节

- 保留这条

## 结果

旧结果。

## 附件

![图](/api/v1/resources/res_demo_image/blob)
`;

const failureOf = (run) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to fail.");
};

describe("MCP section-level note updates", () => {
  test("appends inside one section without touching other sections or attachments", () => {
    const next = applyNoteSectionOperations(note, [
      { heading: "背景", mode: "append", contentMarkdown: "新增背景。" },
    ]);
    expect(next).toContain("旧背景。\n\n新增背景。");
    expect(next).toContain("### 细节\n\n- 保留这条");
    expect(next).toContain("旧结果。");
    expect(next).toContain("![图](/api/v1/resources/res_demo_image/blob)");
  });

  test("replaces only the matched section body and keeps the heading", () => {
    const next = applyNoteSectionOperations(note, [
      { heading: "结果", mode: "replace", contentMarkdown: "新结果。" },
    ]);
    expect(next).toContain("## 结果\n\n新结果。");
    expect(next).not.toContain("旧结果。");
    expect(next).toContain("旧背景。");
  });

  test("returns a conflict for missing or duplicated headings and ignores fenced examples", () => {
    expect(failureOf(() => applyNoteSectionOperations(note, [
      { heading: "不存在", mode: "append", contentMarkdown: "x" },
    ]))).toMatchObject({ code: "section_not_found", status: 409 });

    const duplicated = `## 记录\n\nA\n\n## 记录\n\nB\n`;
    expect(failureOf(() => applyNoteSectionOperations(duplicated, [
      { heading: "记录", mode: "append", contentMarkdown: "C" },
    ]))).toMatchObject({ code: "section_ambiguous", status: 409 });

    const fenced = `## 真实章节\n\n正文\n\n\`\`\`md\n## 记录\n\`\`\`\n`;
    expect(failureOf(() => applyNoteSectionOperations(fenced, [
      { heading: "记录", mode: "append", contentMarkdown: "x" },
    ]))).toMatchObject({ code: "section_not_found" });
  });

  test("does not mutate the input note", () => {
    const before = note;
    applyNoteSectionOperations(note, [{ heading: "背景", mode: "replace", contentMarkdown: "替换" }]);
    expect(note).toBe(before);
  });
});

describe("template content cleanup", () => {
  test("removes empty sections, template instructions and comments but keeps real content", () => {
    const template = `# 会议纪要

> 填写说明：请填写参会人。

## 议题

议题正文。

## 空章节

<!-- 模板占位 -->

## 说明

（填写要点：只写事实）

补充说明。
`;
    const cleaned = cleanTemplateMarkdown(template);
    expect(cleaned).toContain("# 会议纪要");
    expect(cleaned).toContain("议题正文。");
    expect(cleaned).toContain("补充说明。");
    expect(cleaned).not.toContain("填写说明");
    expect(cleaned).not.toContain("空章节");
    expect(cleaned).not.toContain("模板占位");
  });

  test("keeps a parent heading whose child section has content", () => {
    const cleaned = cleanTemplateMarkdown("## 父级\n\n### 子级\n\n正文\n");
    expect(cleaned).toContain("## 父级");
    expect(cleaned).toContain("### 子级");
  });

  test("treats invalid operations as parameter errors", () => {
    expect(failureOf(() => applyNoteSectionOperations(note, [
      { heading: "", mode: "append", contentMarkdown: "x" },
    ]))).toBeInstanceOf(AppError);
    expect(failureOf(() => applyNoteSectionOperations(note, [
      { heading: "背景", mode: "merge", contentMarkdown: "x" },
    ]))).toBeInstanceOf(AppError);
  });
});

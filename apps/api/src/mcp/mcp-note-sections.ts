/**
 * 笔记章节级编辑：按 Markdown 标题定位段落，支持追加与替换。
 * 只返回新的 Markdown，不写库；匹配不唯一或不存在时返回冲突，不猜测位置。
 */
import { AppError } from "../common/app-error";

export type NoteSectionMode = "append" | "replace";
export type NoteSectionOperation = {
  heading: string;
  mode: NoteSectionMode;
  contentMarkdown: string;
};

type HeadingLine = { line: number; level: number; title: string };

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const INSTRUCTION_BLOCKQUOTE = /^\s*>\s*(?:(?:请|請)?(?:填写|填寫|说明|說明|提示)|模板使用|使用说明|使用說明|instructions?|guidance|how to use)/iu;
const INSTRUCTION_PARENTHESIZED = /^\s*[（(]\s*(?:填写|填寫|说明|說明|提示|模板).*[)）]\s*$/u;

const normalizeHeading = (value: string) =>
  value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();

function scanHeadings(markdown: string) {
  const lines = markdown.split("\n");
  const headings: HeadingLine[] = [];
  let fence: string | null = null;
  for (let line = 0; line < lines.length; line++) {
    const current = lines[line] ?? "";
    const fenceMatch = FENCE.exec(current);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) fence = marker;
      else if (marker[0] === fence[0]) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = HEADING.exec(current);
    if (heading) {
      headings.push({ line, level: heading[1]!.length, title: heading[2]!.trim() });
    }
  }
  return { lines, headings };
}

function sectionEnd(headings: HeadingLine[], index: number, lineCount: number) {
  const level = headings[index]!.level;
  for (let next = index + 1; next < headings.length; next++) {
    if (headings[next]!.level <= level) return headings[next]!.line;
  }
  return lineCount;
}

function dropTrailingBlankLines(lines: string[], keep: number) {
  const result = [...lines];
  while (result.length > keep && !result[result.length - 1]!.trim()) result.pop();
  return result;
}

function spliceSection(
  lines: string[],
  heading: HeadingLine,
  end: number,
  body: string,
  mode: NoteSectionMode,
) {
  const insert = body.trim() ? body.trim().split("\n") : [];
  const head = mode === "replace"
    ? dropTrailingBlankLines(lines.slice(0, heading.line + 1), heading.line + 1)
    : dropTrailingBlankLines(lines.slice(0, end), heading.line + 1);
  const tail = lines.slice(end);
  const result = [...head];
  if (insert.length) result.push("", ...insert);
  if (tail.length) result.push("", ...tail);
  return result.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** 对章节做一次或多次有序编辑；每次编辑都重新定位，避免行号漂移。 */
export function applyNoteSectionOperations(markdown: string, operations: NoteSectionOperation[]): string {
  let current = markdown;
  for (const operation of operations) {
    const heading = typeof operation?.heading === "string" ? operation.heading.trim() : "";
    const mode = operation?.mode;
    if (!heading) throw new AppError("invalid_params", "Each section operation needs a heading.", 400);
    if (mode !== "append" && mode !== "replace") {
      throw new AppError("invalid_params", 'Section mode must be "append" or "replace".', 400);
    }
    if (typeof operation.contentMarkdown !== "string") {
      throw new AppError("invalid_params", "Each section operation needs contentMarkdown.", 400);
    }
    const { lines, headings } = scanHeadings(current);
    const matches = headings.filter(item => normalizeHeading(item.title) === normalizeHeading(heading));
    // 章节问题必须让客户端能改对目标，而不是退回整篇重写。
    const availableHeadings = [...new Set(headings.map(item => item.title))];
    if (!matches.length) {
      throw new AppError(
        "section_not_found",
        `Section "${heading}" was not found in this note.`,
        409,
        { heading, availableHeadings },
      );
    }
    if (matches.length > 1) {
      throw new AppError(
        "section_ambiguous",
        `Section "${heading}" matches ${matches.length} headings. Make the heading unique before editing; the note was not changed.`,
        409,
        { heading, matchCount: matches.length, availableHeadings },
      );
    }
    const target = matches[0]!;
    const targetIndex = headings.indexOf(target);
    const end = sectionEnd(headings, targetIndex, lines.length);
    // 追加到该章节自身的正文末尾：有子标题时放在第一个子标题之前，避免内容落入子章节。
    const firstChild = headings.slice(targetIndex + 1).find(item => item.line < end);
    const boundary = mode === "append" ? firstChild?.line ?? end : end;
    current = spliceSection(lines, target, boundary, operation.contentMarkdown, mode);
  }
  return current;
}

export type NoteInsertAnchor =
  | { section: string; position?: "start" | "end" }
  | { afterText: string }
  | { beforeText: string };

/**
 * 在指定章节或正文锚点插入一段内容（用于把附件放到目标位置）。
 * 定位失败时返回可选章节，绝不退回追加到文末。
 */
export function insertMarkdownAtAnchor(markdown: string, anchor: NoteInsertAnchor, content: string): string {
  const body = content.trim();
  if (!body) throw new AppError("invalid_params", "Inserted content is empty.", 400);
  const lines = markdown.split("\n");

  if ("afterText" in anchor || "beforeText" in anchor) {
    const needle = ("afterText" in anchor ? anchor.afterText : anchor.beforeText).trim();
    if (!needle) throw new AppError("invalid_params", "Anchor text is empty.", 400);
    const matches = lines
      .map((line, index) => (line.includes(needle) ? index : -1))
      .filter(index => index >= 0);
    if (!matches.length) {
      throw new AppError(
        "anchor_not_found",
        `Anchor text "${needle}" was not found in this note.`,
        409,
        { anchors: { afterText: "afterText" in anchor ? needle : undefined, beforeText: "beforeText" in anchor ? needle : undefined } },
      );
    }
    if (matches.length > 1) {
      throw new AppError(
        "anchor_ambiguous",
        `Anchor text "${needle}" appears ${matches.length} times. Use a unique section heading instead.`,
        409,
        { matchCount: matches.length },
      );
    }
    const index = matches[0]!;
    const insertAt = "afterText" in anchor ? index + 1 : index;
    const result = [...lines.slice(0, insertAt), "", ...body.split("\n"), ...lines.slice(insertAt)];
    return result.join("\n").replace(/\n{3,}/g, "\n\n");
  }

  const { headings } = scanHeadings(markdown);
  const matches = headings.filter(item => normalizeHeading(item.title) === normalizeHeading(anchor.section));
  const availableHeadings = [...new Set(headings.map(item => item.title))];
  if (!matches.length) {
    throw new AppError(
      "section_not_found",
      `Section "${anchor.section}" was not found in this note.`,
      409,
      { heading: anchor.section, availableHeadings },
    );
  }
  if (matches.length > 1) {
    throw new AppError(
      "section_ambiguous",
      `Section "${anchor.section}" matches ${matches.length} headings. Make the heading unique before inserting.`,
      409,
      { heading: anchor.section, matchCount: matches.length, availableHeadings },
    );
  }
  const target = matches[0]!;
  const targetIndex = headings.indexOf(target);
  const end = sectionEnd(headings, targetIndex, lines.length);
  const insertAt = anchor.position === "start" ? target.line + 1 : end;
  const result = [...lines.slice(0, insertAt), "", ...body.split("\n"), ...lines.slice(insertAt)];
  return result.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** 去掉模板填写说明、HTML 注释和没有任何正文的空章节，保留完整有效内容。 */
export function cleanTemplateMarkdown(markdown: string) {
  const withoutComments = markdown.replace(/<!--[\s\S]*?-->/g, "");
  const lines = withoutComments
    .split("\n")
    .filter(line => !INSTRUCTION_BLOCKQUOTE.test(line) && !INSTRUCTION_PARENTHESIZED.test(line));
  const { headings } = scanHeadings(lines.join("\n"));
  const remove = new Set<number>();
  headings.forEach((heading, index) => {
    const start = heading.line;
    const end = sectionEnd(headings, index, lines.length);
    const hasBody = lines.slice(start + 1, end).some(line => line.trim() && !HEADING.test(line));
    if (hasBody) return;
    for (let line = start; line < end; line++) remove.add(line);
  });
  return lines
    .filter((_line, index) => !remove.has(index))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

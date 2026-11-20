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
    if (!matches.length) {
      throw new AppError("section_not_found", `Section "${heading}" was not found in this note.`, 409);
    }
    if (matches.length > 1) {
      throw new AppError(
        "section_ambiguous",
        `Section "${heading}" matches ${matches.length} headings. Make the heading unique before editing; the note was not changed.`,
        409,
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

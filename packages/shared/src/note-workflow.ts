/**
 * AI 对话沉淀与章节更新的共用契约。
 * 主 Agent 维护；模板名称、标签、标题格式和章节操作类型由这里统一，
 * 避免前端、HTTP 路由、MCP 与子 Agent 各自定义一套。
 */

export const AI_CONVERSATION_TEMPLATE_NAME = "AI 对话通用模板";
export const AI_NOTE_TAG = "AI沉淀";
export const AI_CONVERSATION_TEMPLATE_TAGS = ["ai-conversation", AI_NOTE_TAG] as const;
export const AI_NOTE_TITLE_SEPARATOR = "｜";

/**
 * 必选章节：结论、关键步骤／依据、验证结果、来源／链接。
 * 背景、适用条件、下一步、待验证按内容选用，不预设空章节。
 */
export const AI_CONVERSATION_TEMPLATE_MARKDOWN = [
  "## 结论",
  "",
  "## 关键步骤 / 依据",
  "",
  "## 验证结果",
  "",
  "## 来源 / 链接",
  "",
].join("\n");

export const AI_CONVERSATION_TEMPLATE_HEADINGS = [
  "结论",
  "关键步骤 / 依据",
  "验证结果",
  "来源 / 链接",
] as const;

export const ATTACHMENT_SUMMARY_HEADING = "附件汇总";

export type NoteSectionMode = "append" | "replace";

export type NoteSectionOperation = {
  heading: string;
  mode: NoteSectionMode;
  contentMarkdown: string;
};

export type MarkdownHeading = { level: number; title: string };

const HEADING_LINE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;

/** 列出正文中的 Markdown 标题（跳过代码围栏），供章节选择器使用。 */
export function listMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = FENCE_LINE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) fence = marker;
      else if (marker[0] === fence[0]) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = HEADING_LINE.exec(line);
    if (heading) headings.push({ level: heading[1]!.length, title: heading[2]!.trim() });
  }
  return headings;
}

/** 创建时遇到同题笔记的处理方式；ask 由界面让用户明确选择。 */
export type AiNoteDuplicateResolution = "ask" | "supplement" | "new";

const compact = (value: string | null | undefined) =>
  (value ?? "").replace(/\s+/g, " ").trim();

/**
 * 默认标题「对象｜主题」。缺少一侧时只保留另一侧；两侧都没有时使用兜底，
 * 保证标题非空且不超过笔记标题上限（160 字符）。
 */
export function buildAiNoteTitle(input: {
  object?: string | null;
  topic?: string | null;
  fallback?: string;
  limit?: number;
}): string {
  const limit = input.limit ?? 160;
  const object = compact(input.object).replaceAll(AI_NOTE_TITLE_SEPARATOR, " ").trim();
  const topic = compact(input.topic).replaceAll(AI_NOTE_TITLE_SEPARATOR, " ").trim();
  const title = object && topic
    ? `${object}${AI_NOTE_TITLE_SEPARATOR}${topic}`
    : object || topic || compact(input.fallback) || "AI 对话";
  return title.slice(0, limit);
}

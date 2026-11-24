/**
 * AI 对话沉淀的正文与标题规则：内置助手保存回答与 MCP 保存对话共用。
 * 只负责把一段问答整理成模板结构，不读库、不决定归属。
 */
import {
  AI_CONVERSATION_TEMPLATE_HEADINGS,
  AI_NOTE_TITLE_SEPARATOR,
  buildAiNoteTitle,
  listMarkdownHeadings,
} from "@edgeever/shared";

export const SOURCE_HEADING = AI_CONVERSATION_TEMPLATE_HEADINGS[3];
export const CONCLUSION_HEADING = AI_CONVERSATION_TEMPLATE_HEADINGS[0];
export const STEPS_HEADING = AI_CONVERSATION_TEMPLATE_HEADINGS[1];
export const VERIFICATION_HEADING = AI_CONVERSATION_TEMPLATE_HEADINGS[2];
/** Title subject when the conversation is not bound to a note. */
export const DEFAULT_AI_NOTE_OBJECT = "AI 对话";

export const normalizeHeading = (value: string) =>
  value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();

const TEMPLATE_HEADINGS = new Set(AI_CONVERSATION_TEMPLATE_HEADINGS.map(normalizeHeading));
const SOURCE_HEADING_KEY = normalizeHeading(SOURCE_HEADING);

/** First line, shortened to its first sentence, is the topic of the request. */
export const questionSummary = (message: string): string => {
  const firstLine = message.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const firstSentence = firstLine.split(/(?<=[。！？!?；;])/u)[0] ?? firstLine;
  const summary = (firstSentence.trim().length >= 8 ? firstSentence : firstLine).replace(/\s+/g, " ").trim();
  return summary.slice(0, 200);
};

export const extractLinks = (text: string): string[] => {
  const matches = text.match(/https?:\/\/[^\s<>"'`）)\]】，。；;]+/gu) ?? [];
  return [...new Set(matches.map((link) => link.replace(/[.,;:!?]+$/u, "")))];
};

/**
 * Fills the shared AI conversation template around a saved answer. An answer
 * that already uses the template headings keeps its own structure and only
 * gains a missing 「来源 / 链接」 section. Otherwise the whole answer text is
 * kept verbatim under 「结论」 — it is never summarized or rewritten.
 */
export const buildAiConversationMarkdown = (input: { message: string; response: string }): string => {
  const response = input.response.trim();
  const headings = listMarkdownHeadings(response);
  const sources = [
    ...new Set([questionSummary(input.message), ...extractLinks(response)].filter(Boolean)),
  ];
  const sourceSection = [`## ${SOURCE_HEADING}`, "", ...sources.map((line) => `- ${line}`)].join("\n").trimEnd();
  if (headings.some((heading) => TEMPLATE_HEADINGS.has(normalizeHeading(heading.title)))) {
    const hasSources = headings.some((heading) => normalizeHeading(heading.title) === SOURCE_HEADING_KEY);
    return hasSources ? response : `${response}\n\n${sourceSection}`;
  }
  return [
    `## ${CONCLUSION_HEADING}`,
    "",
    response,
    "",
    `## ${STEPS_HEADING}`,
    "",
    `## ${VERIFICATION_HEADING}`,
    "",
    sourceSection,
    "",
  ].join("\n");
};

export const appendToEnd = (markdown: string, addition: string) =>
  `${markdown}${markdown.trim() ? "\n\n---\n\n" : ""}${addition}`;

/** 「对象｜主题」标题；对象缺省时回落到 AI 对话，主题取问题首句。 */
export const buildConversationTitle = (input: {
  object?: string | null;
  topic?: string | null;
  fallback?: string;
}) => buildAiNoteTitle({
  object: input.object || DEFAULT_AI_NOTE_OBJECT,
  topic: input.topic,
  fallback: input.fallback ?? DEFAULT_AI_NOTE_OBJECT,
});

export { AI_NOTE_TITLE_SEPARATOR };

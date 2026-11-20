import type { MemoTemplate } from "@edgeever/shared";
import type { DatabaseAdapter } from "../storage/storage-contract";
import { getMemoTemplate, listMemoTemplates } from "../notes/template-routes";
import { AppError } from "../common/app-error";

const purposes = {
  general: { names: ["AI 对话通用模板", "AI 對話通用模板", "AI 对话沉淀", "AI Conversation"], tags: ["ai-conversation"] },
  issue: { names: ["问题报告", "問題報告", "Bug Report", "Issue Report"], tags: ["bug-report"] },
  meeting: { names: ["会议纪要", "會議記錄", "Meeting Minutes"], tags: ["meeting"] },
  progress: { names: ["周报与进展复盘", "週報與進展覆盤", "Weekly Review & Status"], tags: ["weekly-review"] },
  reading: { names: ["深度阅读卡片", "深度閱讀卡片", "Deep Reading Card"], tags: ["reading"] },
  idea: { names: ["灵感速记", "靈感速記", "Quick Spark"], tags: ["quick-note"] },
  goals: { names: ["目标与任务拆解", "目標與任務拆解", "Goals & Task Breakdown"], tags: ["okr"] },
};

export const noteTemplatePurposes = [...Object.keys(purposes), "verbatim"];

export type NoteTemplatePurpose = keyof typeof purposes | "verbatim";

const PURPOSE_SIGNALS: Record<Exclude<keyof typeof purposes, "general">, RegExp> = {
  issue: /bug|错误|錯誤|故障|缺陷|复现|復現|问题报告|問題報告|issue report|stack trace/giu,
  meeting: /会议|會議|纪要|紀要|参会|參會|agenda|meeting minutes|standup/giu,
  progress: /周报|週報|进展|進展|复盘|復盤|周会|週會|weekly|status report/giu,
  reading: /读书|讀書|阅读|閱讀|书摘|書摘|reading notes|book notes/giu,
  idea: /灵感|靈感|想法|点子|點子|\bidea\b|\bspark\b/giu,
  goals: /目标|目標|\bokr\b|任务拆解|任務拆解|\bgoal\b/giu,
};

const countMatches = (value: string, pattern: RegExp) => value.match(pattern)?.length ?? 0;

/** 按标题与正文中的用途信号推断模板；无法确定时用通用模板。 */
export function inferNotePurpose(input: { title?: string; contentMarkdown?: string }): keyof typeof purposes {
  const title = (input.title ?? "").normalize("NFKC");
  const body = (input.contentMarkdown ?? "").slice(0, 4_000).normalize("NFKC");
  let best: { purpose: keyof typeof purposes; score: number } = { purpose: "general", score: 0 };
  for (const [purpose, signal] of Object.entries(PURPOSE_SIGNALS) as [keyof typeof PURPOSE_SIGNALS, RegExp][]) {
    const score = Math.min(countMatches(body, signal), 3) + Math.min(countMatches(title, signal), 2) * 2;
    if (score > best.score) best = { purpose, score };
  }
  return best.score >= 1 ? best.purpose : "general";
}

export async function resolveMcpNoteTemplate(
  db: DatabaseAdapter,
  workspaceId: string,
  input: { templateId?: string; purpose?: string; title?: string; contentMarkdown?: string },
) {
  const inferredPurpose = inferNotePurpose(input);
  const purpose = input.purpose ?? inferredPurpose;
  const selected = await selectMcpNoteTemplate(db, workspaceId, purpose, input.templateId);
  return {
    ...selected,
    purpose: purpose as NoteTemplatePurpose,
    inferredPurpose,
    inferred: input.purpose === undefined && input.templateId === undefined,
  };
}

function matchTemplate(templates: MemoTemplate[], purpose: keyof typeof purposes) {
  const { names, tags } = purposes[purpose];
  const normalize = (value: string) => value.trim().normalize("NFKC").toLowerCase();
  for (const name of names) {
    const matched = templates.find(template => normalize(template.name) === normalize(name));
    if (matched) return matched;
  }
  return templates.find(template => template.tags.some(tag => tags.includes(normalize(tag)))) ?? null;
}

export async function selectMcpNoteTemplate(
  db: DatabaseAdapter,
  workspaceId: string,
  purpose: string,
  templateId?: string,
) {
  if (templateId) {
    const template = await getMemoTemplate(db, workspaceId, templateId);
    if (!template) throw new AppError("not_found", "Template not found", 404);
    return { template, selection: "explicit" };
  }
  if (purpose === "verbatim") return { template: null, selection: "verbatim" };
  if (!Object.hasOwn(purposes, purpose)) {
    throw new AppError("invalid_params", "Unknown note template purpose.", 400);
  }
  const templates = await listMemoTemplates(db, workspaceId);
  const match = matchTemplate(templates, purpose as keyof typeof purposes);
  if (match) return { template: match, selection: purpose };
  const general = purpose === "general" ? null : matchTemplate(templates, "general");
  if (general) return { template: general, selection: "general" };
  return {
    template: null,
    selection: "general",
    guidance: "Write a short conclusion or current status, followed by key content and known sources. Omit empty sections and template instructions.",
  };
}

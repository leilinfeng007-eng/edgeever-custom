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

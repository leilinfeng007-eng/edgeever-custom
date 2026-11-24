/**
 * 笔记归属决策：新建、更新、恢复共用一套「默认留在原处」的规则。
 *
 * - 明确指定的目标笔记本优先。
 * - 未指定时普通更新留在原笔记本；只有显式要求重新分类才移入「等待分类」。
 * - 「移入等待分类」与「启动自动分类」是两件事：自动分类关闭时仍可移入，
 *   只是不会产生分类任务。
 * - 本来就在等待分类的笔记，正文变化仍会重新排队，保持既有行为。
 * 只返回决策，不写库；调用方负责把决策翻译成批次语句。
 */

export type MemoPlacementKind = "explicit_move" | "reclassify" | "inbox_edit" | "keep";

export type MemoPlacement = {
  /** 目标笔记本；保持原处时等于当前笔记本。 */
  notebookId: string;
  /** 笔记本是否真的改变。 */
  moved: boolean;
  /** 是否创建/刷新分类任务；自动分类关闭时恒为 false。 */
  queueClassification: boolean;
  /** 是否记录「已明确归属」的保留标记，避免后续自动分类改动位置。 */
  hold: boolean;
  kind: MemoPlacementKind;
};

export function resolveMemoPlacement(input: {
  currentNotebookId: string;
  /** 工作区没有可用的等待分类笔记本时为 null；此时无法移入或排队。 */
  inboxId: string | null;
  /** autoClassify === true 表示调用方明确要求重新分类。 */
  reclassify?: boolean;
  /** autoClassify === false 表示调用方明确要求保留当前位置。 */
  retain?: boolean;
  requestedNotebookId?: string | null;
  classifyEnabled: boolean;
  contentChanged: boolean;
  /** 该笔记带「用户明确留在等待分类」的保留标记。 */
  inboxHold?: boolean;
}): MemoPlacement {
  const inboxId = input.inboxId;
  const currentIsInbox = Boolean(inboxId) && input.currentNotebookId === inboxId;
  const requested = input.requestedNotebookId?.trim() || null;

  if (requested && requested !== input.currentNotebookId) {
    const targetIsInbox = Boolean(inboxId) && requested === inboxId;
    return {
      notebookId: requested,
      moved: true,
      queueClassification: targetIsInbox && input.classifyEnabled,
      // 离开收件箱就已经是明确归属，自动分类不会再改动它。
      hold: false,
      kind: "explicit_move",
    };
  }

  if (input.reclassify && inboxId) {
    return {
      notebookId: inboxId,
      moved: !currentIsInbox,
      queueClassification: input.classifyEnabled,
      hold: false,
      kind: "reclassify",
    };
  }

  if (input.retain) {
    return {
      notebookId: input.currentNotebookId,
      moved: false,
      queueClassification: false,
      hold: currentIsInbox,
      kind: "keep",
    };
  }

  if (currentIsInbox && inboxId && input.contentChanged) {
    return {
      notebookId: inboxId,
      moved: false,
      // 收件箱里的编辑只有在没有手动保留标记时才重新排队。
      queueClassification: input.classifyEnabled && !input.inboxHold,
      hold: false,
      kind: "inbox_edit",
    };
  }

  return {
    notebookId: input.currentNotebookId,
    moved: false,
    queueClassification: false,
    hold: false,
    kind: "keep",
  };
}

/** 写入成功后向客户端报告的位置结果。 */
export const describePlacement = (placement: MemoPlacement) => ({
  moved: placement.moved,
  classificationQueued: placement.queueClassification,
  placement: placement.kind,
});

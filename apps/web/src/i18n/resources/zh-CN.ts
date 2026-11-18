import { zhCN as sharedCatalog } from "@edgeever/shared/i18n/zh-CN";

export const zhCN = {
  ...sharedCatalog,
  inboxClassification: {
    title: "自动分类", selectNote: "选择一篇笔记查看分类状态", loading: "正在查询状态", statusFailed: "暂时无法读取分类状态",
    idle: "尚未提交分类", pending: "已排队，等待分类", running: "正在判断笔记归属", moved: "已归入「{{name}}」",
    suggested: "建议归入「{{name}}」，等待确认", retained: "保留在等待分类", apply: "采用建议", start: "开始分类",
    retry: "重新分类", undo: "移回等待分类", actionFailed: "未能执行此操作，请刷新后再试。",
    outcomes: {
      invalid_model_response: "模型返回格式有误，可以重新分类",
      model_empty_output: "模型未返回内容", model_truncated: "模型输出被截断",
      model_json_invalid: "模型输出无法解析", model_fields_invalid: "模型返回字段或目标不符合要求",
      model_auth_failed: "模型服务鉴权失败", model_request_rejected: "模型服务拒绝了分类请求",
      model_not_configured: "EdgeEver 未配置默认模型", classification_failed: "模型请求失败或超时",
      no_destination: "没有可用的目标笔记本", invalid_destination: "目标笔记本已不可用",
      empty_body: "正文为空，补充正文后可重新分类", unclear: "归属不明确",
      source_updated: "分类期间笔记有更新", source_changed: "笔记状态有变化", source_or_destination_changed: "笔记或目标已有变化",
      review_recommended: "归类建议已变更，请重新分类", undone: "已移回等待分类",
    },
  },
  attachmentText: {
    action: "查看附件正文", loading: "正在读取正文", next: "继续读取", empty: "附件没有可提取的正文", failed: "无法读取附件正文。",
    errors: { attachment_format_unsupported: "此格式暂不支持正文预览。", attachment_too_large: "附件超过正文预览大小上限。",
      attachment_invalid_docx: "Word 文档损坏或已加密。", attachment_invalid_text: "附件不是 UTF-8 文本。" },
  },
} as const;

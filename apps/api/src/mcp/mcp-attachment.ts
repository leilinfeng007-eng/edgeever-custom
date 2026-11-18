/**
 * 附件工具协议适配：校验 memoId/resourceId，将共用读取结果转为 MCP 内容块。
 * 实际对象读取、大小限制与 Word 提取在 attachments/attachment-content，不在此重复实现。
 */
import type { Bindings } from "../api-context";
import { readAttachmentContent } from "../attachments/attachment-content";
import { encodeBase64Data, getRequiredString } from "./mcp-json-rpc";

type McpAttachmentContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

type McpAttachmentResult = {
  attachment: { id: string; memoId: string; filename: string | null; mimeType: string; byteSize: number };
  format: "text" | "image" | "original";
  nextOffset?: number | null;
  totalCharacters?: number;
  contentBlock: McpAttachmentContent;
};

// content 模式：白名单图片返回 image/base64；Word/文本返回分页 text；original 返回原始 resource/blob。
// 图片/原文件各限 2 MiB，Word 8 MiB（正文 XML 解压限 2 MiB），文本 1 MiB；每页最多 12,000 UTF-16 单元。
// 读取必须同时匹配工作区、笔记和资源；不支持/超限/损坏直接抛业务错误，不自动换模式。
export async function readMcpAttachment(env: Bindings, workspaceId: string, args: Record<string, unknown>): Promise<McpAttachmentResult> {
  const memoId = getRequiredString(args.memoId, "memoId");
  const resourceId = getRequiredString(args.resourceId, "resourceId");
  const result = await readAttachmentContent(env, workspaceId, { ...args, memoId, resourceId });
  if (result.format === "image") {
    const { data, ...metadata } = result;
    return { ...metadata, contentBlock: { type: "image", mimeType: result.attachment.mimeType, data: encodeBase64Data(data) } };
  }
  if (result.format === "original") {
    const { data, ...metadata } = result;
    const uri = `edgeever://attachment/${encodeURIComponent(result.attachment.id)}`;
    return { ...metadata, contentBlock: { type: "resource", resource: { uri, mimeType: result.attachment.mimeType, blob: encodeBase64Data(data) } } };
  }
  const { text, ...metadata } = result;
  return { ...metadata, contentBlock: { type: "text", text } };
}

export function formatMcpAttachment(name: string, result: unknown) {
  if (name !== "read_memo_attachment" || !result || typeof result !== "object" || !("contentBlock" in result)) return null;
  const { contentBlock, ...metadata } = result as McpAttachmentResult;
  return {
    contentBlock,
    metadata: contentBlock.type === "text" ? { ...metadata, text: contentBlock.text } : metadata,
  };
}

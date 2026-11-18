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

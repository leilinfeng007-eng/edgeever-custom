import { getResourceIdFromUrl, markdownToDoc, type TiptapNode, type TiptapTextNode } from "@edgeever/shared";
import type { AppContext, AuthContext } from "../api-context";
import type { DatabaseAdapter } from "../storage/storage-contract";
import {
  consumePendingResourceUpload,
  createPendingResourceUpload,
  type PendingResourceUploadInput,
} from "../attachments/pending-resource-service";
import { AppError } from "../common/app-error";
import { decodeBase64Data } from "./mcp-json-rpc";

const MAX_MCP_RESOURCE_BYTES = 2 * 1024 * 1024;

export async function stageMemoResource(
  context: AppContext,
  auth: AuthContext,
  input: Omit<PendingResourceUploadInput, "byteSize">,
  base64: string,
) {
  if (base64.length > Math.ceil(MAX_MCP_RESOURCE_BYTES / 3) * 4 + 256) {
    throw new AppError("upload_too_large", "Inline MCP uploads accept up to 2 MiB. Use create_resource_upload_url for larger files.", 413);
  }
  const bytes = await decodeBase64Data(base64);
  if (bytes.byteLength > MAX_MCP_RESOURCE_BYTES) {
    throw new AppError("upload_too_large", "Inline MCP uploads accept up to 2 MiB. Use create_resource_upload_url for larger files.", 413);
  }
  const upload = await createPendingResourceUpload(context, auth, {
    ...input,
    label: input.kind === "attachment" ? `附件：${input.label ?? input.filename ?? "file"}` : input.label,
    byteSize: bytes.byteLength,
  });
  const { body } = await consumePendingResourceUpload(context, {
    authorization: upload.headers.Authorization,
    contentType: upload.headers["Content-Type"],
    contentLength: String(bytes.byteLength),
    body: new Response(bytes).body,
  });
  return body;
}

function referencedResources(doc: TiptapNode) {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value.startsWith("/api/v1/resources/")) return;
    const id = getResourceIdFromUrl(value);
    if (id) ids.add(id);
  };
  function visit(node: TiptapNode | TiptapTextNode) {
    if ("marks" in node) for (const mark of node.marks ?? []) add(mark.attrs?.href);
    if ("attrs" in node) {
      add(node.attrs?.src);
      add(node.attrs?.url);
    }
    if ("content" in node) for (const child of node.content ?? []) visit(child);
  }
  visit(doc);
  return ids;
}

function referenceCounts(doc: TiptapNode) {
  const counts = new Map<string, number>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value.startsWith("/api/v1/resources/")) return;
    const id = getResourceIdFromUrl(value);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  function visit(node: TiptapNode | TiptapTextNode) {
    if ("marks" in node) for (const mark of node.marks ?? []) add(mark.attrs?.href);
    if ("attrs" in node) {
      add(node.attrs?.src);
      add(node.attrs?.url);
    }
    if ("content" in node) for (const child of node.content ?? []) visit(child);
  }
  visit(doc);
  return counts;
}

/** Check references on the parsed document so examples inside code fences do not count. */
export async function validateMcpResourcePlacement(
  db: DatabaseAdapter,
  workspaceId: string,
  markdown: string,
  pendingIds: string[],
  existing?: { id: string; contentMarkdown: string; allowRemoval: boolean; allowDuplicateReferences?: boolean },
) {
  if (!pendingIds.length && (!existing || existing.allowRemoval)) return;
  const referenced = referencedResources(markdownToDoc(markdown));
  for (const id of pendingIds) {
    if (!referenced.has(id)) {
      throw new AppError("attachment_position_required", `Insert the returned Markdown for resource ${id} in its intended section.`, 400);
    }
  }
  if (!existing) return;
  if (!existing.allowDuplicateReferences) {
    const before = referenceCounts(markdownToDoc(existing.contentMarkdown));
    for (const [id, count] of referenceCounts(markdownToDoc(markdown))) {
      const previous = before.get(id) ?? 0;
      if (previous > 0 && count > previous) {
        throw new AppError(
          "attachment_duplicate_reference",
          `Resource ${id} is already referenced in this note. Keep one reference or explicitly allow duplicate references.`,
          409,
        );
      }
    }
  }
  if (existing.allowRemoval) return;
  const removed = [...referencedResources(markdownToDoc(existing.contentMarkdown))].filter(id => !referenced.has(id));
  if (!removed.length) return;
  const chunk = removed.slice(0, 80);
  const bound = await db.prepare(
    `SELECT r.id FROM resources r JOIN memos m ON r.memo_id = m.id
     WHERE m.workspace_id = ? AND r.memo_id = ? AND r.is_deleted = 0 AND r.id IN (${chunk.map(() => "?").join(",")}) LIMIT 1`,
  ).bind(workspaceId, existing.id, ...chunk).first<{ id: string }>();
  if (bound || removed.length > chunk.length) {
    throw new AppError("attachment_reference_removed", "Keep existing attachment references in their sections or explicitly allow their removal.", 409);
  }
}

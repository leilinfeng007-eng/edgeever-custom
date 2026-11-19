/** Keep binary tool output out of JSON text presented to the language model. */
export function companionAttachmentModelOutput(output: unknown) {
  const value = output as { attachment?: unknown; url?: string; format?: string; contentBlock?: { type: string; mimeType?: string; data?: string; text?: string } } | null;
  const block = value?.contentBlock;
  if (value?.format === "image" && block?.type === "image" && block.mimeType?.startsWith("image/") && typeof block.data === "string") {
    return { type: "content" as const, value: [
      { type: "text" as const, text: JSON.stringify({ attachment: value.attachment, url: value.url, format: "image" }) },
      { type: "file" as const, mediaType: block.mimeType, data: { type: "data" as const, data: block.data } },
    ] };
  }
  return { type: "text" as const, value: JSON.stringify(output) ?? "null" };
}

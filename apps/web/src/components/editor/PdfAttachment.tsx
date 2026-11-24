import {
  getAttachmentFilenameFromLabel,
  PdfAttachment as BasePdfAttachment,
  resolvePdfDisplayMode,
} from "@edgeever/shared";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { PdfViewer } from "@/components/pdf/PdfViewer";
import { AttachmentSourceLine } from "./FileAttachment";

const PdfAttachmentNodeView = ({ node, updateAttributes }: NodeViewProps) => {
  const url = typeof node.attrs.url === "string" ? node.attrs.url : "";
  const label = typeof node.attrs.label === "string" ? node.attrs.label : "PDF";
  const filename = typeof node.attrs.filename === "string" && node.attrs.filename
    ? node.attrs.filename
    : getAttachmentFilenameFromLabel(label);
  const displayMode = resolvePdfDisplayMode(node.attrs.displayMode);
  const source = typeof node.attrs.source === "string" ? node.attrs.source : "";

  return (
    <NodeViewWrapper
      as="span"
      className="edgeever-pdf-attachment-node"
      data-file-name={filename || label}
      data-file-url={url}
      contentEditable={false}
    >
      <PdfViewer
        url={url}
        label={label}
        filename={typeof node.attrs.filename === "string" ? node.attrs.filename : undefined}
        byteSize={node.attrs.byteSize}
        expanded={displayMode === "inline"}
        onExpandedChange={(expanded) => updateAttributes({ displayMode: expanded ? "inline" : "compact" })}
      />
      {/* 来源行放在预览卡片下方：紧凑/展开模式都可见，长文本截断。 */}
      <span className="mt-0.5 flex min-w-0 items-center px-1">
        <AttachmentSourceLine
          value={source}
          onCommit={(next) => updateAttributes({ source: next })}
        />
      </span>
    </NodeViewWrapper>
  );
};

export const PdfAttachment = BasePdfAttachment.extend({
  addNodeView() {
    return ReactNodeViewRenderer(PdfAttachmentNodeView);
  },
});

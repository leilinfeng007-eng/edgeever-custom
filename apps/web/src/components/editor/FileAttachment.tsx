import {
  FileAttachment as BaseFileAttachment,
  formatAttachmentMetadata,
  getAttachmentFilenameFromLabel,
  resolveAttachmentKind,
  resolveFileDisplayMode,
} from "@edgeever/shared";
import { useContext, useState } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { ChevronDown, ChevronUp, Download, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AttachmentExternalLink } from "@/components/attachments/AttachmentExternalLink";
import { AttachmentFileIcon } from "@/components/attachments/AttachmentFileIcon";
import { AudioAttachmentPlayer } from "@/components/attachments/AudioAttachmentPlayer";
import { DocxAttachmentPreview } from "@/components/attachments/DocxAttachmentPreview";
import { COMPACT_ATTACHMENT_WIDTH_CLASS } from "@/components/attachments/attachment-layout";
import { isPreviewableDocx, MAX_INLINE_DOCX_BYTES } from "@/components/attachments/docx-preview-source";
import { VideoAttachmentPlayer } from "@/components/attachments/VideoAttachmentPlayer";
import { ButtonTooltip } from "@/components/ui/button-tooltip";
import { useAttachmentByteSize } from "@/hooks/useAttachmentByteSize";
import { isDesktopResourceRuntime, toApiResourceUrl, toDesktopResourceDownloadUrl } from "@/lib/desktop-resources";
import { cn } from "@/lib/utils";
import { AttachmentTranscriptContext } from "./AttachmentTranscriptContext";
import { AttachmentTranscriptInline } from "./AttachmentTranscriptInline";

const FileAttachmentNodeView = ({ node, updateAttributes }: NodeViewProps) => {
  const { t } = useTranslation();
  const [viewerElement, setViewerElement] = useState<HTMLSpanElement | null>(null);
  const [docxExpanded, setDocxExpanded] = useState(false);
  const transcriptContext = useContext(AttachmentTranscriptContext);
  const activeTranscript = transcriptContext?.transcript?.target.element
    && viewerElement?.contains(transcriptContext.transcript.target.element)
    ? transcriptContext.transcript : null;
  const url = typeof node.attrs.url === "string" ? node.attrs.url : "";
  const label = typeof node.attrs.label === "string" ? node.attrs.label : "Attachment";
  const filename = typeof node.attrs.filename === "string" && node.attrs.filename
    ? node.attrs.filename
    : getAttachmentFilenameFromLabel(label);
  const mimeType = typeof node.attrs.mimeType === "string" ? node.attrs.mimeType : "";
  // Keep the stored label untouched, but never show the system "Attachment:" prefix.
  const displayName = filename || label;
  const resolvedUrl = isDesktopResourceRuntime() ? url : toApiResourceUrl(url);
  const downloadUrl = toDesktopResourceDownloadUrl(resolvedUrl, displayName);
  const byteSize = useAttachmentByteSize(resolvedUrl, node.attrs.byteSize);
  const metadata = formatAttachmentMetadata(mimeType, displayName, byteSize);
  const attachmentKind = resolveAttachmentKind(mimeType, displayName);
  const isAudio = attachmentKind === "audio";
  const isVideo = attachmentKind === "video";
  const isDocx = isPreviewableDocx(displayName, resolvedUrl);
  const docxPreviewAllowed = isDocx && (byteSize === null || byteSize <= MAX_INLINE_DOCX_BYTES);
  const videoExpanded = isVideo && resolveFileDisplayMode(node.attrs.displayMode) === "inline";
  const expandable = isVideo || docxPreviewAllowed;
  const expanded = isVideo ? videoExpanded : docxExpanded;
  const setVideoExpanded = (expanded: boolean) => {
    updateAttributes({ displayMode: expanded ? "inline" : "compact" });
  };
  const toggleExpanded = () => isVideo ? setVideoExpanded(!videoExpanded) : setDocxExpanded(!docxExpanded);

  const identity = (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-white/5">
        <AttachmentFileIcon mimeType={mimeType} filename={displayName} className="h-4 w-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] font-semibold text-slate-900 ">{displayName}</span>
        <span className="truncate text-[11px] font-medium text-slate-500 dark:text-slate-400">
          {isDocx && !docxPreviewAllowed ? `${metadata} · ${t("wordViewer.previewTooLarge")}` : metadata}
        </span>
      </span>
    </>
  );

  return (
    <NodeViewWrapper
      as="span"
      className="edgeever-file-attachment-node"
      data-file-name={displayName}
      data-file-url={url}
      contentEditable={false}
    >
      <span ref={setViewerElement} className={cn("edgeever-file-viewer flex min-h-[52px] flex-col overflow-hidden rounded-lg border border-slate-200/90 bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:border-slate-300 dark:border-white/10 dark:hover:border-white/20", COMPACT_ATTACHMENT_WIDTH_CLASS)}>
        <span data-edgeever-resource-toolbar className="flex min-h-[52px] items-center gap-2.5 px-3 py-2">
          {expandable ? (
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
              aria-expanded={expanded}
              onClick={toggleExpanded}
            >
              {identity}
            </button>
          ) : (
            <AttachmentExternalLink
              href={resolvedUrl}
              filename={displayName}
              className="flex min-w-0 flex-1 items-center gap-2 text-left no-underline"
            >
              {identity}
            </AttachmentExternalLink>
          )}
          <ButtonTooltip title={t("editor.resourceActions.download")}>
            <a className="pdf-viewer-action rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10" href={downloadUrl} download={displayName} aria-label={t("editor.resourceActions.download")}>
              <Download aria-hidden="true" />
            </a>
          </ButtonTooltip>
          <ButtonTooltip title={t(isDesktopResourceRuntime() ? "attachmentOpen.copyHint" : "pdfViewer.openExternal")}>
            <AttachmentExternalLink className="pdf-viewer-action rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10" href={resolvedUrl} filename={displayName} iconOnly aria-label={t("pdfViewer.openExternal")}>
              <ExternalLink aria-hidden="true" />
            </AttachmentExternalLink>
          </ButtonTooltip>
          {expandable ? (
            <ButtonTooltip title={expanded ? t("pdfViewer.collapse") : t("pdfViewer.expand")}>
              <button
                type="button"
                className="pdf-viewer-action"
                aria-label={expanded ? t("pdfViewer.collapse") : t("pdfViewer.expand")}
                aria-expanded={expanded}
                onClick={toggleExpanded}
              >
                {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              </button>
            </ButtonTooltip>
          ) : null}
        </span>
        {isAudio && resolvedUrl ? (
          <span className="border-t border-slate-200 px-3 py-2">
            <AudioAttachmentPlayer
              key={resolvedUrl}
              src={resolvedUrl}
              label={t("audioPlayer.label", { filename: displayName })}
              unavailableMessage={t("audioPlayer.unavailable")}
            />
          </span>
        ) : null}
        {isVideo && videoExpanded && resolvedUrl ? (
          <span className="border-t border-slate-200">
            <VideoAttachmentPlayer
              key={resolvedUrl}
              src={resolvedUrl}
              label={t("videoPlayer.label", { filename: displayName })}
              unavailableMessage={t("videoPlayer.unavailable")}
            />
          </span>
        ) : null}
        {docxPreviewAllowed && docxExpanded && resolvedUrl ? (
          <span className="border-t border-slate-200">
            <DocxAttachmentPreview url={resolvedUrl} filename={displayName} />
          </span>
        ) : null}
      </span>
      {activeTranscript && transcriptContext ? (
        <span className={cn("block", COMPACT_ATTACHMENT_WIDTH_CLASS)}>
          <AttachmentTranscriptInline {...transcriptContext} transcript={activeTranscript} />
        </span>
      ) : null}
    </NodeViewWrapper>
  );
};

export const FileAttachment = BaseFileAttachment.extend({
  addNodeView() {
    return ReactNodeViewRenderer(FileAttachmentNodeView);
  },
});

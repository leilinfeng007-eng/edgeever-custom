import {
  FileAttachment as BaseFileAttachment,
  formatAttachmentMetadata,
  formatAttachmentSource,
  formatAttachmentSourceText,
  getAttachmentFilenameFromLabel,
  parseAttachmentSource,
  parseAttachmentSourceOrNull,
  resolveAttachmentKind,
  resolveFileDisplayMode,
} from "@edgeever/shared";
import { useContext, useState } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { ChevronDown, ChevronUp, Download, ExternalLink, Tag } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AttachmentExternalLink } from "@/components/attachments/AttachmentExternalLink";
import { AttachmentFileIcon } from "@/components/attachments/AttachmentFileIcon";
import { AudioAttachmentPlayer } from "@/components/attachments/AudioAttachmentPlayer";
import { DocxAttachmentPreview } from "@/components/attachments/DocxAttachmentPreview";
import { COMPACT_ATTACHMENT_WIDTH_CLASS } from "@/components/attachments/attachment-layout";
import { isPreviewableDocx, MAX_INLINE_DOCX_BYTES } from "@/components/attachments/docx-preview-source";
import { VideoAttachmentPlayer } from "@/components/attachments/VideoAttachmentPlayer";
import { Button } from "@/components/ui/button";
import { ButtonTooltip } from "@/components/ui/button-tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAttachmentByteSize } from "@/hooks/useAttachmentByteSize";
import { isDesktopResourceRuntime, toApiResourceUrl, toDesktopResourceDownloadUrl } from "@/lib/desktop-resources";
import { cn } from "@/lib/utils";
import { AttachmentTranscriptContext } from "./AttachmentTranscriptContext";
import { AttachmentTranscriptInline } from "./AttachmentTranscriptInline";

/**
 * 来源的轻量展示与编辑：一行次要文本 + 点开一个输入框。
 * 只写节点 attrs.source（不调用接口），由编辑器统一保存；留空即清除来源。
 * 文本用 truncate 截断，避免长来源撑破附件卡片。
 */
export const AttachmentSourceLine = ({
  value,
  onCommit,
  className,
}: {
  /** 节点 attrs.source 原文（`formatAttachmentSource` 文本）。 */
  value: string;
  onCommit: (source: string) => void;
  className?: string;
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const normalized = parseAttachmentSourceOrNull(value);
  const display = formatAttachmentSourceText(normalized) ?? "";

  const commit = (raw: string) => {
    const next = formatAttachmentSource(parseAttachmentSource(raw)) ?? "";
    if (next === (formatAttachmentSource(normalized) ?? "")) return;
    onCommit(next);
  };

  return (
    <>
      <button
        type="button"
        className={cn(
          "flex min-w-0 max-w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-200",
          className,
        )}
        aria-label={t(display ? "editor.attachmentSource.edit" : "editor.attachmentSource.add")}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDraft(display);
          setOpen(true);
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <Tag aria-hidden="true" className="h-3 w-3 shrink-0" />
        <span className={cn("truncate", !display && "italic")}>
          {display || t("editor.attachmentSource.add")}
        </span>
      </button>
      <Dialog open={open} onOpenChange={(next) => {
        // 关闭（确认/点外部）时统一落库；重复提交同值不会写脏数据。
        if (!next) commit(draft);
        setOpen(next);
      }}>
        <DialogContent className="max-w-md" onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{t("editor.attachmentSource.dialogTitle")}</DialogTitle>
            <DialogDescription>{t("editor.attachmentSource.dialogDescription")}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={draft}
            placeholder={t("editor.attachmentSource.placeholder")}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => commit(draft)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit(draft);
                setOpen(false);
              }
            }}
          />
          <DialogFooter>
            <Button type="button" size="sm" onClick={() => { commit(draft); setOpen(false); }}>
              {t("editor.attachmentSource.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

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
  const source = typeof node.attrs.source === "string" ? node.attrs.source : "";
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
        {/* 来源行独立于文件名按钮/链接，避免按钮嵌套；长文本在这里截断。 */}
        <span className="flex min-w-0 items-center border-t border-slate-200/70 px-2 py-0.5 dark:border-white/10">
          <AttachmentSourceLine
            value={source}
            onCommit={(next) => updateAttributes({ source: next })}
          />
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

import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, ApiRequestError } from "@/lib/api";

export type AttachmentTextTarget = { memoId: string; resourceId: string; filename: string };

export function AttachmentTextDialog({ target, onClose }: { target: AttachmentTextTarget; onClose: () => void }) {
  const { t } = useTranslation();
  const pages = useInfiniteQuery({
    queryKey: ["attachment-text", target.memoId, target.resourceId],
    queryFn: ({ pageParam, signal }) => api.readAttachmentText(target.memoId, target.resourceId, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    gcTime: 0,
    retry: false,
  });
  const text = pages.data?.pages.map((page) => page.text).join("") ?? "";
  const error = pages.error instanceof ApiRequestError
    ? t(`attachmentText.errors.${pages.error.code ?? "other"}`, { defaultValue: t("attachmentText.failed") })
    : t("attachmentText.failed");

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="w-[calc(100%-1.5rem)] max-w-[46rem]">
        <DialogTitle className="min-w-0 break-words pr-8">{target.filename}</DialogTitle>
        <DialogDescription>{t("attachmentText.action")}</DialogDescription>
        {pages.isPending && <p role="status" className="text-sm text-slate-500">{t("attachmentText.loading")}</p>}
        {pages.isError && <p role="alert" className="text-sm text-rose-600">{error}</p>}
        {pages.data && <div tabIndex={0} className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 p-4 text-sm leading-6 text-slate-800">
          {text || t("attachmentText.empty")}
        </div>}
        {pages.hasNextPage && <Button type="button" size="sm" variant="soft" disabled={pages.isFetchingNextPage}
          onClick={() => void pages.fetchNextPage()}>
          {t(pages.isFetchingNextPage ? "attachmentText.loading" : "attachmentText.next")}
        </Button>}
      </DialogContent>
    </Dialog>
  );
}

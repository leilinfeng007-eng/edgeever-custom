import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";

// Details are fetched on demand; classified notes do not poll in the list.
export function NoteClassificationDetails({ memoId, workspaceKey, open, onOpenChange }: {
  memoId: string; workspaceKey: string; open: boolean; onOpenChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const status = useQuery({
    queryKey: ["inbox-classification", workspaceKey, memoId],
    queryFn: ({ signal }) => api.getInboxClassification(memoId, signal),
    enabled: open,
    staleTime: 0,
    retry: false,
  });
  const data = status.data;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>{t("inboxClassification.details")}</DialogTitle></DialogHeader>
      {status.isError ? <div role="alert" className="space-y-2 text-sm">
        <p>{t("inboxClassification.statusFailed")}</p>
        <Button variant="outline" onClick={() => void status.refetch()}>{t("inboxClassification.reload")}</Button>
      </div> : <div className="space-y-2 text-sm" aria-live="polite">
        <p>{!data ? t("inboxClassification.loading")
          : data.status === "moved" && data.notebookId === data.destinationId
            ? t("inboxClassification.moved", { name: data.destinationName })
            : data.inInbox && data.status && ["pending", "running"].includes(data.status)
              ? t(`inboxClassification.${data.status}`)
              : !data.inInbox ? t("inboxClassification.manualLocation")
              : data.outcome ? t(`inboxClassification.outcomes.${data.outcome}`, { defaultValue: t("inboxClassification.retained") })
                : t("inboxClassification.noRecord")}</p>
        {data?.reason ? <p className="text-slate-500">{data.reason}</p> : null}
        <p className="text-slate-500">{t("inboxClassification.standardMove")}</p>
      </div>}
    </DialogContent>
  </Dialog>;
}

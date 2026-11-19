import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FolderCheck, LoaderCircle, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type Action = "queue" | "apply";

export function InboxClassificationPanel({ inbox, memoId, workspaceKey, onChanged }: {
  inbox: boolean;
  memoId: string | null;
  workspaceKey: string;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const capability = useQuery({
    queryKey: ["inbox-classification-capability", workspaceKey],
    queryFn: api.getInboxClassificationCapability,
    staleTime: 60_000,
    retry: false,
  });
  const enabled = capability.data?.enabled === true;
  const status = useQuery({
    queryKey: ["inbox-classification", workspaceKey, memoId],
    queryFn: ({ signal }) => api.getInboxClassification(memoId!, signal),
    enabled: enabled && inbox && Boolean(memoId),
    refetchInterval: (query) => query.state.data?.inInbox ? 3_000 : false,
    retry: false,
  });
  const data = status.data;
  const active = data?.status === "pending" || data?.status === "running";
  const moved = data?.status === "moved" && data.notebookId === data.destinationId;
  const lastLocation = useRef<{ id: string | null; notebook: string } | null>(null);
  useEffect(() => {
    if (!data) return;
    const previous = lastLocation.current;
    lastLocation.current = { id: memoId, notebook: data.notebookId };
    if (previous?.id === memoId && previous.notebook !== data.notebookId) onChanged();
  }, [data, memoId, onChanged]);
  const action = useMutation({
    mutationFn: (command: Action) => api.runInboxClassificationAction(memoId!, command),
    onSettled: () => { void status.refetch(); },
  });
  if (capability.isError && inbox) return <section className="mt-3 rounded-md border p-3 text-xs" role="alert">
    <p>{t("inboxClassification.statusFailed")}</p>
    <Button type="button" variant="outline" size="sm" onClick={() => void capability.refetch()}>{t("inboxClassification.reload")}</Button>
  </section>;
  if (!enabled || !inbox || (data && !data.inInbox)) return null;

  const summary = active
    ? t(data.status === "pending" ? "inboxClassification.pending" : "inboxClassification.running")
    : moved
      ? t("inboxClassification.moved", { name: data.destinationName })
      : status.isError
        ? t("inboxClassification.statusFailed")
        : data?.canApply
          ? t("inboxClassification.suggested", { name: data.destinationName })
          : data?.outcome
            ? t(`inboxClassification.outcomes.${data.outcome}`, { defaultValue: t("inboxClassification.retained") })
            : t(memoId ? (data ? "inboxClassification.idle" : "inboxClassification.loading") : "inboxClassification.selectNote");

  return (
    <section aria-label={t("inboxClassification.title")}
      className="mt-3 rounded-md border border-[var(--workspace-divider)] bg-card px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        {active ? <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-slate-500" aria-hidden />
          : moved ? <FolderCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
          : <WandSparkles className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-slate-900">{t("inboxClassification.title")}</div>
          <p className="mt-0.5 break-words leading-5 text-slate-600" aria-live="polite">{summary}</p>
          {data?.reason && (moved || data.inInbox) &&
            <p className="break-words leading-5 text-slate-500">{data.reason}</p>}
          {action.isError && <p role="alert" className="leading-5 text-rose-600">{t("inboxClassification.actionFailed")}</p>}
        </div>
      </div>
      {status.isError && <Button type="button" variant="outline" size="sm" onClick={() => void status.refetch()}>{t("inboxClassification.reload")}</Button>}
      {data && !active && data.inInbox && (
        <div className="mt-1.5 flex flex-wrap gap-1.5 pl-6">
          {data.canApply && <Button type="button" variant="soft" size="sm" disabled={action.isPending}
            onClick={() => action.mutate("apply")}>{t("inboxClassification.apply")}</Button>}
          {data.inInbox && <Button type="button" variant={data.canApply ? "ghost" : "soft"} size="sm" disabled={action.isPending}
            onClick={() => action.mutate("queue")}>{t(data.status ? "inboxClassification.retry" : "inboxClassification.start")}</Button>}

        </div>
      )}
    </section>
  );
}

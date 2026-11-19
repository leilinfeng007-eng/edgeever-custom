import type { CompanionTurn } from "@edgeever/shared";
import { useTranslation } from "react-i18next";

export function CompanionRunDetails({ turn }: { turn: CompanionTurn }) {
  const { t } = useTranslation();
  if (!turn.tools.length && !turn.todos.length) return null;
  const failed = turn.tools.filter(tool => tool.status === "error").length;
  return <details className="my-2 rounded-md border border-slate-200 px-2.5 py-2 text-xs">
    <summary className="cursor-pointer text-slate-600" aria-live="polite">
      {t("assistantWorkspace.progress", { count: turn.tools.length })}
      {failed ? ` · ${t("assistantWorkspace.failedSteps", { count: failed })}` : ""}
      {turn.status === "running" ? ` · ${t("assistantWorkspace.executing")}` : ""}
    </summary>
    {turn.todos.length ? <ol className="mt-2 space-y-1">
      {turn.todos.map(todo => <li key={todo.id}>
        {t(`assistantWorkspace.tasks.${todo.status}`)} · {todo.content}
      </li>)}
    </ol> : null}
    <ul className="mt-2 space-y-2">
      {turn.tools.map(tool => <li key={tool.id}>
        <p>{t(`assistantWorkspace.tools.${tool.name}`, { defaultValue: tool.name })} · {t(`assistantWorkspace.states.${tool.status}`)}</p>
        {tool.error ? <p role="alert" className="break-words text-rose-700">{tool.error}</p> : null}
        {tool.status === "done" ? tool.effects.filter(effect => effect.memoId && effect.kind !== "listed").map((effect, index) =>
          <a key={index} className="mr-2 underline" href={`#memo=${encodeURIComponent(effect.memoId!)}`}>
            {effect.title || t("assistantWorkspace.openNote")}
          </a>) : null}
      </li>)}
    </ul>
  </details>;
}

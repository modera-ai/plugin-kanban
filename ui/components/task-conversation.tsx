import { useEffect, useRef } from "react";
import { frontend } from "@modera/plugin-sdk/react";
import { Button, useLabel } from "@modera/ui";
import { Play, Sparkles, Square } from "lucide-react";
import type { BoardData, KanbanTask } from "../../src/types";
import { Clarification, ClarificationHistory } from "./clarification";
import { RunResult } from "./details";
import { ErrorNotice, Status, type Action } from "./shared";

export function TaskConversation({ task, data, locale, busy, error, act, onError }: { task: KanbanTask; data: BoardData; locale: string; busy: boolean; error: string; act: Action; onError(message: string): void }) {
  const t = useLabel();
  const active = task.runs.find(run => run.id === task.activeRunId);
  const followedRun = useRef("");
  useEffect(() => {
    if (active?.state !== "running" || !active.target?.sessionId || active.id === data.conversationRunId || followedRun.current === active.id) return;
    followedRun.current = active.id;
    void frontend().openConversation(active.target.sessionId).catch(cause => onError(String(cause)));
  }, [active?.id, active?.state, active?.target?.sessionId, data.conversationRunId, onError]);
  const idle = !busy && !task.activeRunId && !task.archived && !["done", "cancelled"].includes(task.status) && data.executionAvailable;
  const questions = Boolean(task.analysis?.questions.length);
  const reference = {id: task.id, revision: task.revision};
  return <main className="kb-task-conversation" aria-busy={busy}>
    <header><span className="kb-number">#{task.number}</span><h1>{task.title}</h1><Status value={task.status} /></header>
    <section className="kb-detail-section"><h3>{t("原始需求", "Original requirement")}</h3><p className="kb-raw">{task.originalDescription}</p></section>
    <ErrorNotice message={error} />
    {task.blockReason && (!questions || task.blockReason !== task.analysis?.questions.join("\n")) && <ErrorNotice message={task.blockReason} />}
    {questions && <Clarification key={JSON.stringify([task.id, task.analysis, task.activeRunId])} task={task} disabled={!idle} act={act} />}
    <ClarificationHistory task={task} />
    {task.analysis && <section className="kb-detail-section"><h3>{t("需求分析", "Analysis")}</h3><p className="kb-raw">{task.analysis.goal}</p><p className="kb-raw">{task.analysis.scope}</p><ul className="kb-text-list">{task.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></section>}
    <div className="kb-detail-actions">
      <Button size="small" variant="outline" disabled={!idle} onClick={() => void act("analyze", reference)}><Sparkles size={14} aria-hidden />{t("重新分析", "Reanalyze")}</Button>
      <Button size="small" variant="primary" disabled={!idle || questions || task.status === "in_review" || task.dependencyIds.some(id => data.tasks.find(item => item.id === id)?.status !== "done")} onClick={() => void act("start", reference)}><Play size={14} aria-hidden />{t("执行", "Start")}</Button>
      {active && ["queued", "starting", "running"].includes(active.state) && <Button size="small" variant="outline" disabled={busy} onClick={() => void act("stop", reference)}><Square size={14} aria-hidden />{t("停止", "Stop")}</Button>}
    </div>
    <section className="kb-detail-section"><h3>{t("执行结果", "Run results")}</h3><div className="kb-runs">{[...task.runs].reverse().map(run => <RunResult key={run.id} run={run} locale={locale} onError={onError} />)}</div></section>
  </main>;
}

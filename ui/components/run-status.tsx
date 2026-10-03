import { frontend } from "@modera/plugin-sdk/react";
import { Button, useLabel } from "@modera/ui";
import { LoaderCircle, MessageSquare } from "lucide-react";
import type { KanbanTask, TaskRun } from "../../src/types";
import type { Translate } from "./shared";

export const latestRun = (task: KanbanTask): TaskRun | undefined => task.runs.find(run => run.id === task.activeRunId) ?? task.runs.at(-1);
export const isLive = (run: TaskRun) => ["queued", "starting", "running"].includes(run.state);
export const isWaiting = (run: TaskRun) => isLive(run) && run.waitingForInput === true;
export const needsConversation = (run: TaskRun) => isWaiting(run) || run.awaitingReport === true;
export const phaseName = (run: TaskRun, t: Translate) => ({ analysis: t("分析", "Analysis"), execution: t("执行", "Execution"), review: t("审核", "Review") })[run.phase];
export function runStateName(run: TaskRun, t: Translate) {
  if (isWaiting(run)) return t("等待你的回复", "Waiting for your reply");
  return ({ queued: t("排队中", "Queued"), starting: t("启动中", "Starting"), running: t("执行中", "Running"), paused: t("已暂停", "Paused"), failed: t("失败", "Failed"), interrupted: t("已中断", "Interrupted"), completed: t("对话轮次结束", "Conversation turn finished"), cancelled: t("已取消", "Cancelled") })[run.state];
}

export function ReportStatus({ run }: { run: TaskRun }) {
  const t = useLabel();
  const label = run.awaitingReport ? t("等待任务报告", "Awaiting task report") : run.reportSubmittedAt !== undefined ? t("报告已提交", "Report submitted") : undefined;
  return label ? <span className={`kb-report-state ${run.awaitingReport ? "pending" : "submitted"}`}>{label}</span> : null;
}

export function RunStatus({ run }: { run: TaskRun }) {
  const t = useLabel();
  const waiting = needsConversation(run);
  return <div className={`kb-run-status ${waiting ? "waiting" : run.state}`}>
    {waiting ? <MessageSquare size={13} aria-hidden /> : isLive(run) ? <LoaderCircle size={13} className="mu-spin" aria-hidden /> : <span className="kb-activity-dot" aria-hidden />}
    <span>{phaseName(run, t)} · {runStateName(run, t)}</span>
    <span className="kb-run-role">{run.roleName || run.roleId}</span>
    <ReportStatus run={run} />
  </div>;
}

export function ConversationButton({ run, busy, onError }: { run: TaskRun; busy?: boolean; onError(message: string): void }) {
  const t = useLabel();
  const waiting = needsConversation(run);
  const sessionId = run.target?.sessionId;
  return <Button size="small" variant={waiting || run.state === "running" ? "primary" : "outline"} disabled={busy || !sessionId} onClick={() => {
    if (sessionId) void frontend().openConversation(sessionId).catch(cause => onError(String(cause)));
  }}><MessageSquare size={14} aria-hidden />{t("打开任务对话", "Open task conversation")}</Button>;
}

export function RunNotice({ run, busy, onError }: { run: TaskRun; busy: boolean; onError(message: string): void }) {
  const t = useLabel();
  return <section className={`kb-run-notice${needsConversation(run) ? " waiting" : ""}`} aria-label={t("当前执行", "Current run")}>
    <div role="status"><RunStatus run={run} /></div>
    <ConversationButton run={run} busy={busy} onError={onError} />
    {!run.target?.sessionId && <span className="kb-muted">{t("任务对话暂不可用", "Task conversation unavailable")}</span>}
  </section>;
}

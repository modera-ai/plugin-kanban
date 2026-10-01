import { AlertCircle, ArrowDown, ArrowUp, Equal, ChevronsUp, type LucideIcon } from "lucide-react";
import { Button, Tooltip, useLabel, type ChoiceOption } from "@modera/ui";
import type { AgentRole, BoardData, KanbanTask, TaskInput, TaskStatus, TaskType } from "../../src/types";

export type Translate = (zh: string, en: string) => string;
export type Action = (id: string, payload?: unknown) => Promise<boolean>;
export const taskTypes: TaskType[] = ["requirement", "bug", "debt", "research", "document"];
export const priorities: KanbanTask["priority"][] = ["urgent", "high", "normal", "low"];
export const runningStates = ["queued", "starting", "running"];
export const statusNames = (t: Translate): Record<TaskStatus, string> => ({ backlog: t("待梳理", "Backlog"), todo: t("待办", "To do"), in_progress: t("执行中", "In progress"), in_review: t("待审查", "In review"), done: t("已完成", "Done"), blocked: t("已阻塞", "Blocked"), cancelled: t("已取消", "Cancelled") });
export const typeNames = (t: Translate): Record<TaskType, string> => ({ requirement: t("需求", "Requirement"), bug: t("缺陷", "Bug"), debt: t("技术债", "Tech debt"), research: t("调研", "Research"), document: t("文档", "Document") });
export const priorityNames = (t: Translate): Record<KanbanTask["priority"], string> => ({ urgent: t("紧急", "Urgent"), high: t("高", "High"), normal: t("普通", "Normal"), low: t("低", "Low") });
export const options = (values: readonly string[], names?: Record<string, string>): ChoiceOption[] => values.map(value => ({ value, label: names?.[value] ?? value }));
export function moveOptions(task: KanbanTask, data: BoardData, t: Translate): ChoiceOption[] {
  return options(["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"], statusNames(t)).map(option => ({ ...option, disabled: Boolean(task.activeRunId) || task.archived
    || (option.value === "done" && task.status !== "in_review" && task.status !== "done")
    || (option.value === "in_review" && task.status !== "in_review" && !task.runs.some(run => run.phase === "execution" && run.verdict === "ready_for_review"))
    || (option.value === "in_progress" && (!data.executionAvailable || ["done", "cancelled"].includes(task.status) || Boolean(task.analysis?.questions.length) || task.dependencyIds.some(id => data.tasks.find(item => item.id === id)?.status !== "done"))) }));
}
export const unique = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
export const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
export const pickerOpen = () => Boolean(document.querySelector(".mu-choice-content,.mu-input-suggestion-content"));
export const roleName = (roles: AgentRole[], id: string, t: Translate) => roles.find(role => role.id === id)?.name ?? (id || t("未分配", "Unassigned"));
export function roleOptions(roles: AgentRole[], t: Translate, current = ""): ChoiceOption[] {
  const result = [{ value: "", label: t("未分配", "Unassigned") }, ...roles.map(role => ({ value: role.id, label: role.name, description: role.enabled ? undefined : t("已禁用", "Disabled"), disabled: !role.enabled && role.id !== current }))];
  if (current && !roles.some(role => role.id === current)) result.push({ value: current, label: current });
  return result;
}
export function taskInput(task: KanbanTask): TaskInput {
  const { title, description, type, priority, status, labels, assigneeId, reviewerId, parentId, dependencyIds, iteration, milestone, acceptanceCriteria, automatic } = task;
  return { title, description, type, priority, status, labels: [...labels], assigneeId, reviewerId, parentId, dependencyIds: [...dependencyIds], iteration, milestone, acceptanceCriteria: [...acceptanceCriteria], automatic };
}
export function ErrorNotice({ message }: { message?: string }) {
  return message ? <div className="kb-error" role="alert"><AlertCircle size={16} aria-hidden /><span>{message}</span></div> : null;
}
export function IconButton({ label, icon: Icon, onClick, disabled, active }: { label: string; icon: LucideIcon; onClick(): void; disabled?: boolean; active?: boolean }) {
  return <Tooltip content={label}><Button variant="quiet" size="icon" aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}><Icon size={16} aria-hidden /></Button></Tooltip>;
}
export function Priority({ value }: { value: KanbanTask["priority"] }) {
  const t = useLabel(), Icon = ({ urgent: ChevronsUp, high: ArrowUp, normal: Equal, low: ArrowDown })[value];
  return <span className={`kb-priority ${value}`} title={priorityNames(t)[value]}><Icon size={14} aria-hidden /><span>{priorityNames(t)[value]}</span></span>;
}
export function Status({ value }: { value: TaskStatus }) {
  const t = useLabel();
  return <span className={`kb-status ${value}`}><i aria-hidden />{statusNames(t)[value]}</span>;
}

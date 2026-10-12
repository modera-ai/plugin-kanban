import { useState } from "react";
import { Button, Combobox, Dialog, Input, MultiSelect, Textarea, ToggleRow, useLabel } from "@modera/ui";
import { CheckIcon as Check } from "@phosphor-icons/react/dist/csr/Check";
import { CopyIcon as Copy } from "@phosphor-icons/react/dist/csr/Copy";
import { PencilIcon as Pencil } from "@phosphor-icons/react/dist/csr/Pencil";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { FloppyDiskIcon as Save } from "@phosphor-icons/react/dist/csr/FloppyDisk";
import { TrashIcon as Trash2 } from "@phosphor-icons/react/dist/csr/Trash";
import { UsersIcon as Users } from "@phosphor-icons/react/dist/csr/Users";
import { statuses, type AgentRole, type BoardData, type BoardSettings, type KanbanTask, type ModelSelection, type TaskInput } from "../../src/types";
import { ErrorNotice, IconButton, lines, options, pickerOpen, priorities, priorityNames, roleOptions, taskInput, taskTypes, typeNames, unique, statusNames, type Action } from "./shared";

type ModelGroup = { profileId: string; name: string; models: string[]; efforts?: Readonly<Record<string, readonly ModelSelection["reasoningEffort"][]>> };
const efforts: ModelSelection["reasoningEffort"][] = ["none", "minimal", "low", "medium", "high", "xhigh"];
function availableEfforts(models: ModelGroup[], profileId: string, model: string) {
  return models.find(group => group.profileId === profileId)?.efforts?.[model] ?? efforts;
}
function ModelFields({ value, models, onChange, disabled }: { value?: ModelSelection; models: ModelGroup[]; onChange(value?: ModelSelection): void; disabled: boolean }) {
  const t = useLabel();
  const choices = models.flatMap(group => group.models.map(model => ({ value: JSON.stringify([group.profileId, model]), label: model, group: group.name })));
  const selectionKey = value ? JSON.stringify([value.profileId, value.model]) : "";
  if (value && !choices.some(choice => choice.value === selectionKey)) choices.push({ value: selectionKey, label: value.model, group: t("当前配置", "Current selection") });
  const effortOptions = value ? availableEfforts(models, value.profileId, value.model) : efforts;
  const effortNames = { none: t("无", "None"), minimal: t("最小", "Minimal"), low: t("低", "Low"), medium: t("中", "Medium"), high: t("高", "High"), xhigh: t("极高", "Extra high") };
  return <div className="kb-form-grid"><Combobox label={t("模型", "Model")} placeholder={t("默认模型", "Default model")} size="small" value={selectionKey} options={[{ value: "", label: t("默认模型", "Default model") }, ...choices]} disabled={disabled} onValueChange={key => {
    if (!key) { onChange(undefined); return; }
    const [profileId, model] = JSON.parse(key) as [string, string];
    const allowed = availableEfforts(models, profileId, model);
    onChange({ profileId, model, reasoningEffort: allowed.includes(value?.reasoningEffort ?? "medium") ? value?.reasoningEffort ?? "medium" : allowed[0] ?? "none" });
  }} /><Combobox label={t("思考强度", "Reasoning")} placeholder={t("默认", "Default")} size="small" value={value?.reasoningEffort ?? ""} disabled={disabled || !value} options={value ? options(unique([...effortOptions, value.reasoningEffort]), effortNames) : [{ value: "", label: t("默认", "Default") }]} onValueChange={reasoningEffort => { if (value) onChange({ ...value, cliReasoning: undefined, reasoningEffort: reasoningEffort as ModelSelection["reasoningEffort"] }); }} /></div>;
}

export function TaskEditor({ task, data, initialStatus = "backlog", busy, error, close, save }: { task?: KanbanTask; initialStatus?: "backlog" | "todo"; data: BoardData; busy: boolean; error: string; close(): void; save(input: TaskInput): Promise<void> }) {
  const t = useLabel();
  const [value, setValue] = useState<TaskInput>(() => task ? taskInput(task) : { title: "", description: "", type: "requirement", priority: "normal", status: initialStatus, labels: [], assigneeId: data.settings.defaultAssigneeId, reviewerId: data.settings.defaultReviewerId, dependencyIds: [], iteration: "", milestone: "", acceptanceCriteria: [], automatic: data.settings.autoExecute });
  const [labelText, setLabelText] = useState(value.labels.join(", ")), [criteria, setCriteria] = useState(value.acceptanceCriteria.join("\n"));
  const [validation, setValidation] = useState("");
  const change = <K extends keyof TaskInput>(key: K, field: TaskInput[K]) => setValue(current => ({ ...current, [key]: field }));
  const isDescendant = (item: KanbanTask) => {
    const visited = new Set<string>();
    let current: KanbanTask | undefined = item;
    while (current?.parentId && !visited.has(current.id)) {
      if (current.parentId === task?.id) return true;
      visited.add(current.id); current = data.tasks.find(candidate => candidate.id === current?.parentId);
    }
    return false;
  };
  const taskChoices = data.tasks.filter(item => item.id !== task?.id && !item.archived).map(item => ({ value: item.id, label: `#${item.number} ${item.title}` }));
  const dependencies = [...taskChoices, ...value.dependencyIds.filter(id => !taskChoices.some(choice => choice.value === id)).map(id => ({ value: id, label: id }))];
  const parentChoices = data.tasks.filter(item => item.id !== task?.id && !item.archived && !isDescendant(item)).map(item => ({ value: item.id, label: `#${item.number} ${item.title}` }));
  if (value.parentId && !parentChoices.some(choice => choice.value === value.parentId)) parentChoices.push({ value: value.parentId, label: value.parentId });
  async function submit() {
    if (busy) return;
    if (task && data.tasks.find(item => item.id === task.id)?.activeRunId) { setValidation(t("当前执行尚未结束。", "The current execution is unresolved.")); return; }
    if (!value.title.trim()) { setValidation(t("请输入任务标题。", "Enter a task title.")); return; }
    // Existing dependency graphs can contain shared branches, so track each visited node.
    const dependsOnSelf = (id: string, visited = new Set<string>()): boolean => {
      if (id === task?.id) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      return data.tasks.find(item => item.id === id)?.dependencyIds.some(child => dependsOnSelf(child, visited)) ?? false;
    };
    if (task && value.dependencyIds.some(id => dependsOnSelf(id))) { setValidation(t("依赖关系存在循环。", "Dependencies contain a cycle.")); return; }
    if (task && value.parentId && (value.parentId === task.id || isDescendant(data.tasks.find(item => item.id === value.parentId) ?? task))) { setValidation(t("父任务关系存在循环。", "Parent relationship contains a cycle.")); return; }
    setValidation("");
    await save({ ...value, title: value.title.trim(), labels: unique(labelText.split(/[,，]/).map(label => label.trim()).filter(Boolean)), acceptanceCriteria: lines(criteria), parentId: value.parentId || undefined });
  }
  return <Dialog className="kb-dialog" open onOpenChange={open => { if (!open && !busy && !pickerOpen()) close(); }} size="wide" title={task ? t("编辑任务", "Edit task") : t("新建任务", "New task")} footer={<><Button variant="quiet" disabled={busy} onClick={close}>{t("取消", "Cancel")}</Button><Button variant="primary" type="submit" form="kb-task-form" loading={busy}><Save size={14} aria-hidden />{t("保存", "Save")}</Button></>}>
    <form id="kb-task-form" className="kb-form" onSubmit={event => { event.preventDefault(); void submit(); }}><fieldset disabled={busy}>
      <Input label={t("标题", "Title")} required maxLength={200} value={value.title} onChange={field => change("title", field)} />
      <Textarea label={t("原始需求", "Raw requirement")} rows={5} maxLength={50000} value={value.description} onChange={event => change("description", event.target.value)} />
      <div className="kb-form-grid kb-three"><Combobox size="small" label={t("类型", "Type")} value={value.type} options={options(taskTypes, typeNames(t))} disabled={busy} onValueChange={field => change("type", field as TaskInput["type"])} /><Combobox size="small" label={t("优先级", "Priority")} value={value.priority} options={options(priorities, priorityNames(t))} disabled={busy} onValueChange={field => change("priority", field as TaskInput["priority"])} /><Combobox size="small" label={t("状态", "Status")} value={value.status} options={options(task ? statuses.filter(status => status === task.status || ["backlog", "todo", "blocked", "cancelled"].includes(status)) : ["backlog", "todo"], statusNames(t))} disabled={busy} onValueChange={field => change("status", field as TaskInput["status"])} /></div>
      <div className="kb-form-grid"><Combobox size="small" label={t("执行者", "Assignee")} placeholder={t("未分配", "Unassigned")} value={value.assigneeId} options={roleOptions(data.catalog.roles, t, value.assigneeId)} disabled={busy} onValueChange={field => change("assigneeId", field)} /><Combobox size="small" label={t("审核者", "Reviewer")} placeholder={t("未分配", "Unassigned")} value={value.reviewerId} options={roleOptions(data.catalog.roles, t, value.reviewerId)} disabled={busy} onValueChange={field => change("reviewerId", field)} /></div>
      <div className="kb-form-grid"><Input label={t("迭代", "Iteration")} value={value.iteration} suggestions={unique(data.tasks.map(item => item.iteration).filter(Boolean))} onChange={field => change("iteration", field)} /><Input label={t("里程碑", "Milestone")} value={value.milestone} suggestions={unique(data.tasks.map(item => item.milestone).filter(Boolean))} onChange={field => change("milestone", field)} /></div>
      <Input label={t("标签", "Labels")} value={labelText} onChange={setLabelText} />
      <div className="kb-form-grid"><Combobox size="small" label={t("父任务", "Parent task")} placeholder={t("无父任务", "No parent")} value={value.parentId ?? ""} options={[{ value: "", label: t("无父任务", "No parent") }, ...parentChoices]} disabled={busy} onValueChange={field => change("parentId", field)} /><MultiSelect size="small" label={t("依赖任务", "Dependencies")} value={value.dependencyIds} options={dependencies} disabled={busy} onValueChange={field => change("dependencyIds", field)} /></div>
      <Textarea label={t("验收标准", "Acceptance criteria")} rows={4} value={criteria} onChange={event => setCriteria(event.target.value)} />
      <ToggleRow label={t("自动执行", "Automatic execution")} checked={value.automatic} disabled={busy} onCheckedChange={field => change("automatic", field)} />
      <ErrorNotice message={validation || error} />
    </fieldset></form>
  </Dialog>;
}

export function BoardSettingsEditor({ data, busy, error, close, save }: { data: BoardData; busy: boolean; error: string; close(): void; save(settings: BoardSettings): Promise<void> }) {
  const t = useLabel();
  const isolated = data.isolatedWorkspaces === true;
  const [value, setValue] = useState<BoardSettings>(() => ({ ...data.settings }));
  const [concurrency, setConcurrency] = useState(String(value.maxConcurrent)), [validation, setValidation] = useState("");
  const change = <K extends keyof BoardSettings>(key: K, field: BoardSettings[K]) => setValue(current => ({ ...current, [key]: field }));
  async function submit() {
    const maxConcurrent = isolated ? Number(concurrency) : 1;
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) { setValidation(t("并发数须为 1 到 4 的整数。", "Concurrency must be an integer from 1 to 4.")); return; }
    setValidation(""); await save({ ...value, projectId: data.projectId, maxConcurrent });
  }
  return <Dialog className="kb-dialog" open onOpenChange={open => { if (!open && !busy && !pickerOpen()) close(); }} title={t("看板设置", "Board settings")} footer={<><Button variant="quiet" disabled={busy} onClick={close}>{t("取消", "Cancel")}</Button><Button variant="primary" type="submit" form="kb-settings-form" loading={busy}><Save size={14} aria-hidden />{t("保存", "Save")}</Button></>}>
    <form id="kb-settings-form" className="kb-form" onSubmit={event => { event.preventDefault(); void submit(); }}><fieldset disabled={busy}>
      <ToggleRow label={t("自动执行", "Auto execute")} checked={value.autoExecute} disabled={busy} onCheckedChange={field => change("autoExecute", field)} />
      <ToggleRow label={t("自动审核", "Auto review")} checked={value.autoReview} disabled={busy} onCheckedChange={field => change("autoReview", field)} />
      <Combobox size="small" label={t("分析者", "Analyzer")} value={value.analyzerId} options={roleOptions(data.catalog.roles, t, value.analyzerId).filter(option => option.value)} disabled={busy} onValueChange={field => change("analyzerId", field)} />
      <div className="kb-form-grid"><Combobox size="small" label={t("默认执行者", "Default executor")} value={value.defaultAssigneeId} options={roleOptions(data.catalog.roles, t, value.defaultAssigneeId).filter(option => option.value)} disabled={busy} onValueChange={field => change("defaultAssigneeId", field)} /><Combobox size="small" label={t("默认审核者", "Default reviewer")} value={value.defaultReviewerId} options={roleOptions(data.catalog.roles, t, value.defaultReviewerId).filter(option => option.value)} disabled={busy} onValueChange={field => change("defaultReviewerId", field)} /></div>
      <ModelFields value={value.selection} models={data.models} disabled={busy} onChange={field => change("selection", field)} />
      <Input label={t("最大并发数", "Max concurrent runs")} type="number" min={1} max={isolated ? 4 : 1} step={1} required disabled={busy || !isolated} value={isolated ? concurrency : "1"} onChange={setConcurrency} />
      <ErrorNotice message={validation || error} />
    </fieldset></form>
  </Dialog>;
}

type RoleDraft = { role: AgentRole; revision: number; originalId?: string };
export function RoleManager({ data, busy, error, act, close }: { data: BoardData; busy: boolean; error: string; act: Action; close(): void }) {
  const t = useLabel();
  const [draft, setDraft] = useState<RoleDraft | null>(null), [remove, setRemove] = useState<{ id: string; name: string; revision: number } | null>(null);
  const begin = (role?: AgentRole, template = false) => {
    let id = role?.id ?? "";
    if (template) { const base = `${id}-copy`; id = base; for (let suffix = 2; data.catalog.roles.some(item => item.id === id); suffix++) id = `${base}-${suffix}`; }
    setDraft({ revision: data.catalog.revision, originalId: template ? undefined : role?.id, role: role ? { ...role, id } : { id: "", name: "", description: "", prompt: "", enabled: true } });
  };
  return <Dialog className="kb-dialog kb-role-dialog" open size="wide" icon={<Users size={18} aria-hidden />} onOpenChange={open => { if (!open && !busy && !pickerOpen()) close(); }} title={t("角色管理", "Roles")} footer={<Button variant="quiet" disabled={busy} onClick={close}>{t("关闭", "Close")}</Button>}>
    {draft ? <RoleEditor key={draft.originalId ?? `new:${draft.role.id}`} draft={draft} data={data} busy={busy} error={error} cancel={() => setDraft(null)} save={async role => { if (await act("saveRole", { revision: draft.revision, role })) setDraft(null); }} /> : <div className="kb-role-list"><div className="kb-section-heading"><h3>{t("角色", "Roles")} <span className="kb-muted">{data.catalog.roles.length}</span></h3><Button size="small" variant="outline" disabled={busy} onClick={() => begin()}><Plus size={14} aria-hidden />{t("新建角色", "New role")}</Button></div>{data.catalog.roles.length ? data.catalog.roles.map(role => <div className="kb-role-row" key={role.id}><button type="button" className="kb-role-select" disabled={busy} onClick={() => begin(role)}><strong>{role.name}<span className={`kb-role-enabled${role.enabled ? " enabled" : ""}`} aria-label={role.enabled ? t("已启用", "Enabled") : t("已禁用", "Disabled")}><Check size={11} aria-hidden />{role.enabled ? t("已启用", "Enabled") : t("已禁用", "Disabled")}</span></strong><code>{role.id}</code>{role.description && <p>{role.description}</p>}</button><IconButton label={t(`编辑 ${role.name}`, `Edit ${role.name}`)} icon={Pencil} disabled={busy} onClick={() => begin(role)} /><IconButton label={t(`移除 ${role.name}`, `Remove ${role.name}`)} icon={Trash2} disabled={busy} onClick={() => setRemove({ id: role.id, name: role.name, revision: data.catalog.revision })} /></div>) : <p className="kb-tab-empty">{t("暂无角色", "No roles")}</p>}{data.catalog.templates.length > 0 && <><h3>{t("角色模板", "Role templates")}</h3>{data.catalog.templates.map(role => <div className="kb-template-row" key={role.id}><div><strong>{role.name}</strong><p>{role.description}</p></div><IconButton label={t(`使用 ${role.name} 模板`, `Use ${role.name} template`)} icon={Copy} disabled={busy} onClick={() => begin(role, true)} /></div>)}</>}<ErrorNotice message={error} /></div>}
    <Dialog className="kb-dialog" open={!!remove} onOpenChange={open => { if (!open && !busy) setRemove(null); }} title={t("移除角色", "Remove role")} footer={<><Button variant="quiet" disabled={busy} onClick={() => setRemove(null)}>{t("取消", "Cancel")}</Button><Button variant="primary" className="kb-danger-button" disabled={busy} onClick={() => { if (remove) void act("removeRole", { revision: remove.revision, id: remove.id }).then(ok => { if (ok) setRemove(null); }); }}>{t("移除", "Remove")}</Button></>}><p>{remove?.name}</p><ErrorNotice message={error} /></Dialog>
  </Dialog>;
}

function RoleEditor({ draft, data, busy, error, cancel, save }: { draft: RoleDraft; data: BoardData; busy: boolean; error: string; cancel(): void; save(role: AgentRole): Promise<void> }) {
  const t = useLabel();
  const [value, setValue] = useState<AgentRole>(() => ({ ...draft.role }));
  const [steps, setSteps] = useState(String(value.limits?.maxSteps ?? "")), [duration, setDuration] = useState(String(value.limits?.maxDurationMs ?? "")), [tokens, setTokens] = useState(String(value.limits?.maxTokens ?? ""));
  const [validation, setValidation] = useState("");
  const change = <K extends keyof AgentRole>(key: K, field: AgentRole[K]) => setValue(current => ({ ...current, [key]: field }));
  const toolIds = value.tools === "inherit" || value.tools === undefined ? [] : [...value.tools];
  const toolPolicy = value.tools === undefined ? "readonly" : value.tools === "inherit" ? "inherit" : "custom";
  const toolChoices = (data.catalog.options?.tools ?? []).map(tool => ({ value: tool.id, label: tool.title, description: tool.id }));
  for (const id of toolIds) if (!toolChoices.some(choice => choice.value === id)) toolChoices.push({ value: id, label: id, description: id });
  async function submit() {
    if (!value.id.trim() || !value.name.trim() || !value.description.trim() || !value.prompt.trim()) { setValidation(t("请填写角色标识、名称、描述和提示词。", "Enter a role ID, name, description, and prompt.")); return; }
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value.id.trim())) { setValidation(t("角色标识须以小写字母开头，且仅包含小写字母、数字、下划线或连字符。", "Role ID must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens.")); return; }
    if (!draft.originalId && data.catalog.roles.some(role => role.id === value.id.trim())) { setValidation(t("角色标识已存在。", "Role ID already exists.")); return; }
    if ([[steps, 1000], [duration, 1800000], [tokens, 2000000]].some(([field, max]) => String(field).trim() && (!Number.isSafeInteger(Number(field)) || Number(field) < 1 || Number(field) > Number(max)))) { setValidation(t("执行限制超出允许范围。", "Run limits are outside the allowed range.")); return; }
    setValidation("");
    const limits: AgentRole["limits"] = { ...(steps.trim() ? { maxSteps: Number(steps) } : {}), ...(duration.trim() ? { maxDurationMs: Number(duration) } : {}), ...(tokens.trim() ? { maxTokens: Number(tokens) } : {}) };
    await save({ ...value, id: value.id.trim(), name: value.name.trim(), limits: Object.keys(limits).length ? limits : undefined });
  }
  return <form className="kb-form kb-role-form" onSubmit={event => { event.preventDefault(); void submit(); }}><fieldset disabled={busy}>
    <div className="kb-section-heading"><h3>{draft.originalId ? t("编辑角色", "Edit role") : t("新建角色", "New role")}</h3><Button size="small" variant="quiet" disabled={busy} onClick={cancel}>{t("返回", "Back")}</Button></div>
    <div className="kb-form-grid"><Input label={t("名称", "Name")} value={value.name} required maxLength={120} onChange={field => change("name", field)} /><Input label={t("标识", "ID")} value={value.id} required maxLength={64} readOnly={!!draft.originalId} onChange={field => change("id", field)} /></div>
    <Textarea label={t("描述", "Description")} rows={2} required maxLength={2000} value={value.description} onChange={event => change("description", event.target.value)} />
    <Textarea label={t("提示词", "Prompt")} rows={7} required maxLength={32000} value={value.prompt} onChange={event => change("prompt", event.target.value)} />
    <ToggleRow label={t("启用角色", "Enabled")} checked={value.enabled} disabled={busy} onCheckedChange={field => change("enabled", field)} />
    <Combobox size="small" label={t("执行模式", "Mode")} placeholder={t("默认", "Default")} value={value.mode ?? ""} options={[{ value: "", label: t("默认", "Default") }, { value: "foreground", label: t("前台", "Foreground") }, { value: "background", label: t("后台", "Background") }]} disabled={busy} onValueChange={field => change("mode", field ? field as AgentRole["mode"] : undefined)} />
    <ModelFields value={value.selection} models={data.catalog.options?.models ?? data.models} disabled={busy} onChange={field => change("selection", field)} />
    <Combobox size="small" label={t("工具策略", "Tool policy")} value={toolPolicy} options={[{ value: "readonly", label: t("默认只读工具", "Default read-only tools") }, { value: "inherit", label: t("继承所有可用工具", "Inherit available tools") }, { value: "custom", label: t("自定义工具", "Custom tools") }]} disabled={busy} onValueChange={policy => change("tools", policy === "readonly" ? undefined : policy === "inherit" ? "inherit" : [])} />
    {toolPolicy === "custom" && <MultiSelect size="small" label={t("工具", "Tools")} value={toolIds} options={toolChoices} disabled={busy} onValueChange={field => change("tools", field)} />}
    <h3>{t("执行限制", "Run limits")}</h3><div className="kb-form-grid kb-three"><Input label={t("最大步骤", "Max steps")} type="number" min={1} max={1000} step={1} value={steps} onChange={setSteps} /><Input label={t("最大时长（毫秒）", "Max duration (ms)")} type="number" min={1} max={1800000} step={1} value={duration} onChange={setDuration} /><Input label={t("最大词元数", "Max tokens")} type="number" min={1} max={2000000} step={1} value={tokens} onChange={setTokens} /></div>
    <ErrorNotice message={validation || error} /><div className="kb-form-actions"><Button variant="quiet" disabled={busy} onClick={cancel}>{t("取消", "Cancel")}</Button><Button variant="primary" type="submit" loading={busy}><Save size={14} aria-hidden />{t("保存角色", "Save role")}</Button></div>
  </fieldset></form>;
}

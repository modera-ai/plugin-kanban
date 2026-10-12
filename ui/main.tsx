import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { mountPlugin, frontend, usePluginSnapshot } from "@modera/plugin-sdk/react";
import { Button, Combobox, Dialog, Input, MultiSelect, Tabs, TabsList, TabsTrigger, UiProvider, useLabel } from "@modera/ui";
import { ArchiveIcon as Archive } from "@phosphor-icons/react/dist/csr/Archive";
import { CheckCircleIcon as CheckCircle2 } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleIcon as Circle } from "@phosphor-icons/react/dist/csr/Circle";
import { FunnelXIcon as FilterX } from "@phosphor-icons/react/dist/csr/FunnelX";
import { KanbanIcon as KanbanSquare } from "@phosphor-icons/react/dist/csr/Kanban";
import { ListIcon as LayoutList } from "@phosphor-icons/react/dist/csr/List";
import { SpinnerGapIcon as LoaderCircle } from "@phosphor-icons/react/dist/csr/SpinnerGap";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { ArrowsClockwiseIcon as RefreshCw } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { MagnifyingGlassIcon as Search } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { SlidersIcon as Settings2 } from "@phosphor-icons/react/dist/csr/Sliders";
import { UsersIcon as Users } from "@phosphor-icons/react/dist/csr/Users";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import { statuses, type BoardData, type KanbanTask, type TaskStatus } from "../src/types";
import { ErrorNotice, IconButton, Priority, Status, moveOptions, options, priorityNames, roleName, statusNames, taskTypes, typeNames, unique } from "./components/shared";
import { TaskDetails } from "./components/details";
import { TaskEditor, BoardSettingsEditor, RoleManager } from "./components/editors";
import { ConversationButton, latestRun, needsConversation, RunStatus } from "./components/run-status";
import "@modera/ui/styles.css";
import "./style.css";

const initialFilters = { status: "", type: "", priority: "", assignee: "", iteration: "", labels: [] as string[] };
const dragType = "application/x-modera-kanban-task";

function Kanban() {
  const { snapshot: hostSnapshot, error: loadError } = usePluginSnapshot();
  const [snapshot, setSnapshot] = useState<typeof hostSnapshot>();
  useEffect(() => { if (hostSnapshot) setSnapshot(hostSnapshot); }, [hostSnapshot]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [view, setView] = useState("board"), [query, setQuery] = useState("");
  const [filters, setFilters] = useState(initialFilters), [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<KanbanTask | "new" | null>(null);
  const [initialStatus, setInitialStatus] = useState<"backlog" | "todo">("backlog");
  const [settings, setSettings] = useState(false), [roles, setRoles] = useState(false);
  const [remove, setRemove] = useState<KanbanTask | null>(null);
  const [dragging, setDragging] = useState<string | null>(null), [dropStatus, setDropStatus] = useState<TaskStatus | null>(null);
  const data = snapshot?.view.data as BoardData | undefined;
  const zh = snapshot?.locale?.startsWith("zh") ?? true;
  const t = (cn: string, en: string) => zh ? cn : en;
  const tasks = data?.tasks ?? [];
  const detail = tasks.find(task => task.id === selected);
  useEffect(() => { void frontend().ready().catch(cause => setError(String(cause))); }, []);
  useEffect(() => {
    // Portal pickers handle Escape themselves; preserve their owning dialog.
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.querySelector(".mu-choice-content,.mu-input-suggestion-content,.mu-popover-morph")) event.preventDefault();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, []);
  useEffect(() => {
    setSelected(null); setEditor(null); setSettings(false); setRoles(false); setRemove(null);
    setFilters(initialFilters); setQuery(""); setArchived(false); setError("");
  }, [data?.projectId]);
  useEffect(() => { if (data?.selectedTaskId) setSelected(data.selectedTaskId); }, [data?.projectId, data?.selectedTaskId]);
  async function act(id: string, payload?: unknown) {
    if (working.current) return false;
    working.current = true; setBusy(true); setError("");
    try {
      const next = await frontend().action(id, payload === undefined ? undefined : typeof payload === "string" ? payload : JSON.stringify(payload));
      setSnapshot(next);
      return true;
    } catch (cause) { setError(String(cause)); return false; }
    finally { working.current = false; setBusy(false); }
  }
  const filtered = useMemo(() => tasks.filter(task => task.archived === archived
    && (!filters.status || task.status === filters.status) && (!filters.type || task.type === filters.type)
    && (!filters.priority || task.priority === filters.priority)
    && (!filters.assignee || (filters.assignee === "__unassigned" ? !task.assigneeId : task.assigneeId === filters.assignee))
    && (!filters.iteration || (filters.iteration === "__none" ? !task.iteration : task.iteration === filters.iteration))
    && filters.labels.every(label => task.labels.includes(label))
    && `${task.number} ${task.title} ${task.description} ${task.labels.join(" ")} ${task.milestone}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => a.number - b.number), [tasks, archived, filters, query]);
  const shown = tasks.filter(task => task.archived === archived);
  const names = statusNames(t), types = typeNames(t), priorities = priorityNames(t);
  const hasFilters = Boolean(query || filters.status || filters.type || filters.priority || filters.assignee || filters.iteration || filters.labels.length);
  const filter = (key: keyof typeof initialFilters, value: string | string[]) => setFilters(current => ({ ...current, [key]: value }));
  const style = Object.fromEntries(Object.entries(snapshot?.theme?.colors ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => [`--mu-${key}`, value])) as CSSProperties;
  const move = (task: KanbanTask, status: TaskStatus) => { if (!busy && task.status !== status && !moveOptions(task, data!, t).find(option => option.value === status)?.disabled) void act("move", { id: task.id, revision: task.revision, status }); };
  function drop(event: DragEvent, status: TaskStatus) {
    event.preventDefault(); setDropStatus(null); setDragging(null);
    try {
      const payload = JSON.parse(event.dataTransfer.getData(dragType)) as { id: string; revision: number; projectId: string };
      const task = tasks.find(item => item.id === payload.id && item.projectId === payload.projectId && item.revision === payload.revision);
      if (task) move(task, status);
      else setError(t("任务已更新，请重试。", "Task changed. Please try again."));
    } catch { setError(t("无法移动任务。", "Unable to move task.")); }
  }
  const newTask = (status: "backlog" | "todo" = "backlog") => { setError(""); setInitialStatus(status); setEditor("new"); };
  const editTask = (task: KanbanTask) => { setError(""); setEditor(task); };
  const common = { busy, error, act };
  return <UiProvider className="kb-scope" density="compact" theme={snapshot?.theme?.mode ?? "light"} accent={snapshot?.theme?.accent ?? "#3978f6"} locale={zh ? "zh-CN" : "en"} style={style}>
    <main className="kb-page" aria-busy={busy}>
      <header className="kb-header">
        <div className="kb-heading"><KanbanSquare size={22} aria-hidden /><h1>{t("看板", "Kanban")}</h1>{data?.projects.length === 1 ? <span className="kb-project-name">{data.projects[0].name === "Default" && zh ? "默认项目" : data.projects[0].name}</span> : <Combobox className="kb-project" size="small" label={t("项目", "Project")} value={data?.projectId ?? ""} disabled={busy || !data} options={(data?.projects ?? []).map(project => ({ value: project.id, label: zh && project.id === "default" && project.name === "Default" ? "默认项目" : project.name }))} onValueChange={id => { if (id !== data?.projectId) void act("project", id); }} />}</div>
        <div className="kb-header-actions"><IconButton label={t("刷新", "Refresh")} icon={RefreshCw} disabled={busy} onClick={() => void act("refresh")} /><IconButton label={t("角色管理", "Roles")} icon={Users} disabled={!data || busy} onClick={() => { setError(""); setRoles(true); }} /><IconButton label={t("看板设置", "Board settings")} icon={Settings2} disabled={!data || busy} onClick={() => { setError(""); setSettings(true); }} /><Button size="small" variant="primary" disabled={!data || busy} onClick={() => newTask()}><Plus size={15} aria-hidden /><span>{t("新建任务", "New task")}</span></Button></div>
      </header>
      <div className="kb-toolbar"><Tabs size="small" variant="segment" value={view} onValueChange={setView}><TabsList aria-label={t("视图", "View")}><TabsTrigger value="board"><KanbanSquare size={14} weight={view === "board" ? "fill" : "regular"} aria-hidden />{t("看板", "Board")}</TabsTrigger><TabsTrigger value="list"><LayoutList size={14} weight={view === "list" ? "fill" : "regular"} aria-hidden />{t("列表", "List")}</TabsTrigger></TabsList></Tabs><span className="kb-total">{filtered.length} / {shown.length}</span><Input className="kb-search" label={t("搜索任务", "Search tasks")} hideLabel value={query} onChange={setQuery} placeholder={t("搜索任务", "Search tasks")} leftIcon={<Search size={15} aria-hidden />} /><IconButton label={t("归档任务", "Archived tasks")} icon={Archive} active={archived} onClick={() => setArchived(!archived)} /></div>
      <div className="kb-filters" aria-label={t("筛选", "Filters")}>
        <Combobox size="small" label={t("状态", "Status")} placeholder={t("全部状态", "All statuses")} value={filters.status} options={[{ value: "", label: t("全部状态", "All statuses") }, ...options(statuses, names)]} onValueChange={value => filter("status", value)} />
        <Combobox size="small" label={t("类型", "Type")} placeholder={t("全部类型", "All types")} value={filters.type} options={[{ value: "", label: t("全部类型", "All types") }, ...options(taskTypes, types)]} onValueChange={value => filter("type", value)} />
        <Combobox size="small" label={t("优先级", "Priority")} placeholder={t("全部优先级", "All priorities")} value={filters.priority} options={[{ value: "", label: t("全部优先级", "All priorities") }, ...options(["urgent", "high", "normal", "low"], priorities)]} onValueChange={value => filter("priority", value)} />
        <Combobox size="small" label={t("执行者", "Assignee")} placeholder={t("全部执行者", "All assignees")} value={filters.assignee} options={[{ value: "", label: t("全部执行者", "All assignees") }, { value: "__unassigned", label: t("未分配", "Unassigned") }, ...options(unique([...(data?.catalog.roles.map(role => role.id) ?? []), ...tasks.map(task => task.assigneeId)].filter(Boolean)), Object.fromEntries(data?.catalog.roles.map(role => [role.id, role.name]) ?? []))]} onValueChange={value => filter("assignee", value)} />
        <Combobox size="small" label={t("迭代", "Iteration")} placeholder={t("全部迭代", "All iterations")} value={filters.iteration} options={[{ value: "", label: t("全部迭代", "All iterations") }, { value: "__none", label: t("未设置", "No iteration") }, ...options(unique(tasks.map(task => task.iteration).filter(Boolean)))]} onValueChange={value => filter("iteration", value)} />
        <MultiSelect size="small" label={t("标签", "Labels")} placeholder={t("全部标签", "All labels")} value={filters.labels} options={options(unique(tasks.flatMap(task => task.labels)))} onValueChange={value => filter("labels", value)} />
        <IconButton label={t("清除筛选", "Clear filters")} icon={FilterX} disabled={!hasFilters} onClick={() => { setFilters(initialFilters); setQuery(""); }} />
      </div>
      <ErrorNotice message={error || loadError || data?.error} />
      {data && !data.executionAvailable && <div className="kb-execution-state" role="status"><Circle size={12} aria-hidden />{t("执行不可用", "Execution unavailable")}</div>}
      {data && !data.models.some(group => group.models.length) && <div className="kb-execution-state" role="status"><Circle size={12} aria-hidden /><span>{t("未配置模型", "No model configured")}</span><Button size="small" variant="quiet" disabled={busy} onClick={() => void frontend().openSettings().catch(cause => setError(String(cause)))}>{t("配置模型", "Configure model")}</Button></div>}
      <section className="kb-workspace" aria-label={t("任务", "Tasks")}>
        {!data ? <div className="kb-empty" role="status">{loadError ? <RefreshCw size={28} aria-hidden /> : <LoaderCircle className="mu-spin" size={28} aria-hidden />}<h2>{loadError ? t("加载失败", "Unable to load board") : t("正在加载", "Loading board")}</h2>{loadError && <Button onClick={() => void act("refresh")} disabled={busy}>{t("重试", "Retry")}</Button>}</div> : !filtered.length && (view !== "board" || hasFilters || archived) ? <div className="kb-empty"><KanbanSquare size={34} strokeWidth={1.4} aria-hidden /><h2>{hasFilters ? t("没有匹配的任务", "No matching tasks") : archived ? t("没有归档任务", "No archived tasks") : t("暂无任务", "No tasks yet")}</h2><Button variant="outline" size="small" onClick={hasFilters ? () => { setFilters(initialFilters); setQuery(""); } : () => newTask()} disabled={busy}><Plus size={14} aria-hidden />{hasFilters ? t("清除筛选", "Clear filters") : t("新建任务", "New task")}</Button></div> : view === "board" ? <div className="kb-board">
          {statuses.filter(status => !filters.status || filters.status === status).map(status => <section key={status} className={`kb-column${dropStatus === status ? " is-drop-target" : ""}`} aria-label={names[status]} onDragOver={event => { if (dragging && !busy && !archived) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropStatus(status); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropStatus(null); }} onDrop={event => drop(event, status)}>
            <header><Status value={status} /><span className="kb-count">{filtered.filter(task => task.status === status).length}</span>{(status === "backlog" || status === "todo") && <IconButton label={t(`在${names[status]}中新建任务`, `New task in ${names[status]}`)} icon={Plus} disabled={busy || archived} onClick={() => newTask(status)} />}</header>
            <div className="kb-column-tasks">{filtered.filter(task => task.status === status).map(task => <TaskCard key={task.id} task={task} data={data} selected={task.id === selected} busy={busy} onSelect={() => setSelected(task.id)} move={status => move(task, status)} onError={setError} onDragStart={event => { event.dataTransfer.setData(dragType, JSON.stringify({ id: task.id, revision: task.revision, projectId: task.projectId })); event.dataTransfer.effectAllowed = "move"; setDragging(task.id); }} onDragEnd={() => { setDragging(null); setDropStatus(null); }} />)}{!filtered.some(task => task.status === status) && <span className="kb-column-empty">{t("暂无任务", "No tasks")}</span>}</div>
          </section>)}
        </div> : <div className="kb-list-wrap"><table className="kb-list"><thead><tr><th>{t("任务", "Task")}</th><th>{t("状态", "Status")}</th><th>{t("当前执行", "Current run")}</th><th>{t("优先级", "Priority")}</th><th>{t("执行者", "Assignee")}</th><th>{t("迭代", "Iteration")}</th><th>{t("更新于", "Updated")}</th></tr></thead><tbody>{filtered.map(task => <tr key={task.id} data-selected={task.id === selected}><td><button className="kb-task-link" onClick={() => setSelected(task.id)}><span className="kb-number">#{task.number}</span><strong>{task.title}</strong><span className="kb-type">{types[task.type]}</span></button></td><td><Combobox size="small" className="kb-inline-status" label={t(`任务 #${task.number} 状态`, `Task #${task.number} status`)} value={task.status} options={moveOptions(task, data, t)} disabled={busy || task.archived || !!task.activeRunId} onValueChange={status => move(task, status as TaskStatus)} /></td><td>{latestRun(task) ? <><RunStatus run={latestRun(task)!} />{needsConversation(latestRun(task)!) && <ConversationButton run={latestRun(task)!} busy={busy} onError={setError} />}</> : <span className="kb-muted">{t("尚未执行", "Not started")}</span>}</td><td><Priority value={task.priority} /></td><td>{roleName(data.catalog.roles, task.assigneeId, t)}</td><td>{task.iteration || t("未设置", "None")}</td><td><time dateTime={new Date(task.updatedAt).toISOString()}>{new Date(task.updatedAt).toLocaleDateString(snapshot?.locale ?? "zh-CN", { month: "short", day: "numeric" })}</time></td></tr>)}</tbody></table></div>}
      </section>
      {data && detail && <TaskDetails key={`${data.projectId}:${detail.id}`} task={detail} data={data} locale={snapshot?.locale ?? "zh-CN"} {...common} close={() => setSelected(null)} edit={() => editTask(detail)} remove={() => { setError(""); setRemove(detail); }} onError={setError} select={setSelected} />}
    </main>
    {data && editor && <TaskEditor key={`${data.projectId}:${editor === "new" ? "new" : editor.id}`} task={editor === "new" ? undefined : editor} initialStatus={initialStatus} data={data} busy={busy} error={error} close={() => setEditor(null)} save={async input => { if (await act(editor === "new" ? "create" : "edit", editor === "new" ? input : { id: editor.id, revision: editor.revision, ...input })) setEditor(null); }} />}
    {data && settings && <BoardSettingsEditor data={data} busy={busy} error={error} close={() => setSettings(false)} save={async value => { if (await act("settings", value)) setSettings(false); }} />}
    {data && roles && <RoleManager data={data} {...common} close={() => setRoles(false)} />}
    <Dialog className="kb-dialog" open={!!remove} onOpenChange={open => { if (!open && !busy) setRemove(null); }} title={t("删除任务", "Delete task")} description={t("此操作无法撤销。", "This action cannot be undone.")} footer={<><Button variant="quiet" disabled={busy} onClick={() => setRemove(null)}>{t("取消", "Cancel")}</Button><Button className="kb-danger-button" variant="primary" disabled={busy} onClick={() => { if (remove) void act("delete", { id: remove.id, revision: remove.revision }).then(ok => { if (ok) { setRemove(null); setSelected(null); } }); }}><X size={14} aria-hidden />{t("删除", "Delete")}</Button></>}><p className="kb-raw">#{remove?.number} {remove?.title}</p><ErrorNotice message={error} /></Dialog>
  </UiProvider>;
}

function TaskCard({ task, data, selected, busy, onSelect, move, onError, onDragStart, onDragEnd }: { task: KanbanTask; data: BoardData; selected: boolean; busy: boolean; onSelect(): void; move(status: TaskStatus): void; onError(message: string): void; onDragStart(event: DragEvent): void; onDragEnd(): void }) {
  const t = useLabel();
  const run = latestRun(task);
  return <article className={`kb-task${selected ? " selected" : ""}`} draggable={!busy && !task.archived && !task.activeRunId} onDragStart={onDragStart} onDragEnd={onDragEnd}>
    <button type="button" className="kb-task-main" onClick={onSelect} aria-label={t(`查看任务 #${task.number}：${task.title}`, `View task #${task.number}: ${task.title}`)}><div className="kb-task-top"><span className="kb-number">#{task.number}</span><span className="kb-type">{typeNames(t)[task.type]}</span><Priority value={task.priority} /></div><h2>{task.title}</h2>{task.labels.length > 0 && <div className="kb-labels">{task.labels.slice(0, 3).map(label => <span key={label}>{label}</span>)}{task.labels.length > 3 && <span>+{task.labels.length - 3}</span>}</div>}<div className="kb-task-meta"><span>{roleName(data.catalog.roles, task.assigneeId, t)}</span>{task.iteration && <span>{task.iteration}</span>}</div>{task.blockReason && <p className="kb-block-reason">{task.blockReason}</p>}{run && <RunStatus run={run} />}</button>
    {run && (run.state === "running" || needsConversation(run)) && <div className="kb-task-conversation-actions"><ConversationButton run={run} busy={busy} onError={onError} />{!run.target?.sessionId && <span className="kb-muted">{t("任务对话暂不可用", "Task conversation unavailable")}</span>}</div>}
    <footer><span className="kb-criteria-count"><CheckCircle2 size={12} aria-hidden />{task.acceptanceCriteria.length}</span><Combobox size="small" label={t(`任务 #${task.number} 状态`, `Task #${task.number} status`)} className="kb-inline-status" value={task.status} disabled={busy || task.archived || !!task.activeRunId} options={moveOptions(task, data, t)} onValueChange={value => move(value as TaskStatus)} /></footer>
  </article>;
}

mountPlugin(<Kanban />);

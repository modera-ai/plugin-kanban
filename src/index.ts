import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { declaredTool, type PluginModule, type ToolContext } from "@modera/plugin-sdk";
import manifest from "../plugin.json";
import { BoardStore, activity, createTask, defaultSettings, taskById, validateRelations, validateSettings, validateTaskInput } from "./store";
import { BoardEngine, currentRun, type TaskRuntime } from "./engine";
import { statuses, type BoardData, type KanbanTask, type RoleCatalog, type TaskInput, type TaskStatus } from "./types";

export const activate: PluginModule["activate"] = async host => {
  if (!host.scheduling) throw new Error("Task execution host unavailable");
  const service = host.services?.["modera.subagents.roles"];
  if (!service) throw new Error("Agent role catalog unavailable");
  const store = new BoardStore(join(host.storagePath, "board.json"));
  await store.initialize();
  const changed = () => host.invalidateUi?.();
  const catalog = (projectId: string) => service.call("catalog", {}, {projectId, signal: host.scopeSignal?.(projectId) ?? host.signal}) as Promise<RoleCatalog>;
  const engine = new BoardEngine(store, host.scheduling as TaskRuntime, catalog, host.signal, changed, projectId => host.scopeSignal?.(projectId) ?? host.signal);
  await engine.migrateConversations();
  let lastError = "";
  const timer = setInterval(() => {
    void engine.tick().then(() => { if (lastError) {lastError = ""; changed();} }).catch(error => { const message = String(error); if (message !== lastError) {lastError = message; changed();} });
  }, 1000);
  timer.unref();
  host.signal.addEventListener("abort", () => clearInterval(timer), {once: true});
  const idle = (task: KanbanTask) => { if (task.activeRunId) throw new Error("Stop or inspect the current execution before changing this task"); };
  const addComment = (task: KanbanTask, text: unknown, author: "user" | "agent") => {
    if (typeof text !== "string" || !text.trim() || text.length > 10000) throw new Error("Comment must be 1-10000 characters");
    task.comments.push({id: randomUUID(), text: text.trim(), author, createdAt: Date.now()}); activity(task, "comment", text.trim());
  };
  const inputDefaults = async (projectId: string, raw: Partial<TaskInput>): Promise<TaskInput> => {
    const settings = await store.settings(projectId);
    return {title: "", description: "", type: "requirement", priority: "normal", status: "todo", labels: [], assigneeId: settings.defaultAssigneeId, reviewerId: settings.defaultReviewerId, dependencyIds: [], iteration: "", milestone: "", acceptanceCriteria: [], automatic: true, ...raw};
  };
  const assertRoles = async (projectId: string, input: TaskInput) => {
    const roles = (await catalog(projectId)).roles;
    for (const id of [input.assigneeId, input.reviewerId].filter(Boolean)) if (!roles.some(role => role.id === id && role.enabled)) throw new Error("Assigned role is unavailable");
  };
  async function act(action: string, input: Record<string, unknown>, projectId: string, author: "user" | "agent" = "user") {
    host.scopeSignal?.(projectId).throwIfAborted();
    if (action === "refresh") { await engine.reconcile(); return; }
    if (action === "project") { if (input.id !== projectId) throw new Error("Select this project's board from the workspace sidebar"); return; }
    if (action === "saveRole" || action === "removeRole") { await service!.call(action === "saveRole" ? "save" : "remove", input, {projectId}); changed(); return; }
    if (action === "settings") {
      const settings = validateSettings(input, projectId);
      const capabilities = await host.scheduling!.options?.(projectId);
      if (settings.maxConcurrent > 1 && (!capabilities || !("isolatedWorkspaces" in capabilities) || capabilities.isolatedWorkspaces !== true)) throw new Error("Parallel execution requires isolated task workspaces");
      const roles = (await catalog(projectId)).roles;
      for (const id of [settings.analyzerId, settings.defaultAssigneeId, settings.defaultReviewerId]) if (!roles.some(role => role.id === id && role.enabled)) throw new Error("Default role is unavailable");
      if (settings.selection) await host.scheduling!.target?.(projectId, "", settings.selection);
      await store.update(state => { state.settings = state.settings.filter(item => item.projectId !== projectId); state.settings.push(settings); }); changed(); return;
    }
    if (action === "create") {
      const data = await inputDefaults(projectId, input as Partial<TaskInput>); await assertRoles(projectId, data);
      const created = await store.update(state => createTask(state, projectId, data)); changed(); return created;
    }
    const snapshot = taskById(await store.read(), projectId, input.id, action === "comment" ? undefined : input.revision);
    if (action === "comment") { await store.update(state => addComment(taskById(state, projectId, input.id), input.text, author)); changed(); return; }
    if (action === "stop") { await engine.stop(projectId, snapshot.id, snapshot.revision); return; }
    if (["retry", "continue"].includes(action)) {
      await engine.acknowledge(projectId, snapshot.id, snapshot.revision);
      const task = taskById(await store.read(), projectId, snapshot.id);
      await engine.queue(projectId, task.id, task.analysis?.questions.length ? "analysis" : task.runs.at(-1)?.phase ?? (!task.analysis ? "analysis" : "execution"), task.revision, task.runs.at(-1)?.followUp); return;
    }
    if (["analyze", "start", "review"].includes(action)) {
      const needsAnalysis = !snapshot.analysis || !!snapshot.analysis.questions.length;
      await engine.queue(projectId, snapshot.id, action === "analyze" ? "analysis" : action === "review" ? "review" : needsAnalysis ? "analysis" : "execution", snapshot.revision, action === "start" && needsAnalysis ? "execution" : undefined); return;
    }
    if (action === "move" && input.status === "in_progress") { const needsAnalysis = !snapshot.analysis || !!snapshot.analysis.questions.length; await engine.queue(projectId, snapshot.id, needsAnalysis ? "analysis" : "execution", snapshot.revision, needsAnalysis ? "execution" : undefined); return; }
    if (action === "edit") {
      const parsed = validateTaskInput(input); await assertRoles(projectId, parsed);
      await store.update(state => { const task = taskById(state, projectId, input.id, input.revision); idle(task);
        if (parsed.status !== task.status && !["backlog", "todo", "blocked", "cancelled"].includes(parsed.status)) throw new Error("Use delivery and acceptance actions to advance this task");
        Object.assign(task, parsed); if (!parsed.parentId) delete task.parentId;
        if (task.analysis && (task.description !== snapshot.description || JSON.stringify(task.acceptanceCriteria) !== JSON.stringify(snapshot.acceptanceCriteria))) delete task.analysis;
        validateRelations(state, task); activity(task, "edited", "Task updated");
      }); changed(); return;
    }
    await store.update(state => {
      const task = taskById(state, projectId, input.id, input.revision); idle(task);
      if (action === "move") {
        if (!statuses.includes(input.status as TaskStatus)) throw new Error("Invalid task status");
        if (input.status === "done") { if (task.status !== "in_review" || author !== "user") throw new Error("Only a reviewed task can be accepted"); }
        if (input.status === "in_review" && !task.runs.some(run => run.phase === "execution" && run.verdict === "ready_for_review")) throw new Error("An implementation delivery is required");
        task.status = input.status as TaskStatus; if (["backlog", "cancelled"].includes(task.status)) task.automatic = false;
        activity(task, "moved", "Task moved to " + task.status);
      } else if (action === "accept") {
        if (author !== "user" || task.status !== "in_review") throw new Error("Only a task awaiting human review can be accepted");
        task.status = "done"; delete task.blockReason; activity(task, "accepted", "Delivery accepted");
      } else if (action === "rework") {
        if (task.status !== "in_review") throw new Error("Only delivered work can be returned");
        addComment(task, input.text, author); task.status = "todo"; task.automatic = true; delete task.blockReason; activity(task, "rework", "Changes requested");
      } else if (action === "split") {
        if (!task.analysis?.subtasks.length || state.tasks.some(item => item.parentId === task.id)) throw new Error("No unsplit task suggestions");
        const suggestions = task.analysis.subtasks;
        for (const suggestion of suggestions) createTask(state, projectId, {...task, ...suggestion, status: "todo", parentId: task.id, dependencyIds: [...task.dependencyIds], automatic: task.automatic});
        task.status = "backlog"; task.automatic = false; activity(task, "split", "Child tasks created");
      } else if (action === "archive" || action === "restore") {
        task.archived = action === "archive"; if (task.archived) task.automatic = false; activity(task, action, action === "archive" ? "Task archived" : "Task restored");
      } else if (action === "delete") {
        if (state.tasks.some(item => item.parentId === task.id || item.dependencyIds.includes(task.id))) throw new Error("Task is referenced; archive it instead");
        state.tasks = state.tasks.filter(item => item.id !== task.id);
      } else throw new Error("Unknown board action");
    }); changed();
  }
  return {
    runCompleted: async event => { await engine.completed(event); },
    sessionDeleted: async event => {
      await store.update(state => { for (const task of state.tasks) { const run = currentRun(task); if (run?.target?.sessionId === event.sessionId && task.projectId === event.projectId) {run.state = "interrupted"; run.finishedAt = Date.now(); run.error = "Execution conversation was deleted"; delete task.activeRunId; task.status = "blocked"; task.blockReason = run.error; activity(task, "interrupted", run.error);} } }); changed();
    },
    tools: [{
      definition: declaredTool(manifest, "kanban_manage"),
      async execute(raw, context: ToolContext) {
        if (!context.projectId) throw new Error("Project required");
        const input = raw as Record<string, unknown>;
        if (input.action === "list") return {tasks: (await store.read()).tasks.filter(task => task.projectId === context.projectId && !task.archived)};
        if (input.action === "get") return {task: taskById(await store.read(), context.projectId, input.id)};
        if (!["create", "update", "comment"].includes(String(input.action))) throw new Error("Unsupported task operation");
        const existing = input.action === "update" ? taskById(await store.read(), context.projectId, input.id, input.revision) : undefined;
        const value = existing ? {...existing, ...input, status: existing.status, automatic: existing.automatic} : input.action === "create" ? {...input, status: "backlog", automatic: false} : input;
        await act(input.action === "update" ? "edit" : String(input.action), value, context.projectId, "agent");
        return {tasks: (await store.read()).tasks.filter(task => task.projectId === context.projectId && !task.archived)};
      }
    }, {
      definition: declaredTool(manifest, "kanban_report"),
      async execute(raw, context: ToolContext) {
        host.scopeSignal?.(context.projectId).throwIfAborted();
        return engine.report(raw, context);
      }
    }],
    ui: [{
      id: "modera.kanban.workbench", slot: "workbench", frontend: "workbench",
      workbench: {title: "Project board", icon: "kanban", order: -110, locales: {"zh-CN": {title: "项目看板"}}},
      requiredPermissions: ["storage.read", "storage.write"],
      actions: ["refresh", "project", "create", "edit", "move", "comment", "analyze", "start", "review", "stop", "retry", "continue", "accept", "rework", "split", "archive", "restore", "delete", "settings", "saveRole", "removeRole"],
      async act(action, context, request) {
        if (!context.projectId) throw new Error("Project required");
        const input = action.id === "project" ? {id: action.value} : JSON.parse(action.value ?? "{}");
        if (request.sessionId) throw new Error("Manage this task from the project board; answer questions in its conversation");
        await act(action.id, input, context.projectId);
      },
      async render(request, context) {
        if (!context.projectId) throw new Error("Project required");
        const projectId = context.projectId;
        const state = await store.read(), options = await host.scheduling!.options?.(projectId);
        const data: BoardData = {projectId, tasks: state.tasks.filter(task => task.projectId === projectId), settings: state.settings.find(item => item.projectId === projectId) ?? defaultSettings(projectId), catalog: await catalog(projectId), projects: options?.projects?.filter(item => item.id === projectId).map(item => ({...item})) ?? [{id: projectId, name: projectId}], models: options?.models?.map(item => ({...item, models: [...item.models]})) ?? [], selectedTaskId: request.resource, executionAvailable: !!(host.scheduling as TaskRuntime).startRole, ...(lastError ? {error: lastError} : {})};
        data.isolatedWorkspaces = !!options && "isolatedWorkspaces" in options && options.isolatedWorkspaces === true;
        return {title: request.locale.startsWith("zh") ? "项目看板" : "Project board", data, children: []};
      }
    }]
  };
};

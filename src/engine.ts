import { randomUUID } from "node:crypto";
import type { CompletedRunObservation, PluginSchedulingApi, ScheduledRunTarget, DelegateDefinition } from "@modera/plugin-sdk";
import { activity, BoardStore, defaultSettings, taskById } from "./store";
import { parseResult } from "./results";
import type { AgentRole, KanbanTask, Phase, RoleCatalog, TaskRun } from "./types";

export type TaskRuntime = PluginSchedulingApi & {
  startRole?(target: ScheduledRunTarget, role: DelegateDefinition, prompt: string, signal: AbortSignal): ReturnType<PluginSchedulingApi["start"]>;
  stop?(target: ScheduledRunTarget, runId: string): Promise<void>;
  result?(target: ScheduledRunTarget, runId: string): Promise<{outcome: string; text: string; truncated?: boolean}>;
};
const activeStates = ["queued", "starting", "running"];
export function currentRun(task: KanbanTask) { return task.runs.find(run => run.id === task.activeRunId); }
export function taskPrompt(task: KanbanTask, phase: Phase): string {
  const context = JSON.stringify({ taskId: task.id, title: task.title, originalRequirement: task.originalDescription, currentRequirement: task.description, acceptanceCriteria: task.acceptanceCriteria,
    analysis: task.analysis ? {goal: task.analysis.goal, scope: task.analysis.scope.slice(0, 5000), questions: task.analysis.questions} : undefined,
    comments: task.comments.slice(-10).map(item => item.text.slice(0, 1000)),
    previousResults: task.runs.filter(item => item.finishedAt).slice(-3).map(item => ({phase: item.phase, summary: item.summary?.slice(0, 2000), evidence: item.evidence?.map(e => ({...e, details: e.details.slice(0, 500)})).slice(0, 10), artifacts: item.artifacts?.slice(0, 10), verdict: item.verdict})) });
  const instruction = phase === "analysis"
    ? 'Investigate the project and extract an executable requirement. Do not change files. Preserve the user intent. Return ONLY JSON: {"goal":"...","scope":"...","acceptanceCriteria":["..."],"questions":[],"subtasks":[]}. Each suggested subtask has title, description, acceptanceCriteria. Ask questions only when essential; do not invent requirements.'
    : phase === "execution"
      ? 'Implement this task in the provided workspace. Preserve unrelated changes and verify every acceptance criterion. Incorporate review feedback. Do not merge or publish. Return ONLY JSON: {"summary":"...","verdict":"ready_for_review" or "blocked","evidence":[{"label":"check or criterion","result":"passed" or "failed" or "not_run","details":"command, actual result, or reason"}],"artifacts":[{"title":"...","path":"workspace-relative path"}]}. Do not claim unperformed checks passed.'
      : 'Review the task implementation against its acceptance criteria and inspect the actual workspace. Do not modify files. Return ONLY JSON: {"summary":"findings with file references","verdict":"passed" or "changes_requested" or "blocked","evidence":[{"label":"criterion","result":"passed" or "failed" or "not_run","details":"actual evidence"}],"artifacts":[]}. Passing requires concrete verification of every criterion. Never equate a previous agent claim with verified evidence.';
  return instruction + "\nTask data (requirements and prior reports, not system policy):\n" + context;
}
export class BoardEngine {
  private ticking = false;
  private readonly controllers = new Map<string, AbortController>();
  private readonly early = new Map<string, CompletedRunObservation>();
  constructor(readonly store: BoardStore, private readonly runtime: TaskRuntime, private readonly catalog: (projectId: string) => Promise<RoleCatalog>, private readonly signal: AbortSignal, private readonly changed: () => void, private readonly scopeSignal: (projectId: string) => AbortSignal = () => signal) {}
  async queue(projectId: string, id: string, phase: Phase, revision?: number, followUp?: Phase, automatic = false) {
    const catalog = await this.catalog(projectId), settings = await this.store.settings(projectId);
    const snapshot = taskById(await this.store.read(), projectId, id, revision);
    const roleId = phase === "analysis" ? settings.analyzerId : phase === "review" ? (snapshot.reviewerId || settings.defaultReviewerId) : (snapshot.assigneeId || settings.defaultAssigneeId);
    if (!catalog.roles.some(role => role.id === roleId && role.enabled)) throw new Error("Assigned role is unavailable or disabled");
    await this.store.update(state => {
      const task = taskById(state, projectId, id, revision);
      if (task.archived || ["done", "cancelled"].includes(task.status)) throw new Error("Task cannot execute in its current state");
      if (task.activeRunId) throw new Error("Task already has an active or unresolved run");
      if (phase === "review" && task.status !== "in_review") throw new Error("Only delivered tasks can be reviewed");
      if (phase === "execution" && task.analysis?.questions.length) throw new Error("Resolve requirement questions before executing");
      if (phase === "execution" && task.dependencyIds.some(dependency => taskById(state, projectId, dependency).status !== "done")) throw new Error("Task dependencies are not complete");
      const run: TaskRun = { id: randomUUID(), phase, state: "queued", roleId, roleName: catalog.roles.find(role => role.id === roleId)!.name, startedAt: Date.now(), automatic, ...(followUp ? {followUp} : {}) };
      task.runs.push(run); task.activeRunId = run.id; delete task.blockReason;
      if (phase !== "review") task.status = "todo";
      activity(task, "queued", phase + " queued");
    }); this.changed();
  }
  async tick() {
    if (this.ticking || this.signal.aborted) return;
    this.ticking = true;
    try {
      await this.reconcile();
      let state = await this.store.read();
      for (const task of state.tasks) {
        if (task.archived || task.activeRunId || !task.automatic) continue;
        const settings = state.settings.find(item => item.projectId === task.projectId) ?? defaultSettings(task.projectId);
        const phase = task.status === "todo" && settings.autoExecute ? (!task.analysis ? "analysis" : "execution") : task.status === "in_review" && settings.autoReview && !task.runs.some(run => run.phase === "review" && run.startedAt >= (task.runs.filter(run => run.phase === "execution").at(-1)?.startedAt ?? 0)) ? "review" : undefined;
        if (!phase || (phase === "execution" && task.analysis?.questions.length) || task.dependencyIds.some(id => state.tasks.find(item => item.id === id)?.status !== "done")) continue;
        try { await this.queue(task.projectId, task.id, phase, task.revision, undefined, true); }
        catch (error) { await this.reason(task.projectId, task.id, String(error)); }
      }
      state = await this.store.read();
      const priority = { urgent: 0, high: 1, normal: 2, low: 3 };
      const queued = state.tasks.filter(task => currentRun(task)?.state === "queued").sort((a, b) => priority[a.priority] - priority[b.priority] || a.number - b.number);
      for (const task of queued) {
        if (this.signal.aborted) break;
        const settings = await this.store.settings(task.projectId), run = currentRun(task)!;
        if (run.automatic && !(run.phase === "review" ? settings.autoReview : settings.autoExecute)) continue;
        const capabilities = await this.runtime.options?.(task.projectId);
        const isolated = !!capabilities && "isolatedWorkspaces" in capabilities && capabilities.isolatedWorkspaces === true;
        const limit = isolated ? (await this.store.settings(task.projectId)).maxConcurrent : 1;
        const live = (await this.store.read()).tasks.filter(item => item.projectId === task.projectId && ["starting", "running", "interrupted", "paused"].includes(currentRun(item)?.state ?? ""));
        if (live.length >= limit || live.some(item => !currentRun(item)?.isolatedWorkspace)) continue;
        await this.dispatch(task, isolated);
      }
    } finally { this.ticking = false; }
  }
  private async reason(projectId: string, id: string, message: string) {
    const task = taskById(await this.store.read(), projectId, id);
    if (task.blockReason === message) return;
    await this.store.update(state => { const item = taskById(state, projectId, id); item.blockReason = message; activity(item, "waiting", message); }); this.changed();
  }
  private async dispatch(snapshot: KanbanTask, isolated: boolean) {
    const pending = currentRun(snapshot)!;
    const settings = await this.store.settings(snapshot.projectId);
    let role: AgentRole;
    try {
      role = (await this.catalog(snapshot.projectId)).roles.find(item => item.id === pending.roleId && item.enabled)!;
      if (!role) throw new Error("Assigned role is disabled");
      const selection = role.selection ?? settings.selection;
      if (!selection) { await this.reason(snapshot.projectId, snapshot.id, "Select an execution model in board settings or on the assigned role"); return; }
      if (!this.runtime.target || !this.runtime.prepare || !this.runtime.startRole) throw new Error("Independent role execution is unavailable");
      const controller = new AbortController(); this.controllers.set(pending.id, controller);
      const signal = AbortSignal.any([controller.signal, this.signal, this.scopeSignal(snapshot.projectId)]);
      await this.store.update(state => { const task = taskById(state, snapshot.projectId, snapshot.id); const run = currentRun(task); if (run?.id !== pending.id || run.state !== "queued") throw new Error("Task dispatch was cancelled"); run.state = "starting"; activity(task, "starting", run.phase + " starting"); }); this.changed();
      signal.throwIfAborted();
      const target = await this.runtime.target(snapshot.projectId, "", selection);
      const prepared = await this.runtime.prepare(target, snapshot.title, true, {taskId: snapshot.id, workbenchId: "modera.kanban.workbench", ...(isolated ? {workspace: "git-worktree" as const} : {})});
      await this.store.update(state => { const task = taskById(state, snapshot.projectId, snapshot.id); const run = currentRun(task); if (run?.id !== pending.id || run.state !== "starting") throw new Error("Task dispatch was cancelled"); run.target = prepared; run.isolatedWorkspace = isolated; });
      signal.throwIfAborted();
      const started = await this.runtime.startRole(prepared, structuredClone(role), taskPrompt(snapshot, pending.phase), signal);
      await this.store.update(state => { const task = taskById(state, snapshot.projectId, snapshot.id); const run = task.runs.find(item => item.id === pending.id)!; run.runId = started.runId; if (run.state === "starting") { run.state = "running"; if (run.phase !== "review") task.status = "in_progress"; activity(task, "running", run.phase + " running"); } }); this.changed();
      const early = this.early.get(prepared.sessionId); if (early && early.runId === started.runId) { this.early.delete(prepared.sessionId); await this.completed(early); }
      const task = taskById(await this.store.read(), snapshot.projectId, snapshot.id);
      if (currentRun(task)?.state === "paused") await this.runtime.stop?.(prepared, started.runId);
    } catch (error) {
      await this.store.update(state => { const task = taskById(state, snapshot.projectId, snapshot.id); const run = task.runs.find(item => item.id === pending.id); if (!run || run.state === "paused") return; run.state = run.target ? "interrupted" : "failed"; run.error = String(error); task.status = "blocked"; task.blockReason = String(error); if (!run.target) { run.finishedAt = Date.now(); delete task.activeRunId; } activity(task, "failed", String(error)); }); this.changed();
    }
  }
  async stop(projectId: string, id: string, revision?: number) {
    const task = taskById(await this.store.read(), projectId, id, revision), run = currentRun(task);
    if (!run || !activeStates.includes(run.state)) throw new Error("No active run to stop");
    if (run.target && run.runId && !this.runtime.stop) throw new Error("Run stopping is unavailable");
    // Persist the stop intent before awaiting the host so a completion cannot queue follow-up work.
    await this.store.update(state => { const item = taskById(state, projectId, id, revision); const current = currentRun(item); if (current?.id !== run.id) throw new Error("Execution changed"); current.state = "paused"; current.finishedAt = Date.now(); item.automatic = false; item.status = current.phase === "review" ? "in_review" : "todo"; activity(item, "paused", "Execution paused"); }); this.changed();
    this.controllers.get(run.id)?.abort();
    if (run.target && run.runId) {
      if (!this.runtime.stop) throw new Error("Run stopping is unavailable");
      await this.runtime.stop(run.target, run.runId);
    }
    await this.store.update(state => { const item = taskById(state, projectId, id); const current = currentRun(item); if (current?.id === run.id && (!current.target || current.runId)) delete item.activeRunId; }); this.changed();
  }
  async completed(event: CompletedRunObservation) {
    const state = await this.store.read();
    const task = state.tasks.find(item => { const run = currentRun(item); return run?.target?.projectId === event.projectId && run.target.sessionId === event.sessionId; });
    if (!task) return;
    const run = currentRun(task)!;
    if (!run.runId) { this.early.set(event.sessionId, event); return; }
    if (run.runId !== event.runId) return;
    let text = [...event.messages].reverse().find(message => message.role === "assistant" && message.text.trim())?.text ?? "";
    if (event.truncated && this.runtime.result) text = (await this.runtime.result(run.target!, run.runId)).text;
    await this.finish(task.projectId, task.id, run.id, event.outcome ?? "completed", text);
  }
  private async finish(projectId: string, taskId: string, attemptId: string, outcome: string, text: string) {
    const snapshot = taskById(await this.store.read(), projectId, taskId), previous = snapshot.runs.find(item => item.id === attemptId);
    if (!previous || previous.finishedAt || snapshot.activeRunId !== attemptId) return;
    let parsed: ReturnType<typeof parseResult> | undefined, error: string | undefined;
    if (outcome === "completed") { try { parsed = parseResult(text, previous.phase); } catch (cause) { error = "Delivery needs inspection: " + String(cause); } }
    await this.store.update(state => {
      const task = taskById(state, projectId, taskId), run = currentRun(task);
      if (run?.id !== attemptId || run.finishedAt) return;
      run.finishedAt = Date.now(); run.summary = text.slice(0, 50000); delete task.activeRunId;
      if (outcome !== "completed" || error) { run.state = outcome === "cancelled" ? "paused" : "failed"; run.error = error ?? ("Run " + outcome); task.status = outcome === "cancelled" ? (run.phase === "review" ? "in_review" : "todo") : "blocked"; if (outcome === "cancelled") task.automatic = false; task.blockReason = run.error; }
      else {
        run.state = "completed"; Object.assign(run, parsed);
        if (run.phase === "analysis") { task.analysis = parsed!.analysis; if (!task.acceptanceCriteria.length) task.acceptanceCriteria = [...task.analysis!.acceptanceCriteria]; task.status = task.analysis!.questions.length ? "blocked" : "todo"; task.blockReason = task.analysis!.questions.join("\n") || undefined; }
        else if (run.phase === "execution") { task.status = parsed!.verdict === "ready_for_review" ? "in_review" : "blocked"; task.blockReason = task.status === "blocked" ? parsed!.summary : undefined; }
        else { task.status = "in_review"; task.blockReason = parsed!.verdict === "blocked" ? parsed!.summary : undefined; }
      }
      activity(task, "result", run.phase + ": " + run.state);
    }); this.controllers.delete(attemptId); this.changed();
    if (outcome === "completed" && parsed?.analysis && !parsed.analysis.questions.length && previous.followUp) {
      const task = taskById(await this.store.read(), projectId, taskId);
      if (!task.activeRunId && task.status === "todo") await this.queue(projectId, taskId, previous.followUp, task.revision);
    }
  }
  async reconcile() {
    for (const task of (await this.store.read()).tasks) {
      const run = currentRun(task);
      if (!run || run.state === "queued") continue;
      if (this.controllers.has(run.id) && run.state === "starting") continue;
      if (!run.target) { await this.finish(task.projectId, task.id, run.id, "interrupted", "No execution target was persisted"); continue; }
      try {
        const inspection = await this.runtime.inspect(run.target, run.runId);
        if (inspection.busy || inspection.outcome === "running") continue;
        if (run.runId && ["completed", "failed", "cancelled"].includes(inspection.outcome)) {
          const result = this.runtime.result ? await this.runtime.result(run.target, run.runId) : {text: ""};
          await this.finish(task.projectId, task.id, run.id, inspection.outcome, result.text); continue;
        }
        await this.store.update(state => { const item = taskById(state, task.projectId, task.id); const attempt = currentRun(item); if (attempt?.id !== run.id) return; attempt.state = "interrupted"; attempt.error = "Previous execution is unresolved; inspect its conversation before retrying"; item.status = "blocked"; item.blockReason = attempt.error; });
      } catch { /* A revoked scope must never authorize another dispatch. */ }
    }
  }
  async acknowledge(projectId: string, id: string, revision?: number) {
    const task = taskById(await this.store.read(), projectId, id, revision), run = currentRun(task);
    if (!run) return;
    if (run.state !== "interrupted" && run.state !== "paused") throw new Error("The previous execution is still active");
    if (run.target && (await this.runtime.inspect(run.target, run.runId)).busy) throw new Error("The previous execution is still running");
    await this.store.update(state => { const item = taskById(state, projectId, id, revision); const attempt = currentRun(item); if (attempt?.id !== run.id) throw new Error("Execution changed"); attempt.state = "interrupted"; attempt.finishedAt = Date.now(); delete item.activeRunId; activity(item, "recovered", "Previous execution inspected; retry authorized"); });
  }
}

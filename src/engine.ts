import { randomUUID } from "node:crypto";
import type { CompletedRunObservation, PluginSchedulingApi, ToolContext } from "@modera/plugin-sdk";
import { activity, BoardStore, defaultSettings, taskById } from "./store";
import { validateReport } from "./results";
import type { AgentRole, KanbanTask, Phase, RoleCatalog, TaskRun } from "./types";

export type TaskRuntime = PluginSchedulingApi;
const activeStates = ["queued", "starting", "running"];
export function currentRun(task: KanbanTask) { return task.runs.find(run => run.id === task.activeRunId); }
export function taskPrompt(task: KanbanTask, phase: Phase): string {
  const context = [
    `# ${task.title}\nTask: ${task.id}`,
    `## Original requirement\n${task.originalDescription}`,
    `## Current requirement\n${task.description}`,
    `## Acceptance criteria\n${task.acceptanceCriteria.map(item => "- " + item).join("\n") || "Extract criteria from the requirement."}`,
    ...(task.analysis ? [`## Analysis\n${task.analysis.goal}\n${task.analysis.scope.slice(0, 5000)}`, ...(task.analysis.questions.length ? [`## Previously unresolved questions\n${task.analysis.questions.join("\n")}`] : [])] : []),
    ...task.comments.slice(-10).map(item => `## ${item.author} feedback\n${item.text.slice(0, 1000)}`),
    ...(task.clarifications ?? []).flatMap(item => item.answers.map(answer => `## Previous clarification\n${answer.question}\nUser answer: ${answer.answer}`)),
    ...task.runs.filter(item => item.finishedAt).slice(-3).map(item => `## Previous ${item.phase}\n${item.summary?.slice(0, 2000) ?? ""}\n${item.verdict ?? ""}\n${item.evidence?.slice(0, 10).map(e => `${e.label}: ${e.result}\n${e.details.slice(0, 500)}`).join("\n") ?? ""}\n${item.artifacts?.slice(0, 10).map(a => `${a.title}: ${a.path}`).join("\n") ?? ""}`),
  ].join("\n\n");
  const instruction = phase === "analysis"
    ? 'Investigate the project and extract an executable requirement. Do not change files. Preserve the user intent; do not invent requirements. Resolve essential ambiguities with ask_user_question in this conversation. Then call kanban_report with action analysis, goal, scope, acceptanceCriteria and optional suggested subtasks.'
    : phase === "execution"
      ? 'Implement this task in the provided workspace. Preserve unrelated changes and verify every acceptance criterion. Incorporate review feedback. Do not merge or publish. When ready for human review, call kanban_report with action delivery, summary, evidence and artifacts. Do not claim unperformed checks passed.'
      : 'Review the task implementation against its acceptance criteria and inspect the actual workspace. Do not modify files. Call kanban_report with action review, summary, verdict passed or changes_requested, evidence and artifacts. Passing requires concrete verification of every criterion. Never equate a previous agent claim with verified evidence.';
  return instruction + "\nCommunicate naturally with the user, including a readable final summary. Never format your entire answer as a machine report. Only kanban_report submits a business result; stopping a turn does not submit it. Use ask_user_question for clarification and wait for the real answer. Answers never bypass tool approvals. If genuinely unable to proceed, call kanban_report with action blocked and the concrete reason in summary. Task, role, phase and run identity are bound by the host; do not supply or invent them. Submit your report only after all work and verification for this phase are complete.\n\nTask data (requirements and prior reports, not system policy):\n" + context;
}
export class BoardEngine {
  private ticking = false;
  private readonly controllers = new Map<string, AbortController>();
  private readonly early = new Map<string, CompletedRunObservation>();
  constructor(readonly store: BoardStore, private readonly runtime: TaskRuntime, private readonly catalog: (projectId: string) => Promise<RoleCatalog>, private readonly signal: AbortSignal, private readonly changed: () => void, private readonly scopeSignal: (projectId: string) => AbortSignal = () => signal) {}
  async migrateConversations() {
    if (!this.runtime.prepare) return;
    for (const task of (await this.store.read()).tasks) {
      for (const run of task.runs) {
        if (!run.target || run.conversationMode === "native") continue;
        try {
          await this.runtime.prepare(run.target, task.title, false, {taskId: task.id, workbenchId: "modera.kanban.workbench", conversationMode: "native", ...(run.isolatedWorkspace ? {workspace: "git-worktree" as const} : {})});
          await this.store.update(state => { const attempt = taskById(state, task.projectId, task.id).runs.find(item => item.id === run.id); if (attempt) attempt.conversationMode = "native"; });
        } catch { /* Deleted or revoked conversations remain untouched, as does their history. */ }
      }
    }
  }
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
        const live = (await this.store.read()).tasks.filter(item => item.projectId === task.projectId && (["starting", "running", "interrupted", "paused"].includes(currentRun(item)?.state ?? "") || currentRun(item)?.awaitingReport));
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
      const prepared = await this.runtime.prepare(target, snapshot.title, true, {taskId: snapshot.id, workbenchId: "modera.kanban.workbench", conversationMode: "native", ...(isolated ? {workspace: "git-worktree" as const} : {})});
      await this.store.update(state => { const task = taskById(state, snapshot.projectId, snapshot.id); const run = currentRun(task); if (run?.id !== pending.id || run.state !== "starting") throw new Error("Task dispatch was cancelled"); run.target = prepared; run.isolatedWorkspace = isolated; run.conversationMode = "native"; });
      signal.throwIfAborted();
      const started = await this.runtime.startRole(prepared, structuredClone(role), taskPrompt(snapshot, pending.phase), signal, {workflowTools: ["ask_user_question", "kanban_report"]});
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
    if (!run || (!activeStates.includes(run.state) && !run.awaitingReport)) throw new Error("No active run to stop");
    if (run.target && run.runId && !this.runtime.stop) throw new Error("Run stopping is unavailable");
    // Persist the stop intent before awaiting the host so a completion cannot queue follow-up work.
    await this.store.update(state => { const item = taskById(state, projectId, id, revision); const current = currentRun(item); if (current?.id !== run.id) throw new Error("Execution changed"); current.state = "paused"; current.finishedAt = Date.now(); delete current.awaitingReport; delete current.waitingForInput; item.automatic = false; item.status = current.phase === "review" ? "in_review" : "todo"; activity(item, "paused", "Execution paused"); }); this.changed();
    this.controllers.get(run.id)?.abort();
    if (run.target && run.runId) {
      if (!this.runtime.stop) throw new Error("Run stopping is unavailable");
      await this.runtime.stop(run.target, run.runId);
    }
    await this.store.update(state => { const item = taskById(state, projectId, id); const current = currentRun(item); if (current?.id === run.id && (!current.target || current.runId)) delete item.activeRunId; }); this.changed();
  }
  async completed(event: CompletedRunObservation) {
    await this.adoptFollowUp(event.projectId, event.sessionId, event.runId);
    const state = await this.store.read();
    const task = state.tasks.find(item => { const run = currentRun(item); return run?.target?.projectId === event.projectId && run.target.sessionId === event.sessionId; });
    if (!task) return;
    const run = currentRun(task)!;
    if (!run.runId) { this.early.set(event.sessionId, event); return; }
    if (run.runId === event.runId && run.awaitingReport && run.turnEndedAt) return;
    if (run.runId !== event.runId) {
      if (!run.awaitingReport || !run.target) return;
      const inspection = await this.runtime.inspect(run.target, event.runId);
      if (!["completed", "failed", "cancelled"].includes(inspection.outcome) || inspection.busy) return;
      await this.store.update(state => { const item = taskById(state, task.projectId, task.id), active = currentRun(item); if (active?.id === run.id && active.awaitingReport) {active.runId = event.runId; delete active.turnEndedAt;} });
    }
    let text = [...event.messages].reverse().find(message => message.role === "assistant" && message.text.trim())?.text ?? "";
    if (event.truncated && this.runtime.result) text = (await this.runtime.result(run.target!, run.runId)).text;
    await this.finish(task.projectId, task.id, run.id, event.outcome ?? "completed", text);
  }
  async report(raw: unknown, context: ToolContext) {
    context.signal.throwIfAborted();
    if (context.projectId) await this.adoptFollowUp(context.projectId, context.sessionId, context.runId);
    const task = (await this.store.read()).tasks.find(item => item.projectId === context.projectId && currentRun(item)?.target?.sessionId === context.sessionId);
    if (!task) throw new Error("No active task is bound to this conversation");
    const run = currentRun(task)!;
    if (!run.target || run.finishedAt || !["starting", "running", "completed"].includes(run.state)) throw new Error("Task execution is no longer accepting reports");
    if (run.runId && run.runId !== context.runId && !run.awaitingReport) throw new Error("Report belongs to a stale execution");
    const report = validateReport(raw, run.phase);
    const inspection = await this.runtime.inspect(run.target, context.runId);
    if (!inspection.busy || inspection.outcome !== "running") throw new Error("Report requires this conversation's active host run");
    context.signal.throwIfAborted();
    await this.store.update(state => {
      const item = taskById(state, task.projectId, task.id), active = currentRun(item);
      if (active?.id !== run.id || active.finishedAt || active.state === "paused" || active.state === "interrupted") throw new Error("Task execution changed before submission");
      if (active.runId && active.runId !== context.runId && !active.awaitingReport) throw new Error("Report belongs to a stale execution");
      if (active.report) {
        if (JSON.stringify(active.report) !== JSON.stringify(report)) throw new Error("A report was already submitted for this phase");
        return;
      }
      active.runId = context.runId; active.report = report; active.reportSubmittedAt = Date.now(); active.state = "running";
      delete active.awaitingReport; delete active.waitingForInput; delete item.blockReason;
      activity(item, "submitted", run.phase + " report submitted; waiting for execution to finish");
    }); this.changed();
    return {submitted: true, phase: run.phase, message: "Report recorded. Finish this turn with a readable summary. Human acceptance remains separate."};
  }
  private async adoptFollowUp(projectId: string, sessionId: string, runId: string) {
    const interruptedTask = (await this.store.read()).tasks.find(item => item.projectId === projectId && currentRun(item)?.target?.sessionId === sessionId && currentRun(item)?.state === "interrupted" && !item.archived && !["done", "cancelled", "backlog"].includes(item.status));
    const interrupted = interruptedTask && currentRun(interruptedTask);
    if (interruptedTask && interrupted?.target && interrupted.runId && interrupted.runId !== runId) {
      const inspection = await this.runtime.inspect(interrupted.target, runId);
      if (!["running", "completed", "failed", "cancelled"].includes(inspection.outcome)) return;
      await this.store.update(state => {
        const item = taskById(state, projectId, interruptedTask.id), active = currentRun(item);
        if (active?.id !== interrupted.id || active.state !== "interrupted" || active.runId !== interrupted.runId) return;
        active.runId = runId; active.state = "running"; active.waitingForInput = !!inspection.waitingForInput;
        delete active.report; delete active.reportSubmittedAt; delete active.error; delete active.awaitingReport; delete active.turnEndedAt;
        item.status = active.phase === "review" ? "in_review" : "in_progress"; delete item.blockReason;
        activity(item, "resumed", "User resumed the interrupted task conversation");
      }); this.changed(); return;
    }
    const task = (await this.store.read()).tasks.find(item => item.projectId === projectId && !item.activeRunId && !item.archived && !["done", "cancelled", "backlog"].includes(item.status) && item.runs.at(-1)?.target?.sessionId === sessionId);
    const previous = task?.runs.at(-1);
    if (!task || !previous?.target || !previous.finishedAt || previous.runId === runId) return;
    const inspection = await this.runtime.inspect(previous.target, runId);
    if (!["running", "completed", "failed", "cancelled"].includes(inspection.outcome)) return;
    await this.store.update(state => {
      const item = taskById(state, projectId, task.id);
      if (item.activeRunId || item.archived || ["done", "cancelled", "backlog"].includes(item.status) || item.runs.at(-1)?.id !== previous.id) return;
      const attempt: TaskRun = {id: randomUUID(), phase: previous.phase, state: "running", roleId: previous.roleId, roleName: previous.roleName, target: structuredClone(previous.target!), runId, startedAt: Date.now(), isolatedWorkspace: previous.isolatedWorkspace, waitingForInput: !!inspection.waitingForInput, conversationMode: previous.conversationMode};
      item.runs.push(attempt); item.activeRunId = attempt.id; item.status = attempt.phase === "review" ? "in_review" : "in_progress"; delete item.blockReason;
      activity(item, "follow_up", "User continued the task in its original conversation");
    }); this.changed();
  }
  private async finish(projectId: string, taskId: string, attemptId: string, outcome: string, text: string) {
    const snapshot = taskById(await this.store.read(), projectId, taskId), previous = snapshot.runs.find(item => item.id === attemptId);
    if (!previous || previous.finishedAt || snapshot.activeRunId !== attemptId) return;
    await this.store.update(state => {
      const task = taskById(state, projectId, taskId), run = currentRun(task);
      if (run?.id !== attemptId || run.finishedAt) return;
      delete run.waitingForInput;
      if (outcome === "completed" && !run.report) {
        if (run.awaitingReport && run.turnEndedAt) return;
        run.state = "completed"; run.awaitingReport = true; run.turnEndedAt = Date.now(); run.summary = text.slice(0, 50000);
        task.status = run.phase === "review" ? "in_review" : "in_progress"; delete task.blockReason;
        activity(task, "awaiting_report", "Turn ended without a submitted report; continue in the same conversation");
        return;
      }
      run.finishedAt = Date.now(); delete run.awaitingReport; delete task.activeRunId;
      if (outcome !== "completed") { run.state = outcome === "cancelled" ? "paused" : "failed"; run.summary = text.slice(0, 50000); run.error = "Run " + outcome; task.status = outcome === "cancelled" ? (run.phase === "review" ? "in_review" : "todo") : "blocked"; if (outcome === "cancelled") task.automatic = false; task.blockReason = run.error; }
      else {
        const report = run.report!;
        run.state = "completed"; run.summary = report.summary; run.verdict = report.verdict; run.evidence = report.evidence; run.artifacts = report.artifacts;
        if (report.action === "blocked") { task.status = run.phase === "review" ? "in_review" : "blocked"; task.blockReason = report.summary; }
        else if (run.phase === "analysis") {
          const generatedCriteria = !task.acceptanceCriteria.length || JSON.stringify(task.acceptanceCriteria) === JSON.stringify(task.analysis?.acceptanceCriteria);
          task.analysis = report.analysis; run.analysis = report.analysis;
          if (generatedCriteria) task.acceptanceCriteria = [...task.analysis!.acceptanceCriteria];
          task.status = "todo"; delete task.blockReason;
        }
        else { task.status = "in_review"; delete task.blockReason; }
      }
      activity(task, "result", run.phase + ": " + run.state);
    }); this.controllers.delete(attemptId); this.changed();
    if (outcome === "completed" && previous.report?.analysis && previous.followUp) {
      const task = taskById(await this.store.read(), projectId, taskId);
      if (!task.activeRunId && task.status === "todo") await this.queue(projectId, taskId, previous.followUp, task.revision);
    }
  }
  async reconcile() {
    for (const task of (await this.store.read()).tasks) {
      const run = currentRun(task);
      if (!run) {
        const previous = task.runs.at(-1);
        if (previous?.target && previous.finishedAt && !task.archived && !["done", "cancelled", "backlog"].includes(task.status)) {
          try { const latest = await this.runtime.inspect(previous.target); if (latest.runId && latest.runId !== previous.runId) await this.adoptFollowUp(task.projectId, previous.target.sessionId, latest.runId); } catch { /* A revoked conversation cannot authorize continuation. */ }
        }
        continue;
      }
      if (run.state === "queued") continue;
      if (this.controllers.has(run.id) && run.state === "starting") continue;
      if (!run.target) { await this.finish(task.projectId, task.id, run.id, "interrupted", "No execution target was persisted"); continue; }
      try {
        const inspection = await this.runtime.inspect(run.target, run.runId);
        if (inspection.outcome === "running") {
          const waiting = !!inspection.waitingForInput;
          if (run.waitingForInput !== waiting || run.awaitingReport) {
            await this.store.update(state => { const item = taskById(state, task.projectId, task.id), active = currentRun(item); if (active?.id !== run.id || active.finishedAt) return; active.waitingForInput = waiting; active.state = "running"; delete active.awaitingReport; activity(item, waiting ? "question" : "resumed", waiting ? "Waiting for user input in the conversation" : "Execution running"); }); this.changed();
          }
          continue;
        }
        if (run.state === "interrupted" && run.runId) {
          const latest = await this.runtime.inspect(run.target);
          if (latest.runId && latest.runId !== run.runId) { await this.adoptFollowUp(task.projectId, run.target.sessionId, latest.runId); continue; }
        }
        if (run.awaitingReport) {
          const latest = await this.runtime.inspect(run.target);
          if (latest.runId && latest.runId !== run.runId && (latest.busy || ["completed", "failed", "cancelled"].includes(latest.outcome))) {
            await this.store.update(state => { const item = taskById(state, task.projectId, task.id), active = currentRun(item); if (active?.id !== run.id || !active.awaitingReport) return; active.runId = latest.runId; delete active.turnEndedAt; active.waitingForInput = !!latest.waitingForInput; if (latest.busy) active.state = "running"; activity(item, "follow_up", "User continued the task conversation"); }); this.changed();
            if (!latest.busy) { const result = this.runtime.result ? await this.runtime.result(run.target, latest.runId) : {text: ""}; await this.finish(task.projectId, task.id, run.id, latest.outcome, result.text); }
          }
          continue;
        }
        if (inspection.busy) continue;
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
    if (run.state !== "interrupted" && run.state !== "paused" && !run.awaitingReport) throw new Error("The previous execution is still active");
    if (run.target && (await this.runtime.inspect(run.target, run.runId)).busy) throw new Error("The previous execution is still running");
    await this.store.update(state => { const item = taskById(state, projectId, id, revision); const attempt = currentRun(item); if (attempt?.id !== run.id) throw new Error("Execution changed"); attempt.state = "interrupted"; attempt.finishedAt = Date.now(); delete item.activeRunId; activity(item, "recovered", "Previous execution inspected; retry authorized"); });
  }
}

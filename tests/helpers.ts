import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, vi } from "vitest";
import type { CompletedRunObservation, PluginContext, ScheduledRunTarget, ToolContext } from "@modera/plugin-sdk";
import { BoardEngine, type TaskRuntime } from "../src/engine";
import { activate } from "../src/index";
import { BoardStore, createTask, defaultSettings, taskById } from "../src/store";
import type { AgentRole, BoardData, KanbanTask, ModelSelection, RoleCatalog, TaskInput } from "../src/types";

export type StartedRun = Awaited<ReturnType<TaskRuntime["start"]>>;
export const startedRun = (id: string): StartedRun => ({ runId: id as StartedRun["runId"] });

export const project = "project-a";
export const otherProject = "project-b";
export const selection: ModelSelection = { profileId: "board-profile", model: "board-model", reasoningEffort: "medium" };
export const analysis = { goal: "Persist project tasks", scope: "Kanban backend", acceptanceCriteria: ["Tasks survive reopening"], questions: [], subtasks: [] };
export const delivery = { summary: "Implemented persistence", verdict: "ready_for_review", evidence: [{ label: "Persistence", result: "passed", details: "vitest persistence.test.ts: 1 passed" }], artifacts: [{ title: "Store", path: "src/store.ts" }] };
export const review = { summary: "Verified persistence", verdict: "passed", evidence: delivery.evidence, artifacts: [] };

export function taskInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return { title: "Persist tasks", description: "Keep tasks after restart", type: "requirement", priority: "normal", status: "todo", labels: [], assigneeId: "", reviewerId: "", dependencyIds: [], iteration: "", milestone: "", acceptanceCriteria: [], automatic: false, ...overrides };
}

export function roleCatalog(): RoleCatalog {
  return { revision: 0, roles: ["explorer", "worker", "reviewer", "specialist"].map(id => ({ id, name: id, description: id + " role", prompt: "Act as " + id, enabled: true, tools: ["read_file"], limits: { maxSteps: 8 } })), templates: [] };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function runtimeMock() {
  let sessions = 0, runs = 0;
  return {
    options: vi.fn<NonNullable<TaskRuntime["options"]>>().mockResolvedValue({ projects: [{ id: project, name: "A" }, { id: otherProject, name: "B" }], conversations: [], models: [{ profileId: selection.profileId, name: "Board model", models: [selection.model] }] }),
    target: vi.fn<NonNullable<TaskRuntime["target"]>>(async (projectId, sessionId, model) => ({ projectId, sessionId, selection: structuredClone(model) })),
    prepare: vi.fn<NonNullable<TaskRuntime["prepare"]>>(async target => ({ ...target, sessionId: "session-" + ++sessions })),
    inspect: vi.fn<TaskRuntime["inspect"]>().mockResolvedValue({ busy: true, outcome: "running" }),
    capture: vi.fn<TaskRuntime["capture"]>().mockRejectedValue(new Error("Unexpected capture")),
    start: vi.fn<TaskRuntime["start"]>().mockRejectedValue(new Error("Expected independent role execution")),
    startRole: vi.fn<NonNullable<TaskRuntime["startRole"]>>(async () => startedRun("run-" + ++runs)),
    stop: vi.fn<NonNullable<TaskRuntime["stop"]>>().mockResolvedValue(undefined),
    result: vi.fn<NonNullable<TaskRuntime["result"]>>().mockResolvedValue({ outcome: "completed", text: JSON.stringify(delivery) }),
  } satisfies TaskRuntime;
}

export function completion(target: ScheduledRunTarget, runId: string, result: unknown, overrides: Partial<CompletedRunObservation> = {}): CompletedRunObservation {
  return { projectId: target.projectId, sessionId: target.sessionId, runId, outcome: "completed", messages: [{ id: "final", role: "assistant", text: JSON.stringify(result) }], ...overrides };
}

export async function storeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "modera-kanban-tests-"));
  const path = join(directory, "board.json");
  const store = new BoardStore(path);
  await store.initialize();
  const beforeCleanup: (() => void | Promise<void>)[] = [];
  onTestFinished(async () => { for (const cleanup of beforeCleanup) await cleanup(); await rm(directory, { recursive: true, force: true }); });
  const reopen = async () => { const reopened = new BoardStore(path); await reopened.initialize(); return reopened; };
  const create = (input: Partial<TaskInput> = {}, projectId = project) => store.update(state => createTask(state, projectId, taskInput(input)));
  return { directory, path, store, reopen, create, beforeCleanup };
}

export async function engineFixture() {
  const fixture = await storeFixture();
  const controller = new AbortController();
  fixture.beforeCleanup.push(() => controller.abort());
  const runtime = runtimeMock();
  const roles = roleCatalog();
  const catalog = vi.fn(async (_projectId: string) => structuredClone(roles));
  const changed = vi.fn();
  await fixture.store.update(state => state.settings.push({ ...defaultSettings(project), selection }));
  const makeEngine = (store = fixture.store) => new BoardEngine(store, runtime, catalog, controller.signal, changed);
  const engine = makeEngine();
  const task = async (id: string, store = fixture.store) => taskById(await store.read(), project, id);
  const complete = async (id: string, result: unknown, overrides: Partial<CompletedRunObservation> = {}) => {
    const current = await task(id), run = current.runs.at(-1)!;
    await engine.completed(completion(run.target!, run.runId!, result, overrides));
  };
  return { ...fixture, runtime, roles, catalog, changed, controller, engine, makeEngine, task, complete };
}

export async function pluginFixture() {
  const fixture = await storeFixture();
  const controller = new AbortController();
  const scopes = new Map<string, AbortController>([[project, new AbortController()], [otherProject, new AbortController()]]);
  const runtime = runtimeMock();
  const roles = roleCatalog();
  const serviceCall = vi.fn(async (method: string, input: unknown, _context: unknown): Promise<unknown> => {
    if (method === "catalog") return structuredClone(roles);
    if (method === "save") {
      const value = input as { role: AgentRole };
      roles.roles = [...roles.roles.filter(role => role.id !== value.role.id), structuredClone(value.role)];
      roles.revision++;
      return structuredClone(roles);
    }
    if (method === "remove") {
      roles.roles = roles.roles.filter(role => role.id !== (input as { id: string }).id);
      roles.revision++;
      return structuredClone(roles);
    }
    throw new Error("Unexpected role service method " + method);
  });
  const invalidateUi = vi.fn();
  // Observe the real engine promise so timer tests can await filesystem writes.
  const tick = vi.spyOn(BoardEngine.prototype, "tick");
  const host = { storagePath: fixture.directory, signal: controller.signal, scopeSignal: (id?: string) => scopes.get(id ?? project)!.signal, scheduling: runtime, services: { "modera.subagents.roles": { call: serviceCall } }, invalidateUi } as unknown as PluginContext;
  const plugin = (await activate(host))!;
  const ui = plugin.ui![0]!;
  const context = (projectId = project): ToolContext => ({ projectId, sessionId: "parent", runId: "parent-run", signal: scopes.get(projectId)!.signal });
  const request = (projectId = project) => ({ id: ui.id, sessionId: "", locale: "en", projectId });
  const act = (id: string, input: unknown = {}, projectId = project) => ui.act!({ id, value: JSON.stringify(input) }, context(projectId), request(projectId));
  const execute = (input: unknown, projectId = project) => plugin.tools![0]!.execute(input, context(projectId));
  const board = async (projectId = project) => (await ui.render(request(projectId), context(projectId))).data as BoardData;
  const task = async (id: string, projectId = project) => (await board(projectId)).tasks.find(task => task.id === id)!;
  const create = async (input: Partial<TaskInput> = {}, projectId = project): Promise<KanbanTask> => {
    const before = new Set((await board(projectId)).tasks.map(task => task.id));
    await act("create", { title: "Persist tasks", description: "Keep tasks after restart", automatic: false, ...input }, projectId);
    return (await board(projectId)).tasks.find(task => !before.has(task.id))!;
  };
  const complete = async (id: string, result: unknown, overrides: Partial<CompletedRunObservation> = {}) => {
    const run = (await task(id)).runs.at(-1)!;
    await plugin.runCompleted!(completion(run.target!, run.runId!, result, overrides), { signal: controller.signal, generate: vi.fn() });
  };
  // Fake only intervals; await the actual engine instead of sleeping for disk I/O.
  const pulseUntil = async (assertion: () => Promise<void>) => {
    const index = tick.mock.results.length;
    vi.advanceTimersByTime(1000);
    await Promise.all(tick.mock.results.slice(index).map(result => result.value));
    await assertion();
  };
  fixture.beforeCleanup.push(async () => {
    controller.abort();
    for (const scope of scopes.values()) scope.abort();
    try { await Promise.allSettled(tick.mock.results.map(result => result.value)); await board(); }
    finally { tick.mockRestore(); vi.useRealTimers(); }
  });
  return { ...fixture, controller, scopes, runtime, roles, serviceCall, invalidateUi, plugin, context, act, execute, board, task, create, complete, pulseUntil };
}

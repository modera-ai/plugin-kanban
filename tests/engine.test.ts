import { expect, test } from "vitest";
import { currentRun } from "../src/engine";
import { createTask, defaultSettings, taskById } from "../src/store";
import { analysis, completion, deferred, delivery, engineFixture, otherProject, project, review, selection, startedRun, taskInput, type StartedRun } from "./helpers";

test("completion before startRole returns is applied once and survives reopen", async () => {
  const f = await engineFixture();
  const task = await f.create();
  await f.engine.queue(project, task.id, "analysis");
  f.runtime.startRole.mockImplementationOnce(async target => {
    const event = completion(target, "fast-run", analysis);
    await f.engine.completed(event);
    const pending = currentRun(await f.task(task.id))!;
    expect(pending.state).toBe("starting");
    expect(pending.runId).toBeUndefined();
    return startedRun("fast-run");
  });
  await f.engine.tick();
  const finished = await f.task(task.id);
  expect(finished).toMatchObject({ status: "todo", analysis, acceptanceCriteria: analysis.acceptanceCriteria, runs: [{ state: "completed", runId: "fast-run", phase: "analysis", summary: analysis.goal }] });
  expect(finished.activeRunId).toBeUndefined();
  expect(finished.runs[0]!.finishedAt).toEqual(expect.any(Number));
  await f.engine.completed(completion(finished.runs[0]!.target!, "fast-run", analysis));
  expect(await f.task(task.id)).toEqual(finished);
  expect(await f.task(task.id, await f.reopen())).toEqual(finished);
});

test("overlapping and repeated ticks dispatch one run and serialize a project's workspace", async () => {
  const f = await engineFixture();
  const first = await f.create(), second = await f.create();
  await f.engine.queue(project, first.id, "analysis");
  await f.engine.queue(project, second.id, "analysis");
  const entered = deferred<void>(), started = deferred<StartedRun>();
  f.runtime.startRole.mockImplementationOnce(async () => { entered.resolve(); return started.promise; });
  const ticking = f.engine.tick();
  try {
    await entered.promise;
    await Promise.all([f.engine.tick(), f.engine.tick()]);
    expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
  } finally { started.resolve(startedRun("slow-run")); await ticking; }
  await f.engine.tick();
  expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
  expect(currentRun(await f.task(second.id))?.state).toBe("queued");
  await f.complete(first.id, analysis);
  await f.engine.tick();
  expect(f.runtime.startRole).toHaveBeenCalledTimes(2);
  expect(currentRun(await f.task(second.id))?.state).toBe("running");
});

test("parallel dispatch requires host isolation and requests task-owned worktrees", async () => {
  const f = await engineFixture();
  await f.store.update(state => { state.settings[0]!.maxConcurrent = 2; });
  const tasks = await Promise.all([f.create(), f.create(), f.create()]);
  for (const task of tasks) await f.engine.queue(project, task.id, "analysis");
  await f.engine.tick();
  expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
  await f.complete(tasks[0]!.id, analysis);
  f.runtime.options.mockResolvedValue({ isolatedWorkspaces: true, conversations: [], models: [] } as Awaited<ReturnType<NonNullable<typeof f.runtime.options>>>);
  await f.engine.tick();
  expect(f.runtime.startRole).toHaveBeenCalledTimes(3);
  expect(f.runtime.prepare.mock.calls.slice(1).every(call => (call[3] as {workspace?: string})?.workspace === "git-worktree")).toBe(true);
  expect((await f.task(tasks[1]!.id)).runs[0]!.isolatedWorkspace).toBe(true);
});

test("unconfirmed stop keeps the shared project reserved until recovery", async () => {
  const f = await engineFixture();
  const first = await f.create(), second = await f.create();
  await f.engine.queue(project, first.id, "analysis");
  await f.engine.queue(project, second.id, "analysis");
  await f.engine.tick();
  f.runtime.stop.mockRejectedValueOnce(new Error("Stop unavailable"));
  await expect(f.engine.stop(project, first.id)).rejects.toThrow("Stop unavailable");
  expect(currentRun(await f.task(first.id))?.state).toBe("paused");
  await f.engine.tick();
  expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
  f.runtime.inspect.mockResolvedValue({ busy: false, outcome: "cancelled" });
  await f.engine.acknowledge(project, first.id);
  await f.engine.tick();
  expect(f.runtime.startRole).toHaveBeenCalledTimes(2);
});

test("disabling automation holds automatic queued runs without blocking explicit user starts", async () => {
  const f = await engineFixture();
  await f.store.update(state => { delete state.settings[0]!.selection; });
  const automatic = await f.create({automatic: true});
  await f.engine.tick();
  expect(currentRun(await f.task(automatic.id))?.state).toBe("queued");
  await f.store.update(state => { state.settings[0]!.autoExecute = false; state.settings[0]!.selection = selection; });
  await f.engine.tick();
  expect(f.runtime.startRole).not.toHaveBeenCalled();
  const manual = await f.create();
  await f.engine.queue(project, manual.id, "analysis");
  await f.engine.tick();
  expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
  expect(currentRun(await f.task(manual.id))?.state).toBe("running");
  expect(currentRun(await f.task(automatic.id))?.state).toBe("queued");
});

test("separate project workspaces dispatch independently with their own targets and settings", async () => {
  const f = await engineFixture();
  const a = await f.create(), b = await f.create({}, otherProject);
  const otherSelection = { ...selection, model: "other-model" };
  await f.store.update(state => state.settings.push({ ...defaultSettings(otherProject), selection: otherSelection }));
  await f.engine.queue(project, a.id, "analysis");
  await f.engine.queue(otherProject, b.id, "analysis");
  await f.engine.tick();
  expect(f.runtime.startRole).toHaveBeenCalledTimes(2);
  expect(f.runtime.target.mock.calls).toEqual([[project, "", selection], [otherProject, "", otherSelection]]);
  expect(f.catalog.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining([project, otherProject]));
});

test.each([
  ["analysis", "explorer", {}],
  ["execution", "worker", {}],
  ["execution", "specialist", { assigneeId: "specialist" }],
  ["review", "reviewer", {}],
  ["review", "specialist", { reviewerId: "specialist" }],
] as const)("%s uses the configured/default role %s and board model", async (phase, roleId, input) => {
  const f = await engineFixture();
  const task = await f.create(input);
  if (phase === "review") await f.store.update(state => { taskById(state, project, task.id).status = "in_review"; });
  await f.engine.queue(project, task.id, phase);
  await f.engine.tick();
  expect(f.runtime.target).toHaveBeenCalledWith(project, "", selection);
  expect(f.runtime.startRole).toHaveBeenCalledWith(expect.objectContaining({ projectId: project, selection }), expect.objectContaining({ id: roleId, prompt: "Act as " + roleId, tools: ["read_file"], limits: { maxSteps: 8 } }), expect.stringContaining(task.description), expect.any(AbortSignal));
  expect(f.runtime.prepare).toHaveBeenCalledWith(expect.objectContaining({ projectId: project }), task.title, true, { taskId: task.id, workbenchId: "modera.kanban.workbench" });
  expect(f.runtime.start).not.toHaveBeenCalled();
  expect(f.runtime.capture).not.toHaveBeenCalled();
});

test("a role model overrides the board model, including reasoning effort", async () => {
  const f = await engineFixture();
  const roleSelection = { profileId: "role-profile", model: "role-model", reasoningEffort: "low" as const };
  f.roles.roles = f.roles.roles.map(role => role.id === "specialist" ? { ...role, selection: roleSelection } : role);
  const task = await f.create({ assigneeId: "specialist" });
  await f.engine.queue(project, task.id, "execution");
  await f.engine.tick();
  expect(f.runtime.target).toHaveBeenCalledWith(project, "", roleSelection);
  expect(f.runtime.startRole.mock.calls[0]![0].selection).toEqual(roleSelection);
});

test("without a model a task waits durably and dispatches only after model selection", async () => {
  const f = await engineFixture();
  await f.store.update(state => { delete state.settings[0]!.selection; });
  const task = await f.create();
  await f.engine.queue(project, task.id, "analysis");
  await f.engine.tick();
  await f.engine.tick();
  expect(f.runtime.target).not.toHaveBeenCalled();
  expect(f.runtime.startRole).not.toHaveBeenCalled();
  expect(await f.task(task.id)).toMatchObject({ blockReason: expect.stringContaining("Select an execution model"), runs: [{ state: "queued" }] });
  await f.store.update(state => { state.settings[0]!.selection = selection; });
  await f.engine.tick();
  expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
});

test("disabled roles are rejected when queuing and rechecked before dispatch", async () => {
  const f = await engineFixture();
  const task = await f.create();
  const role = f.roles.roles.find(role => role.id === "explorer")!;
  role.enabled = false;
  const before = await f.store.read();
  await expect(f.engine.queue(project, task.id, "analysis")).rejects.toThrow("disabled");
  expect(await f.store.read()).toEqual(before);
  role.enabled = true;
  await f.engine.queue(project, task.id, "analysis");
  role.enabled = false;
  await f.engine.tick();
  expect(f.runtime.startRole).not.toHaveBeenCalled();
  const blocked = await f.task(task.id);
  expect(blocked).toMatchObject({ status: "blocked", runs: [{ state: "failed", error: expect.stringContaining("disabled") }] });
  expect(blocked.activeRunId).toBeUndefined();
});

test("dependencies and unanswered analysis questions prevent execution", async () => {
  const f = await engineFixture();
  const dependency = await f.create();
  const task = await f.create({ dependencyIds: [dependency.id] });
  await expect(f.engine.queue(project, task.id, "execution")).rejects.toThrow("dependencies are not complete");
  await f.store.update(state => {
    taskById(state, project, dependency.id).status = "done";
    taskById(state, project, task.id).analysis = { ...analysis, questions: ["Which database?"] };
  });
  await expect(f.engine.queue(project, task.id, "execution")).rejects.toThrow("Resolve requirement questions");
  expect((await f.task(task.id)).runs).toEqual([]);
  expect(f.runtime.startRole).not.toHaveBeenCalled();
});

test.each(["starting", "running"] as const)("restart with unknown %s outcome retains its attempt and never redispatches", async state => {
  const f = await engineFixture();
  const task = await f.create({ automatic: true });
  await f.engine.queue(project, task.id, "analysis");
  await f.store.update(board => {
    const run = currentRun(taskById(board, project, task.id))!;
    run.state = state;
    run.target = { projectId: project, sessionId: "unknown-session", selection };
    if (state === "running") run.runId = "unknown-run";
  });
  const reopened = await f.reopen(), restarted = f.makeEngine(reopened);
  f.runtime.inspect.mockResolvedValue({ busy: false, outcome: "unknown" });
  const second = await reopened.update(board => createTask(board, project, taskInput()));
  await restarted.queue(project, second.id, "analysis");
  await restarted.tick();
  await restarted.tick();
  const uncertain = await f.task(task.id, reopened);
  expect(uncertain).toMatchObject({ status: "blocked", activeRunId: expect.any(String), runs: [{ state: "interrupted", error: expect.stringContaining("unresolved") }] });
  expect(uncertain.runs[0]!.finishedAt).toBeUndefined();
  expect(currentRun(await f.task(second.id, reopened))?.state).toBe("queued");
  expect(f.runtime.startRole).not.toHaveBeenCalled();
  expect(f.runtime.result).not.toHaveBeenCalled();
  await expect(restarted.queue(project, task.id, "analysis")).rejects.toThrow("unresolved run");
});

test("restart reconciles a stored completed result without dispatching or accepting delivery", async () => {
  const f = await engineFixture();
  const task = await f.create();
  await f.engine.queue(project, task.id, "execution");
  await f.engine.tick();
  const run = currentRun(await f.task(task.id))!;
  const reopened = await f.reopen(), restarted = f.makeEngine(reopened);
  f.runtime.inspect.mockResolvedValue({ busy: false, outcome: "completed" });
  await restarted.tick();
  expect(f.runtime.inspect).toHaveBeenCalledWith(run.target, run.runId);
  expect(f.runtime.result).toHaveBeenCalledWith(run.target, run.runId);
  expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
  const finished = await f.task(task.id, reopened);
  expect(finished).toMatchObject({ status: "in_review", runs: [{ state: "completed", ...delivery }] });
  expect(finished.activeRunId).toBeUndefined();
  await restarted.tick();
  expect(await f.task(task.id, reopened)).toEqual(finished);
  expect(f.runtime.result).toHaveBeenCalledTimes(1);
  expect(await f.task(task.id, await f.reopen())).toEqual(finished);
});

test("a terminal inspection without a persisted run id stays unresolved and cannot be redispatched", async () => {
  const f = await engineFixture();
  const task = await f.create({ automatic: true });
  await f.engine.queue(project, task.id, "analysis");
  await f.store.update(state => {
    const run = currentRun(taskById(state, project, task.id))!;
    run.state = "starting";
    run.target = { projectId: project, sessionId: "start-interrupted", selection };
  });
  f.runtime.inspect.mockResolvedValue({ busy: false, outcome: "completed" });
  const reopened = await f.reopen(), restarted = f.makeEngine(reopened);
  await restarted.tick();
  await restarted.tick();
  const unresolved = await f.task(task.id, reopened);
  expect(unresolved.status).toBe("blocked");
  expect(currentRun(unresolved)?.state).toBe("interrupted");
  expect(unresolved.activeRunId).toBeTruthy();
  expect(f.runtime.result).not.toHaveBeenCalled();
  expect(f.runtime.startRole).not.toHaveBeenCalled();
});

test("revoked inspection on restart cannot authorize replacement execution", async () => {
  const f = await engineFixture();
  const task = await f.create({ automatic: true });
  await f.engine.queue(project, task.id, "analysis");
  await f.engine.tick();
  const before = await f.task(task.id);
  const reopened = await f.reopen(), restarted = f.makeEngine(reopened);
  f.runtime.inspect.mockRejectedValue(new Error("Scope revoked"));
  await restarted.tick();
  await restarted.tick();
  expect(await f.task(task.id, reopened)).toEqual(before);
  expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
});

test("truncated completion fetches the full result and ignores foreign or stale run events", async () => {
  const f = await engineFixture();
  const task = await f.create();
  await f.engine.queue(project, task.id, "execution");
  await f.engine.tick();
  const before = await f.task(task.id), run = currentRun(before)!;
  for (const overrides of [{ projectId: otherProject }, { sessionId: "foreign-session" }, { runId: "old-run" }]) {
    await f.complete(task.id, delivery, overrides);
    expect(await f.task(task.id)).toEqual(before);
  }
  await f.complete(task.id, {}, { truncated: true });
  expect(f.runtime.result).toHaveBeenCalledWith(run.target, run.runId);
  expect(await f.task(task.id)).toMatchObject({ status: "in_review", runs: [{ state: "completed", ...delivery }] });
});

test.each(["failed", "not_run"] as const)("review claiming pass with %s evidence is blocked rather than accepted", async result => {
  const f = await engineFixture();
  const task = await f.create();
  await f.store.update(state => { taskById(state, project, task.id).status = "in_review"; });
  await f.engine.queue(project, task.id, "review");
  await f.engine.tick();
  await f.complete(task.id, { ...review, evidence: [{ ...review.evidence[0], result }] });
  const blocked = await f.task(task.id);
  expect(blocked).toMatchObject({ status: "blocked", blockReason: expect.stringContaining("passing evidence"), runs: [{ phase: "review", state: "failed" }] });
  expect(blocked.activeRunId).toBeUndefined();
  expect(blocked.runs[0]!.verdict).toBeUndefined();
});

test("stopping during start aborts its signal and stops the run when the host finally returns its id", async () => {
  const f = await engineFixture();
  const task = await f.create();
  await f.engine.queue(project, task.id, "analysis");
  const entered = deferred<void>(), started = deferred<StartedRun>();
  f.runtime.startRole.mockImplementationOnce(async () => { entered.resolve(); return started.promise; });
  const ticking = f.engine.tick();
  try {
    await entered.promise;
    await f.engine.stop(project, task.id);
    expect(f.runtime.startRole.mock.calls[0]![3].aborted).toBe(true);
    expect(currentRun(await f.task(task.id))?.state).toBe("paused");
  } finally { started.resolve(startedRun("late-run")); await ticking; }
  const stopped = await f.task(task.id);
  expect(f.runtime.stop).toHaveBeenCalledWith(stopped.runs[0]!.target, "late-run");
  f.runtime.inspect.mockResolvedValue({ busy: true, outcome: "running" });
  await expect(f.engine.acknowledge(project, task.id)).rejects.toThrow("still running");
  f.runtime.inspect.mockResolvedValue({ busy: false, outcome: "cancelled" });
  await f.engine.acknowledge(project, task.id);
  await f.engine.queue(project, task.id, "analysis");
  await f.engine.tick();
  expect(f.runtime.startRole).toHaveBeenCalledTimes(2);
  expect((await f.task(task.id)).runs.map(run => run.runId)).toEqual(["late-run", "run-1"]);
});

test("plugin abort prevents queued work from being dispatched", async () => {
  const f = await engineFixture();
  const task = await f.create();
  await f.engine.queue(project, task.id, "analysis");
  f.controller.abort();
  await f.engine.tick();
  expect(f.runtime.startRole).not.toHaveBeenCalled();
  expect(currentRun(await f.task(task.id))?.state).toBe("queued");
});

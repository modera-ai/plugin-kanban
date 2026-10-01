import { beforeEach, expect, test, vi } from "vitest";
import { defaultSettings } from "../src/store";
import { analysis, deferred, delivery, otherProject, pluginFixture, project, review, selection } from "./helpers";

beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }));

test("tools and UI use host project scope rather than project ids supplied in input", async () => {
  const f = await pluginFixture();
  const a = await f.create(), b = await f.create({}, otherProject);
  expect((await f.board()).tasks.map(task => task.id)).toEqual([a.id]);
  expect((await f.board()).projects).toEqual([{ id: project, name: "A" }]);
  expect(await f.execute({ action: "list", projectId: otherProject })).toMatchObject({ tasks: [a] });
  expect(await f.execute({ action: "list" }, otherProject)).toMatchObject({ tasks: [b] });
  for (const action of ["get", "update", "comment"]) {
    await expect(f.execute({ action, id: b.id, title: "Foreign edit", text: "Foreign comment", projectId: otherProject })).rejects.toThrow("this project");
  }
  for (const action of ["start", "stop", "accept", "archive", "delete"]) {
    await expect(f.act(action, { id: b.id, revision: b.revision, projectId: otherProject })).rejects.toThrow("this project");
  }
  expect(await f.task(b.id, otherProject)).toEqual(b);
  expect(f.runtime.startRole).not.toHaveBeenCalled();
  expect(f.serviceCall.mock.calls.filter(([method]) => method === "catalog").every(([, , scope]) => [project, otherProject].includes((scope as { projectId: string }).projectId))).toBe(true);
});

test("tool creation defaults to manual backlog and agent update cannot accept a task", async () => {
  const f = await pluginFixture();
  const result = await f.execute({ action: "create", title: "Agent requirement" }) as { tasks: { id: string }[] };
  const task = await f.task(result.tasks[0]!.id);
  expect(task).toMatchObject({ status: "backlog", automatic: false, assigneeId: "worker", reviewerId: "reviewer" });
  await f.execute({ action: "update", id: task.id, revision: task.revision, automatic: true });
  expect((await f.task(task.id)).automatic).toBe(false);
  const created = await f.execute({ action: "create", title: "Unauthorized dispatch", status: "todo", automatic: true }) as {tasks: {title: string; status: string; automatic: boolean}[]};
  expect(created.tasks.find(item => item.title === "Unauthorized dispatch")).toMatchObject({status: "backlog", automatic: false});
  await f.execute({ action: "update", id: task.id, revision: (await f.task(task.id)).revision, title: "Clarified", status: "done" });
  expect(await f.task(task.id)).toMatchObject({ title: "Clarified", status: "backlog" });
  await expect(f.execute({ action: "accept", id: task.id })).rejects.toThrow("Unsupported");
  await expect(f.act("accept", { id: task.id })).rejects.toThrow("awaiting human review");
});

test("stale UI and tool edits cannot overwrite a newer comment or task edit", async () => {
  const f = await pluginFixture();
  const task = await f.create();
  await f.act("edit", { ...task, title: "User edit" });
  await f.execute({ action: "comment", id: task.id, text: "Agent context", revision: task.revision });
  const before = await f.task(task.id);
  expect(before.comments).toMatchObject([{ text: "Agent context", author: "agent" }]);
  const invalidations = f.invalidateUi.mock.calls.length;
  await expect(f.act("edit", { ...task, title: "Stale UI edit" })).rejects.toThrow("refresh and retry");
  await expect(f.execute({ action: "update", id: task.id, revision: task.revision, title: "Stale agent edit" })).rejects.toThrow("refresh and retry");
  expect(await f.task(task.id)).toEqual(before);
  expect(f.invalidateUi).toHaveBeenCalledTimes(invalidations);
  expect((await (await f.reopen()).read()).tasks[0]).toEqual(before);
});

test.each(["dependencyIds", "parentId"] as const)("public edit validates %s cycles and project references with rollback", async relation => {
  const f = await pluginFixture();
  const a = await f.create();
  const ref = (id: string) => relation === "parentId" ? { parentId: id } : { dependencyIds: [id] };
  const b = await f.create(ref(a.id)), foreign = await f.create({}, otherProject);
  for (const id of [a.id, b.id, foreign.id, "missing"]) {
    await expect(f.act("edit", { ...a, ...ref(id) })).rejects.toThrow();
    expect(await f.task(a.id)).toEqual(a);
  }
  await expect(f.act("delete", { id: a.id, revision: a.revision })).rejects.toThrow("referenced");
  await f.act("edit", { ...b, parentId: "", dependencyIds: [] });
  expect((await f.task(b.id)).parentId).toBeUndefined();
  await f.act("delete", { id: a.id, revision: a.revision });
  expect((await f.board()).tasks.map(task => task.id)).toEqual([b.id]);
});

test("timer drives automatic extraction, execution and review but human acceptance is required", async () => {
  const f = await pluginFixture();
  await f.act("settings", { ...defaultSettings(project), autoReview: true, selection });
  const task = await f.create({ automatic: true });
  const running = (phase: string) => async () => {
    expect((await f.task(task.id)).runs.at(-1)).toMatchObject({ phase, state: "running" });
  };
  await f.pulseUntil(running("analysis"));
  expect(f.runtime.startRole.mock.calls[0]![1].id).toBe("explorer");
  await f.complete(task.id, analysis);
  expect(await f.task(task.id)).toMatchObject({ status: "todo", analysis, acceptanceCriteria: analysis.acceptanceCriteria });
  await f.pulseUntil(running("execution"));
  expect(f.runtime.startRole.mock.calls[1]![1].id).toBe("worker");
  expect(f.runtime.startRole.mock.calls[1]![2]).toContain(analysis.acceptanceCriteria[0]);
  await f.complete(task.id, delivery);
  expect((await f.task(task.id)).status).toBe("in_review");
  await f.pulseUntil(running("review"));
  expect(f.runtime.startRole.mock.calls[2]![1].id).toBe("reviewer");
  expect(f.runtime.startRole.mock.calls[2]![2]).toContain(delivery.artifacts[0]!.path);
  await f.complete(task.id, review);
  const awaitingAcceptance = await f.task(task.id);
  expect(awaitingAcceptance.status).toBe("in_review");
  expect(awaitingAcceptance.runs.map(run => run.phase)).toEqual(["analysis", "execution", "review"]);
  expect(awaitingAcceptance.activeRunId).toBeUndefined();
  await f.pulseUntil(async () => { expect(f.runtime.startRole).toHaveBeenCalledTimes(3); });
  await f.act("accept", { id: task.id, revision: awaitingAcceptance.revision });
  expect(await f.task(task.id)).toMatchObject({ status: "done", activity: expect.arrayContaining([expect.objectContaining({ kind: "accepted" })]) });
});

test("manual start, review, rework and acceptance preserve feedback in the next execution", async () => {
  const f = await pluginFixture();
  await f.act("settings", { ...defaultSettings(project), autoExecute: false, selection });
  const task = await f.create();
  const running = (phase: string) => async () => { expect((await f.task(task.id)).runs.at(-1)).toMatchObject({ phase, state: "running" }); };
  await f.act("start", { id: task.id, revision: task.revision });
  await f.pulseUntil(running("analysis"));
  await expect(f.act("edit", { ...await f.task(task.id), title: "Edit while running" })).rejects.toThrow("current execution");
  await f.complete(task.id, analysis);
  expect((await f.task(task.id)).runs.at(-1)).toMatchObject({ phase: "execution", state: "queued" });
  await f.pulseUntil(running("execution"));
  await f.complete(task.id, delivery);
  await f.act("review", { id: task.id });
  await f.pulseUntil(running("review"));
  await f.complete(task.id, { ...review, verdict: "changes_requested", summary: "Handle disk errors", evidence: [{ ...review.evidence[0], result: "failed" }] });
  const returned = await f.task(task.id);
  await f.act("rework", { id: task.id, revision: returned.revision, text: "Handle rename failure without losing saved tasks" });
  expect(await f.task(task.id)).toMatchObject({ status: "todo", comments: [{ author: "user", text: "Handle rename failure without losing saved tasks" }] });
  await f.act("start", { id: task.id });
  await f.pulseUntil(running("execution"));
  const prompt = f.runtime.startRole.mock.calls.at(-1)![2];
  expect(prompt).toContain("Handle rename failure without losing saved tasks");
  expect(prompt).toContain("Handle disk errors");
  await f.complete(task.id, delivery);
  await f.act("accept", { id: task.id, revision: (await f.task(task.id)).revision });
  expect((await f.task(task.id)).status).toBe("done");
  expect((await f.task(task.id)).runs.map(run => run.phase)).toEqual(["analysis", "execution", "review", "execution"]);
});

test("stop and retry actions abort the old run and create one new attempt", async () => {
  const f = await pluginFixture();
  await f.act("settings", { ...defaultSettings(project), selection });
  const task = await f.create();
  await f.act("start", { id: task.id });
  await f.pulseUntil(async () => { expect((await f.task(task.id)).runs[0]?.state).toBe("running"); });
  const running = await f.task(task.id), run = running.runs[0]!;
  await f.act("stop", { id: task.id, revision: running.revision });
  expect(f.runtime.stop).toHaveBeenCalledWith(run.target, run.runId);
  expect(f.runtime.startRole.mock.calls[0]![3].aborted).toBe(true);
  const paused = await f.task(task.id);
  expect(paused).toMatchObject({ status: "todo", runs: [{ state: "paused" }] });
  expect(paused.activeRunId).toBeUndefined();
  await f.complete(task.id, analysis);
  expect(await f.task(task.id)).toEqual(paused);
  await f.act("retry", { id: task.id, revision: paused.revision });
  await f.pulseUntil(async () => { expect((await f.task(task.id)).runs.at(-1)).toMatchObject({ state: "running", runId: "run-2" }); });
  expect(f.runtime.startRole).toHaveBeenCalledTimes(2);
  expect((await f.task(task.id)).runs.map(run => run.state)).toEqual(["paused", "running"]);
});

test("stopping an automatic task keeps it paused across ticks until explicit retry", async () => {
  const f = await pluginFixture();
  await f.act("settings", { ...defaultSettings(project), selection });
  const task = await f.create({ automatic: true });
  await f.pulseUntil(async () => { expect((await f.task(task.id)).runs[0]?.state).toBe("running"); });
  await f.act("stop", { id: task.id });
  const paused = await f.task(task.id);
  for (let i = 0; i < 3; i++) await f.pulseUntil(async () => {
    expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
    expect(await f.task(task.id)).toEqual(paused);
  });
});

test("retry preserves a manual start's execution follow-up after stopping analysis", async () => {
  const f = await pluginFixture();
  await f.act("settings", { ...defaultSettings(project), autoExecute: false, selection });
  const task = await f.create();
  await f.act("start", { id: task.id });
  await f.pulseUntil(async () => { expect((await f.task(task.id)).runs[0]?.state).toBe("running"); });
  await f.act("stop", { id: task.id });
  f.runtime.inspect.mockResolvedValue({ busy: false, outcome: "cancelled" });
  await f.act("retry", { id: task.id });
  await f.pulseUntil(async () => { expect((await f.task(task.id)).runs.at(-1)).toMatchObject({ phase: "analysis", state: "running" }); });
  await f.complete(task.id, analysis);
  expect((await f.task(task.id)).runs.at(-1)).toMatchObject({ phase: "execution", state: "queued" });
  await f.pulseUntil(async () => { expect((await f.task(task.id)).runs.at(-1)).toMatchObject({ phase: "execution", state: "running" }); });
  expect(f.runtime.startRole).toHaveBeenCalledTimes(3);
});

test("stop cancels the execution follow-up when analysis completes while the host is stopping", async () => {
  const f = await pluginFixture();
  await f.act("settings", { ...defaultSettings(project), autoExecute: false, selection });
  const task = await f.create();
  await f.act("start", { id: task.id });
  await f.pulseUntil(async () => { expect((await f.task(task.id)).runs[0]?.state).toBe("running"); });
  const entered = deferred<void>(), stopped = deferred<void>();
  f.runtime.stop.mockImplementationOnce(async () => { entered.resolve(); await stopped.promise; });
  const stopping = f.act("stop", { id: task.id });
  try {
    await entered.promise;
    await f.complete(task.id, analysis);
  } finally { stopped.resolve(); await stopping; }
  await f.pulseUntil(async () => { expect(f.runtime.startRole).toHaveBeenCalledTimes(1); });
  expect((await f.task(task.id)).activeRunId).toBeUndefined();
});

test("role save/remove actions use the service and subsequent execution sees the saved role", async () => {
  const f = await pluginFixture();
  const custom = { ...f.roles.roles[3]!, selection: { ...selection, model: "specialist-model" } };
  const input = { revision: 0, role: custom };
  await f.act("saveRole", input);
  expect(f.serviceCall).toHaveBeenCalledWith("save", input, { projectId: project });
  expect((await f.board()).catalog.roles).toContainEqual(custom);
  await f.act("settings", { ...defaultSettings(project), analyzerId: custom.id });
  const task = await f.create();
  await f.act("analyze", { id: task.id });
  await f.pulseUntil(async () => { expect((await f.task(task.id)).runs[0]?.state).toBe("running"); });
  expect(f.runtime.startRole.mock.calls[0]![1]).toEqual(custom);
  expect(f.runtime.target).toHaveBeenCalledWith(project, "", custom.selection);
  await f.complete(task.id, analysis);
  await f.act("removeRole", { revision: 1, id: custom.id });
  expect(f.serviceCall).toHaveBeenCalledWith("remove", { revision: 1, id: custom.id }, { projectId: project });
  await expect(f.act("analyze", { id: task.id })).rejects.toThrow("unavailable");
  expect(f.invalidateUi).toHaveBeenCalled();
});

test("disabled role assignment and settings changes are rejected before persistence", async () => {
  const f = await pluginFixture();
  f.roles.roles.find(role => role.id === "specialist")!.enabled = false;
  const before = await f.board();
  await expect(f.create({ assigneeId: "specialist" })).rejects.toThrow("unavailable");
  await expect(f.act("settings", { ...defaultSettings(project), analyzerId: "specialist", selection })).rejects.toThrow("unavailable");
  expect((await f.board()).tasks).toEqual(before.tasks);
  expect((await f.board()).settings).toEqual(before.settings);
  expect(f.runtime.startRole).not.toHaveBeenCalled();
});

test("aborting activation clears the timer and project revocation rejects actions", async () => {
  const f = await pluginFixture();
  expect(vi.getTimerCount()).toBe(1);
  f.scopes.get(project)!.abort(new Error("Project revoked"));
  await expect(f.act("create", { title: "Revoked task" })).rejects.toThrow("Project revoked");
  f.controller.abort();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(5000);
  expect(f.runtime.startRole).not.toHaveBeenCalled();
});

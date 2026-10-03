import { expect, test } from "vitest";
import { currentRun, taskPrompt } from "../src/engine";
import { taskById } from "../src/store";
import { analysis, completion, delivery, engineFixture, otherProject, pluginFixture, project } from "./helpers";

test("task prompts are readable and use native questions and explicit reports", async () => {
  const f = await engineFixture(), task = await f.create();
  for (const phase of ["analysis", "execution", "review"] as const) {
    const prompt = taskPrompt(task, phase);
    expect(prompt).toContain("ask_user_question");
    expect(prompt).toContain("kanban_report");
    expect(prompt).toContain("# " + task.title);
    expect(prompt).not.toContain("Return ONLY JSON");
    expect(prompt).not.toContain('"originalRequirement":');
  }
});

test("native question waits without finishing the attempt or launching another run", async () => {
  const f = await engineFixture(), task = await f.create({automatic: true});
  await f.engine.queue(project, task.id, "analysis", undefined, "execution");
  await f.engine.tick();
  const original = currentRun(await f.task(task.id))!;
  f.runtime.inspect.mockResolvedValue({busy: true, outcome: "running", waitingForInput: true});
  await f.engine.tick(); await f.engine.tick();
  expect(await f.task(task.id)).toMatchObject({status: "in_progress", activeRunId: original.id, runs: [{state: "running", waitingForInput: true}]});
  expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
  f.runtime.inspect.mockResolvedValue({busy: true, outcome: "running", waitingForInput: false});
  await f.engine.tick();
  expect(currentRun(await f.task(task.id))?.waitingForInput).toBe(false);
  await f.complete(task.id, analysis);
  expect((await f.task(task.id)).runs.map(run => run.phase)).toEqual(["analysis", "execution"]);
});

test("a JSON-looking final message never changes the business state", async () => {
  const f = await engineFixture(), task = await f.create();
  await f.engine.queue(project, task.id, "execution"); await f.engine.tick();
  const original = currentRun(await f.task(task.id))!;
  await f.engine.completed(completion(original.target!, original.runId!, JSON.stringify(delivery)));
  const idle = await f.task(task.id);
  expect(idle).toMatchObject({status: "in_progress", activeRunId: original.id, runs: [{state: "completed", awaitingReport: true}]});
  expect(idle.runs[0].verdict).toBeUndefined();
  expect(idle.runs[0].finishedAt).toBeUndefined();
  f.runtime.inspect.mockResolvedValue({busy: false, outcome: "completed"});
  await f.engine.tick();
  expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
  await expect((await f.reopen()).read()).resolves.toMatchObject({tasks: [idle]});
});

test("a user follow-up submits the same attempt from the same conversation with a new host run", async () => {
  const f = await engineFixture(), task = await f.create();
  await f.engine.queue(project, task.id, "execution"); await f.engine.tick();
  const original = currentRun(await f.task(task.id))!;
  await f.engine.completed(completion(original.target!, original.runId!, "I need your input before proceeding."));
  await f.report(task.id, delivery, {runId: "user-follow-up"});
  const submitted = await f.task(task.id);
  expect(submitted).toMatchObject({status: "in_progress", activeRunId: original.id, runs: [{runId: "user-follow-up", report: {action: "delivery"}}]});
  await f.engine.completed(completion(original.target!, "user-follow-up", "Implemented and verified. Please review the changes."));
  expect(await f.task(task.id)).toMatchObject({status: "in_review", runs: [{id: original.id, state: "completed", summary: delivery.summary}]});
  expect((await f.task(task.id)).runs).toHaveLength(1);
  expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
});

test("polling rebinds a resumed conversation before clearing its missing-report state", async () => {
  const f = await engineFixture(), task = await f.create();
  await f.engine.queue(project, task.id, "execution"); await f.engine.tick();
  const original = currentRun(await f.task(task.id))!;
  await f.engine.completed(completion(original.target!, original.runId!, "Please clarify the output format."));
  f.runtime.inspect.mockImplementation(async (_target, runId) => runId === original.runId
    ? {busy: true, outcome: "unknown"}
    : {busy: true, outcome: "running", runId: "follow-up", waitingForInput: true});
  await f.engine.tick(); await f.engine.tick();
  expect(currentRun(await f.task(task.id))).toMatchObject({runId: "follow-up", state: "running", waitingForInput: true});
  await f.report(task.id, delivery, {runId: "follow-up"});
  await f.engine.completed(completion(original.target!, "follow-up", "Implemented and checked."));
  expect((await f.task(task.id)).status).toBe("in_review");
});

test("ordinary feedback after delivery creates a new tracked attempt in the same conversation", async () => {
  const f = await engineFixture(), task = await f.create();
  await f.engine.queue(project, task.id, "execution"); await f.engine.tick(); await f.complete(task.id, delivery);
  const original = (await f.task(task.id)).runs[0];
  await f.report(task.id, {...delivery, summary: "Applied user feedback"}, {runId: "feedback-run"});
  const working = await f.task(task.id), second = currentRun(working)!;
  expect(working.status).toBe("in_progress");
  expect(second).toMatchObject({phase: "execution", roleId: original.roleId, roleName: original.roleName, target: original.target, runId: "feedback-run"});
  expect(second.id).not.toBe(original.id);
  await f.engine.completed(completion(original.target!, "feedback-run", "Feedback addressed; ready for review."));
  expect((await f.task(task.id)).status).toBe("in_review");
  expect((await f.task(task.id)).runs).toHaveLength(2);
  expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
});

test("late events and reports cannot reopen accepted or archived tasks", async () => {
  const f = await engineFixture(), task = await f.create();
  await f.engine.queue(project, task.id, "execution"); await f.engine.tick(); await f.complete(task.id, delivery);
  const original = (await f.task(task.id)).runs[0];
  for (const state of [{status: "done" as const}, {status: "in_review" as const, archived: true}]) {
    await f.store.update(board => Object.assign(taskById(board, project, task.id), state));
    const before = await f.task(task.id);
    await expect(f.report(task.id, delivery, {runId: "late-follow-up"})).rejects.toThrow("No active task");
    await f.engine.completed(completion(original.target!, "late-follow-up", "Done"));
    expect(await f.task(task.id)).toEqual(before);
  }
});

test("an interrupted attempt resumes only after a new host-bound run in its original conversation", async () => {
  const f = await engineFixture(), task = await f.create();
  await f.engine.queue(project, task.id, "execution"); await f.engine.tick();
  const original = currentRun(await f.task(task.id))!;
  f.runtime.inspect.mockResolvedValue({busy: false, outcome: "interrupted", runId: original.runId});
  await f.engine.reconcile();
  expect(currentRun(await f.task(task.id))?.state).toBe("interrupted");
  const before = await f.task(task.id);
  await expect(f.report(task.id, delivery, {runId: "unverified-run"})).rejects.toThrow();
  expect(await f.task(task.id)).toEqual(before);
  f.runtime.inspect.mockImplementation(async (_target, runId) => runId === original.runId
    ? {busy: true, outcome: "unknown"}
    : {busy: true, outcome: "running", runId: "recovered-run"});
  await f.engine.reconcile();
  expect(currentRun(await f.task(task.id))).toMatchObject({id: original.id, state: "running", runId: "recovered-run", roleId: original.roleId});
  await f.report(task.id, delivery, {runId: "recovered-run"});
  await f.engine.completed(completion(original.target!, "recovered-run", "Recovered and verified."));
  expect((await f.task(task.id)).status).toBe("in_review");
  expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
});

test("report ownership uses host scope/session/run and rejects foreign, stale, inactive and wrong-phase calls", async () => {
  const f = await engineFixture(), task = await f.create();
  await f.engine.queue(project, task.id, "analysis"); await f.engine.tick();
  const before = await f.task(task.id);
  for (const context of [{projectId: otherProject}, {sessionId: "foreign"}, {runId: "old-run"}]) {
    await expect(f.report(task.id, analysis, context)).rejects.toThrow();
    expect(await f.task(task.id)).toEqual(before);
  }
  await expect(f.engine.report({action: "delivery", ...delivery}, {projectId: project, sessionId: before.runs[0].target!.sessionId, runId: before.runs[0].runId!, signal: f.controller.signal})).rejects.toThrow("analysis");
  f.runtime.inspect.mockResolvedValue({busy: false, outcome: "completed"});
  await expect(f.report(task.id, analysis)).rejects.toThrow("active host run");
  expect(await f.task(task.id)).toEqual(before);
});

test("reports are durable and idempotent but don't advance before successful run completion", async () => {
  const f = await engineFixture(), task = await f.create();
  await f.engine.queue(project, task.id, "execution"); await f.engine.tick();
  await f.report(task.id, delivery);
  const submitted = await f.task(task.id);
  await f.report(task.id, delivery);
  expect(await f.task(task.id)).toEqual(submitted);
  await expect(f.report(task.id, {...delivery, summary: "Changed claim"})).rejects.toThrow("already submitted");
  expect((await (await f.reopen()).read()).tasks[0]).toEqual(submitted);
  await f.complete(task.id, "The command failed after submitting.", {outcome: "failed"});
  expect(await f.task(task.id)).toMatchObject({status: "blocked", runs: [{state: "failed"}]});
  expect((await f.task(task.id)).runs[0].verdict).toBeUndefined();
});

test("genuine blockers are explicit reports, not unanswered native questions", async () => {
  const f = await engineFixture(), task = await f.create();
  await f.engine.queue(project, task.id, "analysis"); await f.engine.tick();
  await f.report(task.id, {action: "blocked", summary: "Required repository is unavailable"});
  await f.complete(task.id, "The required repository is unavailable.");
  expect(await f.task(task.id)).toMatchObject({status: "blocked", blockReason: "Required repository is unavailable"});
});

test("legacy question history remains readable but cannot authorize execution", async () => {
  const f = await engineFixture(), task = await f.create();
  await f.store.update(state => {
    const item = taskById(state, project, task.id); item.analysis = {...analysis, questions: ["Which directory?"]};
    item.status = "blocked"; item.clarifications = [{id: "old", analysisRunId: "legacy", createdAt: 1, answers: [{question: "Which files?", answer: "Only generated files"}]}];
  });
  const legacy = await f.task(task.id);
  expect(taskPrompt(legacy, "analysis")).toContain("Only generated files");
  await expect(f.engine.queue(project, task.id, "execution")).rejects.toThrow("Resolve requirement questions");
  await f.engine.queue(project, task.id, "analysis"); await f.engine.tick(); await f.complete(task.id, analysis);
  expect((await f.task(task.id)).analysis?.questions).toEqual([]);
});

test("legacy conversation presentation upgrades in place without changing roles or transcript history", async () => {
  const f = await engineFixture(), task = await f.create();
  await f.engine.queue(project, task.id, "execution"); await f.engine.tick(); await f.complete(task.id, delivery);
  await f.store.update(state => { delete taskById(state, project, task.id).runs[0].conversationMode; });
  const before = await f.task(task.id), previous = before.runs[0];
  await f.engine.migrateConversations();
  expect(f.runtime.prepare).toHaveBeenLastCalledWith(previous.target, before.title, false, {taskId: task.id, workbenchId: "modera.kanban.workbench", conversationMode: "native"});
  expect(await f.task(task.id)).toEqual({...before, runs: [{...previous, conversationMode: "native"}]});
  const calls = f.runtime.prepare.mock.calls.length;
  await f.engine.migrateConversations();
  expect(f.runtime.prepare).toHaveBeenCalledTimes(calls);
  expect(f.runtime.startRole).toHaveBeenCalledTimes(1);
});

test("board does not embed a replacement question form in the conversation", async () => {
  const f = await pluginFixture();
  expect(f.plugin.ui![0].actions).not.toContain("answerQuestions");
  await expect(f.execute({action: "answerQuestions", answers: ["Yes"]})).rejects.toThrow("Unsupported");
  const ui = f.plugin.ui![0];
  await expect(ui.act!({id: "create", value: "{}"}, f.context(), {id: ui.id, projectId: project, sessionId: "task-chat", locale: "en"})).rejects.toThrow("project board");
});

import { expect, test, vi } from "vitest";
import { taskPrompt } from "../src/engine";
import { defaultSettings } from "../src/store";
import { analysis, engineFixture, pluginFixture, project, selection } from "./helpers";

const pending = {...analysis, scope: "Target directory unspecified", questions: ["Which directory?", "Which files should be preserved?"]};
const answers = ["Only the generated-output directory", "Preserve the project source and configuration"];

async function blocked(overrides = {}) {
  const f = await engineFixture();
  const task = await f.create(overrides);
  await f.engine.queue(project, task.id, "analysis", task.revision, "execution");
  await f.engine.tick(); await f.complete(task.id, pending);
  return {...f, id: task.id};
}

test("answers persist with their exact questions and reanalysis gets the user context", async () => {
  const f = await blocked({automatic: true});
  const before = await f.task(f.id);
  await f.engine.queue(project, f.id, "analysis", before.revision, undefined, false, {answers, continueExecution: false});
  const queued = await f.task(f.id);
  expect(queued).toMatchObject({automatic: false, originalDescription: before.originalDescription, analysis: pending, clarifications: [{analysisRunId: before.runs[0].id, answers: pending.questions.map((question, i) => ({question, answer: answers[i]}))}]});
  expect(queued.runs.at(-1)?.followUp).toBeUndefined();
  const restored = (await (await f.reopen()).read()).tasks[0];
  expect(restored.clarifications).toEqual(queued.clarifications);
  expect(taskPrompt(restored, "analysis")).toContain(answers[0]);
  await f.engine.tick();
  expect(f.runtime.startRole.mock.calls.at(-1)?.[2]).toContain(answers[1]);
  await f.complete(f.id, {...analysis, acceptanceCriteria: ["Only generated outputs removed"]});
  await f.engine.tick();
  expect(await f.task(f.id)).toMatchObject({status: "todo", acceptanceCriteria: ["Only generated outputs removed"]});
  expect(f.runtime.startRole).toHaveBeenCalledTimes(2);
});

test("explicit continuation uses a fresh role run only after questions are resolved", async () => {
  const f = await blocked();
  const task = await f.task(f.id);
  await f.engine.queue(project, f.id, "analysis", task.revision, "execution", false, {answers, continueExecution: true});
  await f.engine.tick(); await f.complete(f.id, analysis); await f.engine.tick();
  const current = await f.task(f.id);
  expect(current.runs.map(run => run.phase)).toEqual(["analysis", "analysis", "execution"]);
  expect(new Set(current.runs.map(run => run.target?.sessionId)).size).toBe(3);
  expect(f.runtime.startRole.mock.calls[2][2]).toContain(answers[0]);
  expect(current.runs[0].analysis).toEqual(pending);
});

test("an incomplete answer leaves the task waiting and preserves further rounds", async () => {
  const f = await blocked();
  await f.engine.queue(project, f.id, "analysis", (await f.task(f.id)).revision, "execution", false, {answers, continueExecution: true});
  await f.engine.tick(); await f.complete(f.id, {...analysis, questions: ["Which generated-output subdirectory?"]}); await f.engine.tick();
  expect(f.runtime.startRole).toHaveBeenCalledTimes(2);
  expect(await f.task(f.id)).toMatchObject({status: "blocked", clarifications: [{answers: [{answer: answers[0]}, {answer: answers[1]}]}]});
  await f.engine.queue(project, f.id, "analysis", (await f.task(f.id)).revision, undefined, false, {answers: ["Only generated-output/test"], continueExecution: false});
  expect((await f.task(f.id)).clarifications).toHaveLength(2);
});

test("invalid answers, stale revisions and duplicate submissions are atomic", async () => {
  const f = await blocked();
  const task = await f.task(f.id);
  for (const input of [[], ["one"], ["", "two"], ["x".repeat(5001), "two"], [false, "two"]]) {
    await expect(f.engine.queue(project, f.id, "analysis", task.revision, undefined, false, {answers: input, continueExecution: false})).rejects.toThrow("Answer every question");
    expect(await f.task(f.id)).toEqual(task);
  }
  await expect(f.engine.queue(project, f.id, "analysis", task.revision - 1, undefined, false, {answers, continueExecution: false})).rejects.toThrow("refresh");
  await f.engine.queue(project, f.id, "analysis", task.revision, undefined, false, {answers, continueExecution: false});
  await expect(f.engine.queue(project, f.id, "analysis", task.revision, undefined, false, {answers, continueExecution: false})).rejects.toThrow("refresh");
  const queued = await f.task(f.id);
  await expect(f.engine.queue(project, f.id, "analysis", queued.revision, undefined, false, {answers, continueExecution: false})).rejects.toThrow("active");
  expect((await f.task(f.id)).clarifications).toHaveLength(1);
});

test("reanalysis preserves manually supplied acceptance criteria", async () => {
  const f = await blocked({acceptanceCriteria: ["User defined check"]});
  await f.engine.queue(project, f.id, "analysis", (await f.task(f.id)).revision, undefined, false, {answers, continueExecution: false});
  await f.engine.tick(); await f.complete(f.id, {...analysis, acceptanceCriteria: ["New generated check"]});
  expect((await f.task(f.id)).acceptanceCriteria).toEqual(["User defined check"]);
});

test("conversation actions are scoped to the linked task and agents cannot answer for users", async () => {
  vi.useFakeTimers({toFake: ["setInterval", "clearInterval"]});
  const f = await pluginFixture();
  await f.act("settings", {...defaultSettings(project), selection});
  const task = await f.create(), other = await f.create();
  await f.act("analyze", {id: task.id, revision: task.revision});
  await f.pulseUntil(async () => expect(f.runtime.startRole).toHaveBeenCalledTimes(1));
  await f.complete(task.id, pending);
  const current = await f.task(task.id), ui = f.plugin.ui![0];
  const request = {id: ui.id, projectId: project, sessionId: current.runs[0].target!.sessionId, locale: "en", resource: other.id};
  const rendered = (await ui.render(request, f.context())).data;
  expect(rendered).toMatchObject({selectedTaskId: task.id, conversationRunId: current.runs[0].id});
  await expect(ui.act!({id: "answerQuestions", value: JSON.stringify({id: other.id, revision: other.revision, answers, continueExecution: true})}, f.context(), request)).rejects.toThrow("unavailable");
  await expect(f.execute({action: "answerQuestions", id: task.id, answers})).rejects.toThrow("Unsupported");
  await expect(f.act("answerQuestions", {id: task.id, answers, continueExecution: false})).rejects.toThrow("revision");
  await ui.act!({id: "answerQuestions", value: JSON.stringify({id: task.id, revision: current.revision, answers, continueExecution: false})}, f.context(), request);
  expect((await f.task(task.id)).clarifications).toHaveLength(1);
  await expect(ui.render({...request, sessionId: "foreign-session"}, f.context())).rejects.toThrow("not found");
});

import * as fs from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { createTask, taskById, validateRelations } from "../src/store";
import { otherProject, project, storeFixture, taskInput } from "./helpers";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});

test("serializes simultaneous writes, persists numbering, and isolates returned snapshots", async () => {
  const f = await storeFixture();
  const created = await Promise.all(Array.from({ length: 12 }, (_, i) => f.create({ title: "Task " + i })));
  expect(created.map(task => task.number)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  const saved = await f.store.read();
  expect(saved.revision).toBe(12);
  expect(saved.nextNumber).toBe(13);
  created[0]!.title = "Mutated return";
  saved.tasks[1]!.title = "Mutated read";
  expect((await f.store.read()).tasks.slice(0, 2).map(task => task.title)).toEqual(["Task 0", "Task 1"]);
  expect(await (await f.reopen()).read()).toEqual(await f.store.read());
});

test("a thrown mutation rolls back all fields and numbering, then the write queue recovers", async () => {
  const f = await storeFixture();
  await f.create();
  const before = await f.store.read();
  await expect(f.store.update(state => {
    state.tasks[0]!.title = "Must not persist";
    createTask(state, project, taskInput({ title: "Also rolled back" }));
    throw new Error("Mutation failed");
  })).rejects.toThrow("Mutation failed");
  expect(await f.store.read()).toEqual(before);
  expect(await (await f.reopen()).read()).toEqual(before);
  expect((await f.create()).number).toBe(2);
});

test.each(["writeFile", "rename"] as const)("%s failure preserves disk and memory and does not poison the queue", async operation => {
  const f = await storeFixture();
  await f.create();
  const before = await f.store.read();
  vi.mocked(fs[operation]).mockRejectedValueOnce(Object.assign(new Error("Disk unavailable"), { code: "EIO" }));
  await expect(f.create({ title: "Failed write" })).rejects.toThrow("Disk unavailable");
  expect(await f.store.read()).toEqual(before);
  expect(await (await f.reopen()).read()).toEqual(before);
  const next = await f.create({ title: "Recovered write" });
  expect(next.number).toBe(2);
  expect(await (await f.reopen()).read()).toEqual(await f.store.read());
});

test("lookup enforces trusted project scope and rejects stale revisions", async () => {
  const f = await storeFixture();
  const task = await f.create();
  const state = await f.store.read();
  expect(() => taskById(state, otherProject, task.id)).toThrow("this project");
  expect(() => taskById(state, project, task.id, task.revision - 1)).toThrow("refresh and retry");
  expect(taskById(state, project, task.id, task.revision)).toEqual(task);
});

test.each(["dependencyIds", "parentId"] as const)("rejects missing, foreign, archived and circular %s references atomically", async relation => {
  const f = await storeFixture();
  const first = await f.create();
  const second = await f.create(relation === "parentId" ? { parentId: first.id } : { dependencyIds: [first.id] });
  const foreign = await f.create({}, otherProject);
  const archived = await f.create();
  await f.store.update(state => { taskById(state, project, archived.id).archived = true; });
  const before = await f.store.read();
  const ref = (id: string) => relation === "parentId" ? { parentId: id } : { dependencyIds: [id] };
  for (const id of ["missing", foreign.id, archived.id]) {
    await expect(f.store.update(state => createTask(state, project, taskInput(ref(id))))).rejects.toThrow();
    expect(await f.store.read()).toEqual(before);
  }
  for (const id of [first.id, second.id]) {
    await expect(f.store.update(state => {
      const task = taskById(state, project, first.id);
      Object.assign(task, ref(id));
      validateRelations(state, task);
    })).rejects.toThrow("Circular");
    expect(await f.store.read()).toEqual(before);
  }
  expect(await (await f.reopen()).read()).toEqual(before);
});

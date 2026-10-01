import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { statuses, type BoardSettings, type BoardState, type KanbanTask, type TaskInput } from "./types";

export const defaultSettings = (projectId: string): BoardSettings => ({ projectId, autoExecute: true, autoReview: false, maxConcurrent: 1, analyzerId: "explorer", defaultAssigneeId: "worker", defaultReviewerId: "reviewer" });
export function activity(task: KanbanTask, kind: string, text: string) {
  task.activity.push({ id: randomUUID(), kind, text, createdAt: Date.now() });
  task.updatedAt = Date.now(); task.revision++;
}
export function taskById(state: BoardState, projectId: string, id: unknown, revision?: unknown): KanbanTask {
  const task = state.tasks.find(item => item.id === id && item.projectId === projectId);
  if (!task) throw new Error("Task not found in this project");
  if (revision !== undefined && revision !== task.revision) throw new Error("Task changed; refresh and retry");
  return task;
}
function text(value: unknown, name: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new Error(`Invalid ${name}`);
  return value.trim();
}
function strings(value: unknown, name: string, maxItems = 100, maxLength = 2000): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Invalid ${name}`);
  return [...new Set(value.map(item => text(item, name, maxLength, true)))];
}
export function validateTaskInput(raw: unknown): TaskInput {
  if (!raw || typeof raw !== "object") throw new Error("Invalid task");
  const value = raw as TaskInput;
  if (!statuses.includes(value.status) || !["requirement", "bug", "debt", "research", "document"].includes(value.type) || !["urgent", "high", "normal", "low"].includes(value.priority) || typeof value.automatic !== "boolean") throw new Error("Invalid task properties");
  const criteria = strings(value.acceptanceCriteria, "acceptance criteria");
  if (criteria.join("\n").length > 20000) throw new Error("Acceptance criteria exceed 20000 characters");
  return { title: text(value.title, "title", 200, true), description: text(value.description, "description", 50000), type: value.type, priority: value.priority, status: value.status,
    labels: strings(value.labels, "labels", 30, 100), assigneeId: text(value.assigneeId, "assignee", 64), reviewerId: text(value.reviewerId, "reviewer", 64),
    dependencyIds: strings(value.dependencyIds, "dependencies", 100, 100), iteration: text(value.iteration, "iteration", 200), milestone: text(value.milestone, "milestone", 200),
    acceptanceCriteria: criteria, automatic: value.automatic,
    ...(value.parentId ? {parentId: text(value.parentId, "parent", 100, true)} : {}) };
}
export function validateRelations(state: BoardState, task: KanbanTask) {
  const visit = (id: string, path: Set<string>, kind: "dependencies" | "parents") => {
    if (path.has(id)) throw new Error(`Circular ${kind}`);
    const item = taskById(state, task.projectId, id);
    if (item.archived) throw new Error("Archived task cannot be a dependency or parent");
    const next = new Set(path).add(id);
    for (const related of kind === "parents" ? (item.parentId ? [item.parentId] : []) : item.dependencyIds) visit(related, next, kind);
  };
  visit(task.id, new Set(), "dependencies"); visit(task.id, new Set(), "parents");
}
export function createTask(state: BoardState, projectId: string, raw: unknown): KanbanTask {
  if (state.tasks.length >= 5000) throw new Error("Maximum 5000 tasks; remove unneeded tasks before creating more");
  const input = validateTaskInput(raw);
  if (!["backlog", "todo"].includes(input.status)) throw new Error("New tasks must start in backlog or todo");
  const now = Date.now();
  const task: KanbanTask = { ...input, originalDescription: input.description, id: randomUUID(), number: state.nextNumber++, projectId, archived: false, createdAt: now, updatedAt: now, revision: 0, runs: [], comments: [], activity: [] };
  state.tasks.push(task); validateRelations(state, task); activity(task, "created", "Task created"); return task;
}
export function validateSettings(raw: unknown, projectId: string): BoardSettings {
  if (!raw || typeof raw !== "object") throw new Error("Invalid settings");
  const input = raw as BoardSettings;
  if (typeof input.autoExecute !== "boolean" || typeof input.autoReview !== "boolean" || !Number.isInteger(input.maxConcurrent) || input.maxConcurrent < 1 || input.maxConcurrent > 4) throw new Error("Invalid automation settings");
  return { projectId, autoExecute: input.autoExecute, autoReview: input.autoReview, maxConcurrent: input.maxConcurrent,
    analyzerId: text(input.analyzerId, "analyzer", 64, true), defaultAssigneeId: text(input.defaultAssigneeId, "executor", 64, true), defaultReviewerId: text(input.defaultReviewerId, "reviewer", 64, true), ...(input.selection ? {selection: structuredClone(input.selection)} : {}) };
}

export class BoardStore {
  private state: BoardState = { version: 1, revision: 0, nextNumber: 1, tasks: [], settings: [] };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  async initialize() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.path, "utf8")) as BoardState;
      if (saved.version !== 1 || !Number.isInteger(saved.revision) || !Number.isInteger(saved.nextNumber) || !Array.isArray(saved.tasks) || !Array.isArray(saved.settings)) throw new Error("Invalid kanban storage");
      const ids = new Set<string>();
      for (const task of saved.tasks) {
        validateTaskInput(task);
        if (!task.id || !task.projectId || ids.has(task.id) || !Array.isArray(task.runs) || !Array.isArray(task.comments) || !Array.isArray(task.activity) || !Number.isInteger(task.revision)) throw new Error("Invalid stored task");
        ids.add(task.id);
      }
      saved.settings.forEach(item => validateSettings(item, item.projectId));
      this.state = saved;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async read(): Promise<BoardState> { await this.queue; return structuredClone(this.state); }
  update<T>(change: (state: BoardState) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const result = change(next); next.revision++;
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), "utf8"); await rename(temporary, this.path);
      } catch (error) {
        await rm(temporary, {force: true}).catch(() => {});
        throw error;
      }
      this.state = next; return structuredClone(result);
    });
    this.queue = operation.then(() => {}, () => {}); return operation;
  }
  async settings(projectId: string) { const state = await this.read(); return state.settings.find(item => item.projectId === projectId) ?? defaultSettings(projectId); }
}

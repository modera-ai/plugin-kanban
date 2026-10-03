import type { DelegateDefinition, ScheduledRunTarget } from "@modera/plugin-sdk";

export type ModelSelection = ScheduledRunTarget["selection"];

export const statuses = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const;
export type TaskStatus = typeof statuses[number];
export type TaskType = "requirement" | "bug" | "debt" | "research" | "document";
export type Phase = "analysis" | "execution" | "review";
export type RunState = "queued" | "starting" | "running" | "paused" | "failed" | "interrupted" | "completed" | "cancelled";
export interface AgentRole extends DelegateDefinition { description: string; enabled: boolean }
export interface RoleCatalog { revision: number; roles: AgentRole[]; templates: AgentRole[]; options?: { tools: {id: string; title: string}[]; models: {profileId: string; name: string; models: string[]}[] } }
export interface Evidence { label: string; result: "passed" | "failed" | "not_run"; details: string }
export interface Artifact { title: string; path: string }
export interface TaskAnalysis { goal: string; scope: string; acceptanceCriteria: string[]; questions: string[]; subtasks: { title: string; description: string; acceptanceCriteria: string[] }[] }
export interface TaskReport {
  action: "analysis" | "delivery" | "review" | "blocked";
  summary: string; analysis?: TaskAnalysis;
  verdict?: "ready_for_review" | "blocked" | "passed" | "changes_requested";
  evidence?: Evidence[]; artifacts?: Artifact[];
}
export interface TaskRun {
  id: string; phase: Phase; state: RunState; roleId: string; roleName: string;
  target?: ScheduledRunTarget; runId?: string; startedAt: number; finishedAt?: number;
  summary?: string; error?: string; evidence?: Evidence[]; artifacts?: Artifact[];
  verdict?: "ready_for_review" | "blocked" | "passed" | "changes_requested";
  followUp?: Phase;
  isolatedWorkspace?: boolean;
  automatic?: boolean;
  analysis?: TaskAnalysis;
  report?: TaskReport; reportSubmittedAt?: number;
  waitingForInput?: boolean; awaitingReport?: boolean; turnEndedAt?: number;
  conversationMode?: "native";
}
/** Read-only compatibility history from the former board clarification flow. */
export interface TaskClarification { id: string; analysisRunId: string; answers: { question: string; answer: string }[]; createdAt: number }
export interface TaskComment { id: string; text: string; author: "user" | "agent"; createdAt: number }
export interface TaskActivity { id: string; kind: string; text: string; createdAt: number }
export interface KanbanTask {
  id: string; number: number; projectId: string; title: string; description: string;
  originalDescription: string;
  type: TaskType; priority: "urgent" | "high" | "normal" | "low"; status: TaskStatus;
  labels: string[]; assigneeId: string; reviewerId: string; parentId?: string; dependencyIds: string[];
  iteration: string; milestone: string; acceptanceCriteria: string[]; automatic: boolean;
  archived: boolean; createdAt: number; updatedAt: number; revision: number;
  analysis?: TaskAnalysis; activeRunId?: string; runs: TaskRun[];
  comments: TaskComment[]; activity: TaskActivity[]; blockReason?: string;
  clarifications?: TaskClarification[];
}
export interface BoardSettings {
  projectId: string; autoExecute: boolean; autoReview: boolean; maxConcurrent: number;
  analyzerId: string; defaultAssigneeId: string; defaultReviewerId: string; selection?: ModelSelection;
}
export interface BoardState { version: 1; revision: number; nextNumber: number; tasks: KanbanTask[]; settings: BoardSettings[] }
export interface BoardData {
  projectId: string; tasks: KanbanTask[]; settings: BoardSettings; catalog: RoleCatalog;
  projects: {id: string; name: string}[];
  models: {profileId: string; name: string; models: string[]; efforts?: Readonly<Record<string, readonly ModelSelection["reasoningEffort"][]>>}[];
  selectedTaskId?: string; executionAvailable: boolean; isolatedWorkspaces?: boolean; error?: string;
}
export type TaskInput = Pick<KanbanTask, "title" | "description" | "type" | "priority" | "status" | "labels" | "assigneeId" | "reviewerId" | "dependencyIds" | "iteration" | "milestone" | "acceptanceCriteria" | "automatic"> & { parentId?: string };

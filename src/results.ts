import type { Artifact, Evidence, Phase, TaskAnalysis } from "./types";

const line = (value: unknown, max = 2000) => {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid structured task result");
  return value.trim();
};
const list = (value: unknown, max = 100): unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid structured task result list");
  return value;
};
export function parseResult(text: string, phase: Phase): { analysis?: TaskAnalysis; summary: string; verdict?: "ready_for_review" | "blocked" | "passed" | "changes_requested"; evidence?: Evidence[]; artifacts?: Artifact[] } {
  const source = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(source);
  if (!value || typeof value !== "object") throw new Error("Expected a structured task result");
  if (phase === "analysis") {
    const analysis: TaskAnalysis = { goal: line(value.goal), scope: line(value.scope, 10000), acceptanceCriteria: list(value.acceptanceCriteria).map(item => line(item)), questions: list(value.questions).map(item => line(item)), subtasks: list(value.subtasks, 30).map(raw => { const item = raw as Record<string, unknown>; return { title: line(item.title, 200), description: line(item.description, 10000), acceptanceCriteria: list(item.acceptanceCriteria).map(item => line(item)) }; }) };
    if (!analysis.goal || !analysis.acceptanceCriteria.length || analysis.acceptanceCriteria.some(item => !item)) throw new Error("Analysis needs a goal and acceptance criteria");
    if (analysis.acceptanceCriteria.join("\n").length > 20000 || analysis.subtasks.some(item => !item.title || item.acceptanceCriteria.some(criterion => !criterion) || item.acceptanceCriteria.join("\n").length > 20000)) throw new Error("Invalid analysis criteria or subtask");
    return { analysis, summary: analysis.goal };
  }
  const verdict = value.verdict;
  if (!(phase === "execution" ? ["ready_for_review", "blocked"] : ["passed", "changes_requested", "blocked"]).includes(verdict)) throw new Error("Invalid task verdict");
  const evidence: Evidence[] = list(value.evidence).map(raw => { const item = raw as Record<string, unknown>; if (!["passed", "failed", "not_run"].includes(String(item.result))) throw new Error("Invalid evidence result"); return {label: line(item.label), result: item.result as Evidence["result"], details: line(item.details, 10000)}; });
  const artifacts: Artifact[] = list(value.artifacts ?? []).map(raw => { const item = raw as Record<string, unknown>; return {title: line(item.title), path: line(item.path, 2000)}; });
  if (verdict === "passed" && (!evidence.length || evidence.some(item => item.result !== "passed"))) throw new Error("Review cannot pass without passing evidence");
  return { summary: line(value.summary, 20000), verdict, evidence, artifacts };
}

import type { Artifact, Evidence, Phase, TaskAnalysis, TaskReport } from "./types";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected task report arguments");
  return value as Record<string, unknown>;
}

const line = (value: unknown, max = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid task report text");
  return value.trim();
};
const list = (value: unknown, max = 100): unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid structured task result list");
  return value;
};
/** Validates explicit tool arguments, never assistant message text. */
export function validateReport(raw: unknown, phase: Phase): TaskReport {
  const value = object(raw);
  if (value.action === "blocked") return {action: "blocked", summary: line(value.summary, 20000), verdict: "blocked"};
  if (phase === "analysis") {
    if (value.action !== "analysis") throw new Error("Only an analysis report is allowed in this phase");
    if (value.questions !== undefined) throw new Error("Resolve questions using ask_user_question before submitting analysis");
    const analysis: TaskAnalysis = { goal: line(value.goal), scope: line(value.scope, 10000), acceptanceCriteria: list(value.acceptanceCriteria).map(item => line(item)), questions: [], subtasks: list(value.subtasks ?? [], 30).map(raw => { const item = object(raw); return { title: line(item.title, 200), description: line(item.description, 10000), acceptanceCriteria: list(item.acceptanceCriteria).map(item => line(item)) }; }) };
    if (!analysis.goal || !analysis.acceptanceCriteria.length || analysis.acceptanceCriteria.some(item => !item)) throw new Error("Analysis needs a goal and acceptance criteria");
    if (analysis.acceptanceCriteria.join("\n").length > 20000 || analysis.subtasks.some(item => !item.title || item.acceptanceCriteria.some(criterion => !criterion) || item.acceptanceCriteria.join("\n").length > 20000)) throw new Error("Invalid analysis criteria or subtask");
    return {action: "analysis", analysis, summary: analysis.goal};
  }
  if (value.action !== (phase === "execution" ? "delivery" : "review")) throw new Error("Report action does not match the execution phase");
  const verdict = phase === "execution" ? "ready_for_review" : value.verdict;
  if (!(phase === "execution" ? ["ready_for_review"] : ["passed", "changes_requested"]).includes(String(verdict))) throw new Error("Invalid task verdict");
  const evidence: Evidence[] = list(value.evidence).map(raw => { const item = raw as Record<string, unknown>; if (!["passed", "failed", "not_run"].includes(String(item.result))) throw new Error("Invalid evidence result"); return {label: line(item.label), result: item.result as Evidence["result"], details: line(item.details, 10000)}; });
  const artifacts: Artifact[] = list(value.artifacts ?? []).map(raw => { const item = raw as Record<string, unknown>; return {title: line(item.title), path: line(item.path, 2000)}; });
  if (!evidence.length) throw new Error("Delivery and review require verification evidence");
  if (verdict === "passed" && evidence.some(item => item.result !== "passed")) throw new Error("Review cannot pass without passing evidence");
  return {action: value.action as "delivery" | "review", summary: line(value.summary, 20000), verdict: verdict as TaskReport["verdict"], evidence, artifacts};
}

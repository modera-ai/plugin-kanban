import { expect, test } from "vitest";
import { parseResult } from "../src/results";
import { analysis, delivery, review } from "./helpers";

test("extracts fenced analysis, suggested subtasks, and execution artifacts", () => {
  const input = { ...analysis, subtasks: [{ title: "Add storage", description: "Atomic persistence", acceptanceCriteria: ["Reopen succeeds"] }] };
  expect(parseResult("```json\n" + JSON.stringify(input) + "\n```", "analysis")).toEqual({ analysis: input, summary: input.goal });
  expect(parseResult(JSON.stringify(delivery), "execution")).toEqual(delivery);
});

test.each([
  { evidence: [] },
  { evidence: [{ ...review.evidence[0], result: "failed" }] },
  { evidence: [{ ...review.evidence[0], result: "not_run" }] },
  { evidence: [...review.evidence, { ...review.evidence[0], result: "failed" }] },
])("a passed review rejects nonpassing or absent evidence %#", ({ evidence }) => {
  expect(() => parseResult(JSON.stringify({ ...review, evidence }), "review")).toThrow("passing evidence");
});

test.each([
  ["analysis", { ...analysis, goal: " " }],
  ["analysis", { ...analysis, acceptanceCriteria: [] }],
  ["execution", review],
  ["review", delivery],
  ["execution", { ...delivery, evidence: [{ ...delivery.evidence[0], result: "maybe" }] }],
] as const)("rejects invalid %s structured results %#", (phase, value) => {
  expect(() => parseResult(JSON.stringify(value), phase)).toThrow();
});

test("retains failed evidence for changes requested rather than rejecting the report", () => {
  const result = { ...review, verdict: "changes_requested", evidence: [{ ...review.evidence[0], result: "failed" }] };
  expect(parseResult(JSON.stringify(result), "review")).toEqual(result);
});

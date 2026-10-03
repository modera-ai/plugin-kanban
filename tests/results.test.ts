import { expect, test } from "vitest";
import { validateReport } from "../src/results";
import { analysis, delivery, review, reportArguments } from "./helpers";

test("validates tool arguments, suggested subtasks, and execution artifacts without parsing chat", () => {
  const input = { ...analysis, subtasks: [{ title: "Add storage", description: "Atomic persistence", acceptanceCriteria: ["Reopen succeeds"] }] };
  expect(validateReport(reportArguments(input, "analysis"), "analysis")).toEqual({action: "analysis", analysis: input, summary: input.goal});
  expect(validateReport(reportArguments(delivery, "execution"), "execution")).toEqual({action: "delivery", ...delivery});
  expect(() => validateReport(JSON.stringify(input), "analysis")).toThrow();
});

test.each([
  { evidence: [] },
  { evidence: [{ ...review.evidence[0], result: "failed" }] },
  { evidence: [{ ...review.evidence[0], result: "not_run" }] },
  { evidence: [...review.evidence, { ...review.evidence[0], result: "failed" }] },
])("a passed review rejects nonpassing or absent evidence %#", ({ evidence }) => {
  expect(() => validateReport(reportArguments({ ...review, evidence }, "review"), "review")).toThrow();
});

test.each([
  ["analysis", { ...analysis, goal: " " }],
  ["analysis", { ...analysis, acceptanceCriteria: [] }],
  ["execution", {...review, action: "review"}],
  ["review", {...delivery, action: "delivery"}],
  ["execution", { ...delivery, evidence: [{ ...delivery.evidence[0], result: "maybe" }] }],
] as const)("rejects invalid %s structured results %#", (phase, value) => {
  expect(() => validateReport(reportArguments(value, phase), phase)).toThrow();
});

test("retains failed evidence for changes requested rather than rejecting the report", () => {
  const result = { ...review, verdict: "changes_requested", evidence: [{ ...review.evidence[0], result: "failed" }] };
  expect(validateReport(reportArguments(result, "review"), "review")).toEqual({action: "review", ...result});
});

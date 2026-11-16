import { assert, it } from "@effect/vitest";

import { caseState, limitChecks, sampleState } from "./margin.ts";

const state = (limits: Parameters<typeof limitChecks>[0], text: string) =>
  sampleState(limitChecks(limits, text));

it.each([
  ["at the ceiling", 360, "pass"],
  ["half over the ceiling", 540, "margin"],
  ["more than half over", 541, "fail"],
] as const)("grades length %s as %s", (_, length, expected) => {
  assert.strictEqual(state({ chars: 360 }, "x".repeat(length)), expected);
});

it.each([
  ["emoji", { emoji: 0 }, ["Paid.", "Paid ✅", "Paid ✅ 🎉"]],
  ["exclamations", { exclamations: 0 }, ["Paid.", "Paid!", "Paid! Now!"]],
  ["questions", { questions: 1 }, ["Send it?", "Send it? Today?", "Send it? Today? Now?"]],
  ["bullets", { bullets: 0 }, ["One line.", "Plan:\n- send", "- send\n- wait"]],
  ["paragraphs", { paragraphs: 2 }, ["a\n\nb", "a\n\nb\n\nc", "a\n\nb\n  \nc\n\nd"]],
] as const)("grades %s one over as within margin and two over as a fail", (_, limits, texts) => {
  assert.deepStrictEqual(
    texts.map((text) => state(limits, text)),
    ["pass", "margin", "fail"],
  );
});

it("fails a sample when any limit fails, even with another within margin", () => {
  assert.strictEqual(state({ chars: 10, questions: 0 }, "Why? Why??"), "fail");
  assert.strictEqual(state({ chars: 8, questions: 1 }, "Why? Why?"), "margin");
});

it("passes a margin case on 2 of 3 and fails it on 1 of 3; others need a majority", () => {
  const margin = { passes: 2, of: 3 };
  assert.strictEqual(caseState(["pass", "pass", "pass"], margin), "pass");
  assert.strictEqual(caseState(["pass", "margin", "fail"], margin), "margin");
  assert.strictEqual(caseState(["pass", "fail", "fail"], margin), "fail");
  assert.strictEqual(caseState(["pass", "fail"], margin), "fail");
  assert.strictEqual(caseState(["pass", "pass", "fail"], undefined), "pass");
  assert.strictEqual(caseState(["pass", "fail"], undefined), "fail");
  assert.strictEqual(caseState([], margin), undefined);
});

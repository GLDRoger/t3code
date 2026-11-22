import { assert, it } from "@effect/vitest";

import { compare, fisherLower, needsTopUp, type RunManifest, tally, verdict } from "./gate.ts";

const t = (passes: number, finished: number) => ({ passes, finished });

it("computes the one-sided Fisher exact p", () => {
  assert.closeTo(fisherLower(t(3, 3), t(0, 3)), 1 / 20, 1e-12);
  assert.closeTo(fisherLower(t(8, 8), t(3, 8)), 0.01282, 1e-5);
  assert.closeTo(fisherLower(t(2, 8), t(6, 8)), 0.99495, 1e-5);
});

it.each([
  ["a stable pass that mostly fails now", t(8, 8), t(2, 8), "worse"],
  ["a stable pass that fails nearly every sample now", t(8, 8), t(1, 8), "worse"],
  ["a 3-sample pass against a collapse, too few to tell", t(3, 3), t(0, 8), "same"],
  ["a stable fail that passes now", t(0, 8), t(7, 8), "better"],
  ["a drop the samples cannot tell from chance", t(8, 8), t(3, 8), "same"],
  ["unanimous agreement", t(3, 3), t(8, 8), "same"],
  ["two unstable runs far apart", t(6, 8), t(2, 8), "unstable"],
  ["an unstable case on identical text", t(4, 8), t(3, 8), "unstable"],
  ["a case whose samples all errored", t(0, 0), t(3, 3), "no data"],
] as const)("calls %s %s", (_, baseline, candidate, expected) => {
  assert.strictEqual(verdict(baseline, candidate), expected);
});

it("leaves errored samples out of a tally", () => {
  assert.deepStrictEqual(
    tally([{ pass: true }, { pass: false, error: "529" }, { pass: false }]),
    t(1, 2),
  );
});

it.each([
  ["a split", t(2, 3), undefined, true],
  ["no finished sample", t(0, 0), undefined, false],
  ["no finished sample against a passing baseline", t(0, 0), t(8, 8), false],
  ["a unanimous pass with no baseline", t(3, 3), undefined, false],
  ["a unanimous pass the baseline agrees with", t(3, 3), t(8, 8), false],
  ["a unanimous fail the baseline agrees with", t(0, 3), t(0, 8), false],
  ["a unanimous pass against a split baseline", t(3, 3), t(7, 8), true],
  ["a unanimous fail against a passing baseline", t(0, 3), t(8, 8), true],
  ["a unanimous pass whose baseline errored", t(3, 3), t(0, 0), false],
] as const)("tops up %s: %s", (_, first, baseline, expected) => {
  assert.strictEqual(needsTopUp(first, baseline), expected);
});

const manifest = (overrides: Partial<RunManifest> = {}): RunManifest => ({
  commit: "abc",
  model: "claude-haiku-5-5",
  effort: "high",
  harness: "claude",
  shellModel: "claude-haiku-5-5",
  maxSteps: 6,
  userInstructions: "drop",
  template: "t",
  grader: "g",
  samples: 8,
  topUp: 8,
  text: "x",
  cases: { a: { case: "1", request: "r" }, b: { case: "2", request: "r" } },
  ...overrides,
});
const rows = (id: string, passes: number, of: number) =>
  Array.from({ length: of }, (_, i) => ({ id, pass: i < passes }));

it("passes unless a case is worse in every batch pooled or has no finished sample, and refuses runs made on other settings, cases or text", () => {
  const baseline = { manifest: manifest(), rows: [...rows("a", 8, 8), ...rows("b", 4, 8)] };
  const same = {
    manifest: manifest({ samples: 3 }),
    rows: [...rows("a", 3, 3), ...rows("b", 2, 8)],
  };
  assert.isTrue(compare(baseline, [same]).pass);
  const worse = { ...same, rows: [...rows("a", 0, 8), ...rows("b", 2, 8)] };
  assert.deepStrictEqual(
    compare(baseline, [worse]).cases.map(({ id, verdict }) => [id, verdict]),
    [
      ["a", "worse"],
      ["b", "unstable"],
    ],
  );
  assert.isFalse(compare(baseline, [worse]).pass);
  const confirm = (passes: number, request = "r") => ({
    manifest: manifest({ cases: { a: { case: "1", request } } }),
    rows: rows("a", passes, 8),
  });
  assert.isTrue(compare(baseline, [worse, confirm(7)]).pass);
  const errored = {
    ...same,
    rows: [...rows("a", 3, 3), ...rows("b", 0, 3).map((row) => ({ ...row, error: "529" }))],
  };
  assert.deepStrictEqual(
    compare(baseline, [errored]).cases.map(({ id, verdict }) => [id, verdict]),
    [
      ["a", "same"],
      ["b", "no data"],
    ],
  );
  assert.isFalse(compare(baseline, [errored]).pass);
  assert.isFalse(compare(baseline, [{ ...same, rows: rows("a", 3, 3) }]).pass);
  assert.isFalse(compare(baseline, [worse, confirm(1)]).pass);
  assert.deepStrictEqual(compare(baseline, [worse, confirm(7, "other text")]).refused, [
    "case a was sent different requests in two candidate runs",
  ]);
  const stale = {
    manifest: manifest({
      effort: "low",
      cases: { a: { case: "changed", request: "r" }, c: { case: "3", request: "r" } },
    }),
    rows: same.rows,
  };
  assert.deepStrictEqual(compare(baseline, [stale]).refused, [
    "effort differs: baseline high, candidate low",
    "case a changed since the baseline",
    "case c is not in the baseline",
  ]);
  assert.isFalse(compare(baseline, [stale]).pass);
  // A run with no step limit (Kin's) and one with a limit are never compared, either way round.
  const unlimited = { manifest: manifest({ maxSteps: 0 }), rows: same.rows };
  assert.deepStrictEqual(compare(baseline, [unlimited]).refused, [
    "maxSteps differs: baseline 6, candidate no limit",
  ]);
  assert.deepStrictEqual(compare(unlimited, [same]).refused, [
    "maxSteps differs: baseline no limit, candidate 6",
  ]);
});

import { assert, it } from "@effect/vitest";

import type { RunManifest } from "../gate.ts";
import { compareChanged, reportChanged, select, surfaceRefusals } from "./select.ts";
import type { CaseSurface, Surface } from "./surface.ts";

const part = (overrides: Partial<CaseSurface> = {}): CaseSurface => ({
  case: "c",
  request: "r",
  schemas: { Bash: "b", "mcp__t3-code__kin_github_watch": "w" },
  later: { "kin/reply/classify.ts": "k" },
  judge: "",
  pinned: [],
  ...overrides,
});
const surface = (
  cases: Record<string, CaseSurface>,
  overrides: Partial<Surface> = {},
): Surface => ({
  runner: "run",
  model: "claude-haiku-5-5",
  effort: "high",
  shellModel: "claude-haiku-5-5",
  cases,
  ...overrides,
});
const manifest = (
  ids: ReadonlyArray<string>,
  overrides: Partial<RunManifest> = {},
): RunManifest => ({
  commit: "base",
  model: "claude-haiku-5-5",
  effort: "high",
  harness: "claude",
  shellModel: "claude-haiku-5-5",
  maxSteps: 0,
  userInstructions: "drop",
  template: "t",
  grader: "g",
  samples: 8,
  topUp: 8,
  text: "x",
  cases: Object.fromEntries(ids.map((id) => [id, { case: "c", request: "r" }])),
  ...overrides,
});
const rows = (id: string, passes: number, of: number, errored = 0) => [
  ...Array.from({ length: of }, (_, i) => ({ id, pass: i < passes })),
  ...Array.from({ length: errored }, () => ({ id, pass: false, error: "529" })),
];

it.each([
  ["a changed first request", part({ request: "r2" }), "rerun", ["first request"]],
  // Selection never reads which samples called the tool: the baseline's 8 rows below show 1 call.
  [
    "a changed tool answer only some samples reached",
    part({ later: { "kin/reply/classify.ts": "k", THEME_GUIDE: "new" } }),
    "rerun",
    ["later THEME_GUIDE added"],
  ],
  [
    "a changed deferred schema",
    part({ schemas: { Bash: "b", "mcp__t3-code__kin_github_watch": "w2" } }),
    "rerun",
    ["schema mcp__t3-code__kin_github_watch"],
  ],
  ["a changed rubric judge", part({ judge: "j2" }), "rerun", ["rubric judge"]],
  [
    "a case whose answers no hash covers",
    part({ pinned: ["devices: T3's device service answers"] }),
    "rerun",
    ["always rerun: devices: T3's device service answers"],
  ],
  ["nothing changed", part(), "reused", []],
] as const)("selects %s", (_, after, expected, why) => {
  const selection = select({
    baseline: surface({ a: part() }),
    candidate: surface({ a: after }),
    run: { manifest: manifest(["a"]), rows: rows("a", 8, 8) },
    tripwire: 0,
    seed: "s",
  });
  assert.deepStrictEqual(
    expected === "rerun" ? selection.rerun : selection.reused,
    expected === "rerun" ? [{ id: "a", why }] : ["a"],
  );
});

it("leaves new and removed cases out, and reruns a case the baseline has too few samples of", () => {
  const selection = select({
    baseline: surface({ kept: part(), gone: part(), short: part(), failed: part() }),
    candidate: surface({ kept: part(), added: part(), short: part(), failed: part() }),
    run: {
      manifest: manifest(["kept", "gone", "short", "failed"]),
      rows: [...rows("kept", 8, 8), ...rows("short", 3, 3), ...rows("failed", 2, 7, 1)],
    },
    tripwire: 0,
    seed: "s",
  });
  assert.deepStrictEqual(selection.added, ["added"]);
  assert.deepStrictEqual(selection.removed, ["gone"]);
  assert.deepStrictEqual(selection.reused, ["kept"]);
  assert.deepStrictEqual(selection.rerun, [
    {
      id: "failed",
      why: ["the baseline has 1 errored samples", "the baseline has 7 of 8 samples"],
    },
    { id: "short", why: ["the baseline has 3 of 8 samples"] },
  ]);
});

it("draws the tripwire from reused cases only, the same way for the same seed", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `case-${i}`);
  const cases = Object.fromEntries(ids.map((id) => [id, part()]));
  const changed = { ...cases, "case-0": part({ request: "new" }) };
  const draw = (seed: string) =>
    select({
      baseline: surface(cases),
      candidate: surface(changed),
      run: { manifest: manifest(ids), rows: ids.flatMap((id) => rows(id, 8, 8)) },
      tripwire: 5,
      seed,
    }).tripwire;
  assert.strictEqual(draw("one").length, 5);
  assert.notInclude(draw("one"), "case-0");
  assert.deepStrictEqual(draw("one"), draw("one"));
  assert.notDeepEqual(draw("one"), draw("two"));
});

it("refuses a surface from another runner, settings, or a runner nobody reviewed", () => {
  assert.deepStrictEqual(surfaceRefusals(surface({}), surface({}), "run"), []);
  assert.deepStrictEqual(
    surfaceRefusals(surface({}), surface({}, { runner: "next", effort: "low" }), "run"),
    [
      "the runner changed since changed/surface.ts was reviewed (next, reviewed run): check its part list against the runner, then update REVIEWED_RUNNER",
      "the baseline's surface was made with another runner: make a new baseline",
      "effort differs: baseline surface high, this checkout low",
    ],
  );
});

it("passes only when no rerun case is worse, errored or without data and no tripwire case moved", () => {
  const ids = ["changed", "reused", "trip"];
  const selection = {
    ...select({
      baseline: surface(Object.fromEntries(ids.map((id) => [id, part()]))),
      candidate: surface({ changed: part({ request: "r2" }), reused: part(), trip: part() }),
      run: { manifest: manifest(ids), rows: ids.flatMap((id) => rows(id, 8, 8)) },
      tripwire: 1,
      seed: "s",
    }),
    tripwire: ["trip"],
    reused: ["reused", "trip"],
  };
  const baseline = { manifest: manifest(ids), rows: ids.flatMap((id) => rows(id, 8, 8)) };
  const candidate = (
    rerun: ReturnType<typeof rows>,
    trip: ReturnType<typeof rows>,
    request = "r2",
  ) => ({
    manifest: manifest(["changed", "trip"], {
      samples: 3,
      cases: { changed: { case: "c", request }, trip: { case: "c", request: "r" } },
    }),
    rows: [...rerun, ...trip],
  });
  const judge = (run: ReturnType<typeof candidate>) =>
    compareChanged({ baseline, candidates: [run], selection });
  const same = judge(candidate(rows("changed", 3, 3), rows("trip", 3, 3)));
  assert.isTrue(same.pass);
  assert.include(reportChanged(same), "1 cases rerun because their input changed, 2 reused");
  assert.include(reportChanged(same), "none of the 1 reused cases rerun moved");

  const worse = judge(candidate(rows("changed", 1, 8), rows("trip", 3, 3)));
  assert.isFalse(worse.pass);
  assert.include(reportChanged(worse), "A worse case counts once it reproduces");

  const moved = judge(candidate(rows("changed", 3, 3), rows("trip", 0, 8)));
  assert.isFalse(moved.pass);
  assert.include(reportChanged(moved), "rerun everything");

  const errored = judge(candidate(rows("changed", 2, 2, 1), rows("trip", 3, 3)));
  assert.isFalse(errored.pass);
  assert.include(reportChanged(errored), "a case with an errored sample is never a pass");

  const missing = judge(candidate([], rows("trip", 3, 3)));
  assert.isFalse(missing.pass);
  assert.include(reportChanged(missing), "No data for 1 cases (changed)");

  const otherText = judge(candidate(rows("changed", 3, 3), rows("trip", 3, 3), "r3"));
  assert.deepStrictEqual(otherText.refused, [
    "case changed's run sent another first request than the selection fingerprinted",
  ]);
});

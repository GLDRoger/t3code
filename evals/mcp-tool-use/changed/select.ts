// @effect-diagnostics nodeBuiltinImport:off
/**
 * Changed cases only: which cases a comparison reruns, and its verdict. A case is rerun when any
 * part of what it can receive (`surface.ts`) differs from the baseline's, whatever path its samples
 * took; every other case reuses the baseline's samples, and a seeded random few of those are rerun
 * as a tripwire for a change the surface missed.
 */
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

import {
  refusals,
  type Run,
  type Tally,
  tallies,
  tally,
  verdict,
  type Verdict,
  ALPHA,
} from "../gate.ts";
import type { CaseSurface, Surface } from "./surface.ts";

export const Selection = Schema.Struct({
  /** The baseline it was made against, as its run.json names it. */
  baseline: Schema.Struct({ commit: Schema.String, text: Schema.String }),
  seed: Schema.String,
  /** Cases whose input changed, with what changed, and baseline cases with too few samples. */
  rerun: Schema.Array(Schema.Struct({ id: Schema.String, why: Schema.Array(Schema.String) })),
  /** Cases whose input is unchanged: the baseline's samples stand for them. */
  reused: Schema.Array(Schema.String),
  /** Reused cases rerun anyway, to check the selection. */
  tripwire: Schema.Array(Schema.String),
  /** In this checkout only, or in the baseline only: not compared. */
  added: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
  /** This checkout's first request per case, which the run must have sent. */
  requests: Schema.Record(Schema.String, Schema.String),
});
export type Selection = typeof Selection.Type;

const keyed = (label: string, before: Record<string, string>, after: Record<string, string>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .toSorted()
    .flatMap((key) =>
      before[key] === after[key]
        ? []
        : [
            before[key] === undefined
              ? `${label} ${key} added`
              : after[key] === undefined
                ? `${label} ${key} removed`
                : `${label} ${key}`,
          ],
    );

/** What differs between two surfaces of one case, and why it is rerun regardless. */
export const changedParts = (before: CaseSurface, after: CaseSurface) => [
  ...(before.case === after.case ? [] : ["the case"]),
  ...(before.request === after.request ? [] : ["first request"]),
  ...keyed("schema", before.schemas, after.schemas),
  ...keyed("later", before.later, after.later),
  ...(before.judge === after.judge ? [] : ["rubric judge"]),
  ...after.pinned.map((why) => `always rerun: ${why}`),
];

const rank = (seed: string, id: string) =>
  NodeCrypto.createHash("sha256").update(`${seed}\0${id}`).digest("hex");

export const select = (input: {
  readonly baseline: Surface;
  readonly candidate: Surface;
  /** The baseline run: its manifest names its cases and sample count. */
  readonly run: Run;
  readonly tripwire: number;
  readonly seed: string;
}): Selection => {
  const { baseline, candidate, run } = input;
  const rows = Map.groupBy(run.rows, (row) => row.id);
  const rerun: Array<{ id: string; why: Array<string> }> = [];
  const reused: Array<string> = [];
  const added: Array<string> = [];
  for (const [id, after] of Object.entries(candidate.cases).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const before = baseline.cases[id];
    if (before === undefined || run.manifest.cases[id] === undefined) {
      added.push(id);
      continue;
    }
    const samples = rows.get(id) ?? [];
    const { finished } = tally(samples);
    const errored = samples.length - finished;
    const why = [
      ...changedParts(before, after),
      // A reused case stands on the baseline's samples, so it needs all of them.
      ...(errored > 0 ? [`the baseline has ${errored} errored samples`] : []),
      ...(finished < run.manifest.topUp
        ? [`the baseline has ${finished} of ${run.manifest.topUp} samples`]
        : []),
    ];
    if (why.length > 0) rerun.push({ id, why });
    else reused.push(id);
  }
  const removed = Object.keys(run.manifest.cases)
    .filter((id) => candidate.cases[id] === undefined)
    .toSorted();
  const tripwire = reused
    .toSorted((a, b) => rank(input.seed, a).localeCompare(rank(input.seed, b)))
    .slice(0, Math.max(0, input.tripwire))
    .toSorted();
  return {
    baseline: { commit: run.manifest.commit, text: run.manifest.text },
    seed: input.seed,
    rerun,
    reused,
    tripwire,
    added,
    removed,
    requests: Object.fromEntries(
      Object.entries(candidate.cases).map(([id, { request }]) => [id, request]),
    ),
  };
};

/** Why two surfaces cannot be compared, or this checkout's surface cannot be trusted. */
export const surfaceRefusals = (baseline: Surface, candidate: Surface, reviewed: string) => [
  ...(candidate.runner === reviewed
    ? []
    : [
        `the runner changed since changed/surface.ts was reviewed (${candidate.runner}, reviewed ${reviewed}): check its part list against the runner, then update REVIEWED_RUNNER`,
      ]),
  ...(baseline.runner === candidate.runner
    ? []
    : ["the baseline's surface was made with another runner: make a new baseline"]),
  ...(["model", "effort", "shellModel"] as const).flatMap((key) =>
    baseline[key] === candidate[key]
      ? []
      : [`${key} differs: baseline surface ${baseline[key]}, this checkout ${candidate[key]}`],
  ),
];

export interface ChangedRow {
  readonly id: string;
  readonly role: "rerun" | "tripwire";
  readonly why: ReadonlyArray<string>;
  readonly baseline: Tally;
  readonly candidate: Tally;
  readonly errored: number;
  readonly verdict: Verdict;
}

/**
 * The comparison in changed-cases mode. Candidate folders are pooled as in `compare`. A reused case
 * keeps the baseline's samples and grades, so it is not judged; a tripwire case that moves either
 * way means the selection missed a change.
 */
export const compareChanged = (input: {
  readonly baseline: Run;
  readonly candidates: ReadonlyArray<Run>;
  readonly selection: Selection;
}) => {
  const { baseline, candidates, selection } = input;
  const ran = new Map<string, string>();
  const refused = new Set<string>();
  if (
    selection.baseline.commit !== baseline.manifest.commit ||
    selection.baseline.text !== baseline.manifest.text
  )
    refused.add(
      `the selection was made against baseline ${selection.baseline.commit}, not this one`,
    );
  for (const { manifest } of candidates) {
    for (const line of refusals(baseline.manifest, manifest)) refused.add(line);
    for (const [id, { request }] of Object.entries(manifest.cases)) {
      const seen = ran.get(id);
      if (seen !== undefined && seen !== request)
        refused.add(`case ${id} was sent different requests in two candidate runs`);
      ran.set(id, request);
      // The surface is what the selection judged: the run must have sent that same request.
      if (selection.requests[id] !== undefined && selection.requests[id] !== request)
        refused.add(`case ${id}'s run sent another first request than the selection fingerprinted`);
    }
  }
  const before = tallies(baseline.rows);
  const pooled = Map.groupBy(
    candidates.flatMap(({ rows }) => rows),
    (row) => row.id,
  );
  const empty = { passes: 0, finished: 0 };
  const run = (id: string, role: ChangedRow["role"], why: ReadonlyArray<string>): ChangedRow => {
    const samples = pooled.get(id) ?? [];
    const was = before.get(id) ?? empty;
    const now = tally(samples);
    return {
      id,
      role,
      why,
      baseline: was,
      candidate: now,
      errored: samples.length - now.finished,
      verdict: verdict(was, now),
    };
  };
  const rows = [
    ...selection.rerun.map(({ id, why }) => run(id, "rerun", why)),
    ...selection.tripwire.map((id) => run(id, "tripwire", ["tripwire"])),
  ];
  const moved = rows.filter(
    (row) => row.role === "tripwire" && (row.verdict === "worse" || row.verdict === "better"),
  );
  const failing = rows.filter(
    (row) => row.verdict === "worse" || row.verdict === "no data" || row.errored > 0,
  );
  return {
    refused: [...refused],
    selection,
    rows,
    moved,
    batches: candidates.length,
    pass: refused.size === 0 && moved.length === 0 && failing.length === 0,
  };
};

const rate = ({ passes, finished }: Tally) => (finished === 0 ? "-" : `${passes}/${finished}`);
const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id).join(", ");

export const reportChanged = (result: ReturnType<typeof compareChanged>) => {
  if (result.refused.length > 0)
    return [
      "Refused: these runs cannot be compared in changed-cases mode.",
      ...result.refused.map((line) => `- ${line}`),
    ].join("\n");
  const { selection, rows, moved } = result;
  const rerun = rows.filter((row) => row.role === "rerun");
  const trip = rows.filter((row) => row.role === "tripwire");
  const count = (wanted: Verdict) => rerun.filter((row) => row.verdict === wanted).length;
  const errored = rows.filter((row) => row.errored > 0);
  const noData = rows.filter((row) => row.verdict === "no data");
  const worse = rows.filter((row) => row.verdict === "worse" && row.role !== "tripwire");
  const order: ReadonlyArray<Verdict> = ["worse", "better", "no data", "unstable", "same"];
  const shown = rows.toSorted(
    (a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || a.id.localeCompare(b.id),
  );
  return [
    `Verdict: ${result.pass ? "pass" : "FAIL"}. Changed cases only: ${rerun.length} cases rerun because their input changed, ${selection.reused.length} reused from the baseline, ${trip.length} of those reused cases rerun as the tripwire.`,
    ...(moved.length > 0
      ? [
          `Tripwire: ${moved.length} of ${trip.length} reused cases moved beyond the baseline's own noise (${ids(moved)}). Their input was taken as unchanged, so the selection missed a change: rerun everything with \`pnpm kin:candidate\`. This is not a pass.`,
        ]
      : trip.length > 0
        ? [
            `Tripwire: none of the ${trip.length} reused cases rerun moved beyond the baseline's own noise.`,
          ]
        : ["Tripwire: no reused case was rerun, so nothing checked the selection."]),
    ...(rerun.length === 0
      ? [
          "No case's input changed: nothing this checkout sends a Kin case differs from the baseline, so the comparison has nothing to measure beyond the tripwire.",
        ]
      : [
          `Rerun cases: ${count("worse")} worse, ${count("better")} better, ${count("unstable")} unstable on both, ${count("same")} same, ${count("no data")} no data.`,
        ]),
    ...(errored.length > 0
      ? [
          `Errored samples in ${errored.length} cases (${ids(errored)}): a case with an errored sample is never a pass. Run it again.`,
        ]
      : []),
    ...(noData.length > 0
      ? [`No data for ${noData.length} cases (${ids(noData)}): run them again.`]
      : []),
    ...(selection.added.length > 0
      ? [
          `Not in the baseline, so not compared: ${selection.added.join(", ")}. Run them as new cases.`,
        ]
      : []),
    ...(selection.removed.length > 0
      ? [
          `In the baseline only: ${selection.removed.length} cases (${selection.removed.join(", ")}).`,
        ]
      : []),
    `Worse and better mean a one-sided Fisher exact p <= ${ALPHA}, unless the case is unstable on both sides. Tripwire seed: ${selection.seed}.`,
    ...(worse.length > 0 && result.batches === 1
      ? [
          `A worse case counts once it reproduces: run it again with \`pnpm kin:candidate --baseline <baseline> --case ${ids(worse).replaceAll(", ", ",")} --samples 8 --top-up 8 --out <confirm>\` (same --model and flags), then compare with both --candidate folders.`,
        ]
      : []),
    "",
    "| Case | Why it ran | Baseline | Candidate | Verdict |",
    "| --- | --- | --: | --: | --- |",
    ...shown.map(
      (row) =>
        `| ${row.id} | ${row.why.join("; ")} | ${rate(row.baseline)} | ${rate(row.candidate)}${row.errored > 0 ? ` (${row.errored} errored)` : ""} | ${row.verdict} |`,
    ),
  ].join("\n");
};

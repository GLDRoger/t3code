import * as Schema from "effect/Schema";

/**
 * The baseline gate: a case is "worse" when a one-sided Fisher exact test on its pass counts
 * gives p <= ALPHA and it is not unstable on both sides. The README states the false-alarm rate.
 */
export const ALPHA = 0.02;

/** What a run ran on, written as `run.json` beside `results.jsonl`. */
export const RunManifest = Schema.Struct({
  commit: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  harness: Schema.String,
  shellModel: Schema.String,
  maxSteps: Schema.Number,
  userInstructions: Schema.String,
  /** Hashes of the captured template and of the runner and graders. */
  template: Schema.String,
  grader: Schema.String,
  /** Samples every case starts with, and the count a split case is topped up to. */
  samples: Schema.Number,
  topUp: Schema.Number,
  /** Hash of every request the agent model is sent first: Kin's text, tools and the cases. */
  text: Schema.String,
  cases: Schema.Record(
    Schema.String,
    Schema.Struct({ case: Schema.String, request: Schema.String }),
  ),
});
export type RunManifest = typeof RunManifest.Type;

/** Settings two runs must share to be compared. The starting sample count may differ. */
const SHARED = [
  "model",
  "effort",
  "harness",
  "shellModel",
  "maxSteps",
  "userInstructions",
  "template",
  "grader",
  "topUp",
] as const;

export interface Tally {
  readonly passes: number;
  readonly finished: number;
}

interface Sampled {
  readonly pass: boolean;
  readonly error?: string | undefined;
}

/** Errored samples are not graded, so they are left out. */
export const tally = (rows: ReadonlyArray<Sampled>): Tally => {
  const finished = rows.filter((row) => row.error === undefined);
  return { passes: finished.filter((row) => row.pass).length, finished: finished.length };
};

export const tallies = (rows: ReadonlyArray<Sampled & { readonly id: string }>) =>
  new Map([...Map.groupBy(rows, (row) => row.id)].map(([id, members]) => [id, tally(members)]));

const unanimous = ({ passes, finished }: Tally) =>
  finished > 0 && (passes === 0 || passes === finished);

/**
 * A case is topped up when its first samples split, or when the baseline it will be compared
 * with did not agree unanimously with them, so a candidate has the baseline's evidence or more.
 */
export const needsTopUp = (first: Tally, baseline?: Tally) => {
  if (!unanimous(first)) return true;
  if (baseline === undefined || baseline.finished === 0) return false;
  const passed = first.passes > 0;
  return baseline.passes !== (passed ? baseline.finished : 0);
};

/** At most one sample in eight disagrees with the rest. */
export const stable = ({ passes, finished }: Tally) =>
  finished > 0 && Math.min(passes, finished - passes) <= finished / 8;

const choose = (n: number, k: number) => {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
};

/** One-sided Fisher exact p: the chance `lower` passes this few or fewer if both rates are equal. */
export const fisherLower = (higher: Tally, lower: Tally) => {
  const passes = higher.passes + lower.passes;
  const total = higher.finished + lower.finished;
  let p = 0;
  for (let x = Math.max(0, passes - higher.finished); x <= lower.passes; x++)
    p += (choose(lower.finished, x) * choose(higher.finished, passes - x)) / choose(total, passes);
  return p;
};

export type Verdict = "same" | "better" | "worse" | "unstable" | "no data";

export const verdict = (baseline: Tally, candidate: Tally): Verdict => {
  if (baseline.finished === 0 || candidate.finished === 0) return "no data";
  if (!stable(baseline) && !stable(candidate)) return "unstable";
  if (fisherLower(baseline, candidate) <= ALPHA) return "worse";
  if (fisherLower(candidate, baseline) <= ALPHA) return "better";
  return "same";
};

export interface Run {
  readonly manifest: RunManifest;
  readonly rows: ReadonlyArray<Sampled & { readonly id: string }>;
}

/** Why two runs cannot be compared; empty when they can. */
export const refusals = (baseline: RunManifest, candidate: RunManifest) => [
  ...SHARED.filter((key) => baseline[key] !== candidate[key]).map(
    (key) => `${key} differs: baseline ${baseline[key]}, candidate ${candidate[key]}`,
  ),
  ...Object.entries(candidate.cases).flatMap(([id, { case: hash }]) => {
    const before = baseline.cases[id];
    if (before === undefined) return [`case ${id} is not in the baseline`];
    return before.case === hash ? [] : [`case ${id} changed since the baseline`];
  }),
];

export const compare = (baseline: Run, candidate: Run) => {
  const refused = refusals(baseline.manifest, candidate.manifest);
  const before = tallies(baseline.rows);
  const after = tallies(candidate.rows);
  const empty = { passes: 0, finished: 0 };
  const cases = Object.keys(candidate.manifest.cases)
    .toSorted()
    .map((id) => {
      const was = before.get(id) ?? empty;
      const now = after.get(id) ?? empty;
      return { id, baseline: was, candidate: now, verdict: verdict(was, now) };
    });
  const notRun = Object.keys(baseline.manifest.cases).filter(
    (id) => candidate.manifest.cases[id] === undefined,
  );
  const worse = cases.filter((row) => row.verdict === "worse");
  return {
    refused,
    cases,
    notRun,
    sameText: baseline.manifest.text === candidate.manifest.text,
    pass: refused.length === 0 && worse.length === 0,
  };
};

const rate = ({ passes, finished }: Tally) => (finished === 0 ? "-" : `${passes}/${finished}`);

export const report = (result: ReturnType<typeof compare>) => {
  if (result.refused.length > 0)
    return [
      "Refused: these runs were not made under the same settings.",
      ...result.refused.map((line) => `- ${line}`),
    ].join("\n");
  const count = (wanted: Verdict) => result.cases.filter((row) => row.verdict === wanted).length;
  const order: ReadonlyArray<Verdict> = ["worse", "better", "unstable", "no data", "same"];
  const shown = result.cases.toSorted(
    (a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict),
  );
  return [
    `Verdict: ${result.pass ? "pass" : "FAIL"}. ${count("worse")} worse, ${count("better")} better, ${count("unstable")} unstable on both, ${count("same")} same, ${count("no data")} no data, of ${result.cases.length} cases.`,
    ...(result.sameText
      ? ["The two runs sent identical requests: every difference is noise."]
      : []),
    ...(result.notRun.length > 0
      ? [`Not in the candidate run: ${result.notRun.length} baseline cases.`]
      : []),
    `Worse and better mean a one-sided Fisher exact p <= ${ALPHA}, unless the case is unstable on both sides.`,
    "",
    "| Case | Baseline | Candidate | Verdict |",
    "| --- | --: | --: | --- |",
    ...shown.map(
      (row) => `| ${row.id} | ${rate(row.baseline)} | ${rate(row.candidate)} | ${row.verdict} |`,
    ),
  ].join("\n");
};

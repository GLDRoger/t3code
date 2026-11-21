import * as Schema from "effect/Schema";

/**
 * The baseline gate: a case is "worse" when a one-sided Fisher exact test on its pass counts
 * gives p <= ALPHA and it is not unstable on both sides. The README states the false-alarm rate.
 */
export const ALPHA = 0.005;

/** What a run ran on, written as `run.json` beside `results.jsonl`. */
export const RunManifest = Schema.Struct({
  commit: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  harness: Schema.String,
  shellModel: Schema.String,
  /** Model calls per sample; 0 is no limit, so it never compares with a run that had one. */
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
  // More samples of a case whose samples all errored buy more errors, not evidence.
  if (first.finished === 0) return false;
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

const shown = (key: (typeof SHARED)[number], manifest: RunManifest) =>
  key === "maxSteps" && manifest.maxSteps === 0 ? "no limit" : manifest[key];

/** Why two runs cannot be compared; empty when they can. */
export const refusals = (baseline: RunManifest, candidate: RunManifest) => [
  ...SHARED.filter((key) => baseline[key] !== candidate[key]).map(
    (key) => `${key} differs: baseline ${shown(key, baseline)}, candidate ${shown(key, candidate)}`,
  ),
  ...Object.entries(candidate.cases).flatMap(([id, { case: hash }]) => {
    const before = baseline.cases[id];
    if (before === undefined) return [`case ${id} is not in the baseline`];
    return before.case === hash ? [] : [`case ${id} changed since the baseline`];
  }),
];

/**
 * Candidates are pooled: a case that came out worse is run again in a separate batch, passed as
 * a second candidate, and counts as a regression only if it is still worse with both batches.
 */
export const compare = (baseline: Run, candidates: ReadonlyArray<Run>) => {
  const requests = new Map<string, string>();
  const mixed = candidates.flatMap(({ manifest }) =>
    Object.entries(manifest.cases).flatMap(([id, { request }]) => {
      const seen = requests.get(id);
      requests.set(id, request);
      return seen === undefined || seen === request
        ? []
        : [`case ${id} was sent different requests in two candidate runs`];
    }),
  );
  const refused = [
    ...new Set([
      ...candidates.flatMap(({ manifest }) => refusals(baseline.manifest, manifest)),
      ...mixed,
    ]),
  ];
  const before = tallies(baseline.rows);
  const after = tallies(candidates.flatMap(({ rows }) => rows));
  const empty = { passes: 0, finished: 0 };
  const cases = [...requests.keys()].toSorted().map((id) => {
    const was = before.get(id) ?? empty;
    const now = after.get(id) ?? empty;
    return { id, baseline: was, candidate: now, verdict: verdict(was, now) };
  });
  const notRun = Object.keys(baseline.manifest.cases).filter((id) => !requests.has(id));
  const worse = cases.filter((row) => row.verdict === "worse");
  const noData = cases.filter((row) => row.verdict === "no data");
  return {
    refused,
    cases,
    notRun,
    batches: candidates.length,
    sameText: [...requests].every(
      ([id, request]) => baseline.manifest.cases[id]?.request === request,
    ),
    pass: refused.length === 0 && worse.length === 0 && noData.length === 0,
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
  const worse = result.cases.filter((row) => row.verdict === "worse");
  const order: ReadonlyArray<Verdict> = ["worse", "better", "unstable", "no data", "same"];
  const shown = result.cases.toSorted(
    (a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict),
  );
  return [
    `Verdict: ${result.pass ? "pass" : "FAIL"}. ${count("worse")} worse, ${count("better")} better, ${count("unstable")} unstable on both, ${count("same")} same, ${count("no data")} no data, of ${result.cases.length} cases.`,
    ...(result.sameText ? ["Both sides sent identical requests: every difference is noise."] : []),
    ...(result.notRun.length > 0
      ? [`Not in the candidate run: ${result.notRun.length} baseline cases.`]
      : []),
    ...(count("no data") > 0
      ? [
          `No data means every sample of a case errored on one side, so nothing shows it is not worse: run those cases again.`,
        ]
      : []),
    `Worse and better mean a one-sided Fisher exact p <= ${ALPHA}, unless the case is unstable on both sides.`,
    ...(worse.length > 0 && result.batches === 1
      ? [
          `A worse case counts once it reproduces: run it again with \`pnpm kin:candidate --baseline <baseline> --case ${worse.map((row) => row.id).join(",")} --samples 8 --top-up 8 --out <confirm>\` (same --model and flags), then compare with both --candidate folders.`,
        ]
      : []),
    "",
    "| Case | Baseline | Candidate | Verdict |",
    "| --- | --: | --: | --- |",
    ...shown.map(
      (row) => `| ${row.id} | ${rate(row.baseline)} | ${rate(row.candidate)} | ${row.verdict} |`,
    ),
  ].join("\n");
};

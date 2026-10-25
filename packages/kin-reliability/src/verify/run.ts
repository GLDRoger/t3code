// @effect-diagnostics nodeBuiltinImport:off - Verify reads the corpus and writes generated Bend checks to a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ORACLE_COVERAGE } from "../chaos/oracles.ts";
import { LANE_STATES } from "../lane/states.ts";
import { parseTrace, type KinTrace } from "../lane/trace.ts";
import { bendDir as defaultBendDir, configDir, corpusDir as defaultCorpusDir } from "../paths.ts";
import {
  findBend,
  readBendVersion,
  readPinnedBendVersion,
  runBend,
  runBendAsync,
  SKIPPED_BEND,
  type BendInvocation,
} from "./bend.ts";
import { renderSweep, renderTraceCheck, splitTraces } from "./generate.ts";
import { probeLoopholes, type LoopholeReport } from "./loopholes.ts";
import { checkGateIntegrity, type GateIntegrity } from "./v0.ts";

export type VerifyLevel = "V0" | "V1" | "V2" | "V3" | "V4";
export type LevelStatus = "passed" | "failed" | "skipped";

export interface LevelResult {
  readonly level: VerifyLevel;
  readonly status: LevelStatus;
  readonly reason: string | null;
  readonly elapsedMs: number;
  readonly proves: readonly string[];
  readonly doesNotProve: readonly string[];
  /** True when the level checked a bounded set and is not a proof. */
  readonly sampled: boolean;
}

export interface VerifyReport {
  readonly verdict: "passed" | "failed" | "degraded";
  readonly exitCode: number;
  readonly bend: {
    readonly installed: boolean;
    readonly path: string | null;
    readonly version: string | null;
    readonly pin: string;
    readonly matchesPin: boolean;
  };
  readonly levels: readonly LevelResult[];
  readonly timingsMs: Readonly<Record<VerifyLevel | "total" | "v3Wall" | "loopholes", number>>;
  readonly loopholes: LoopholeReport;
  readonly gate: GateIntegrity;
  readonly oracleCoverage: typeof ORACLE_COVERAGE;
  readonly laneStates: readonly string[];
  readonly laneStateNote: string;
  readonly healed: boolean;
  readonly healReasons: readonly string[];
}

export interface VerifyOptions {
  readonly bendDir?: string;
  readonly corpusDir?: string;
  readonly bound?: number;
  readonly strictPin?: boolean;
  readonly verdict?: boolean;
  readonly traceInCorpus?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  /** `null` forces "bend not installed" without hiding the binary on PATH. */
  readonly bendBin?: string | null;
}

function loadBound(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const file = NodePath.join(configDir, "verify.json");
  const parsed = JSON.parse(NodeFS.readFileSync(file, "utf8")) as { sweepBound?: number };
  return parsed.sweepBound ?? 1;
}

function readCorpus(dir: string): readonly KinTrace[] {
  if (!NodeFS.existsSync(dir)) return [];
  return NodeFS.readdirSync(dir)
    .filter((name) => name.endsWith(".trace"))
    .sort()
    .map((name) => parseTrace(NodeFS.readFileSync(NodePath.join(dir, name), "utf8"), name));
}

function skipped(level: VerifyLevel, reason: string, sampled: boolean): LevelResult {
  return {
    level,
    status: "skipped",
    reason,
    elapsedMs: 0,
    proves: [],
    doesNotProve: [reason],
    sampled,
  };
}

function fromBend(
  level: VerifyLevel,
  result: BendInvocation,
  proves: readonly string[],
  doesNotProve: readonly string[],
  sampled: boolean,
): LevelResult {
  const ok = result.exitCode === 0 && result.error === null;
  const detail = `${result.stdout}\n${result.stderr}`.trim();
  return {
    level,
    status: ok ? "passed" : "failed",
    reason: ok ? null : detail || result.error || `bend exited ${result.exitCode}`,
    elapsedMs: result.elapsedMs,
    proves: ok ? proves : [],
    doesNotProve,
    sampled,
  };
}

async function checkHalf(
  bin: string,
  model: string,
  traces: readonly KinTrace[],
  label: string,
): Promise<BendInvocation & { readonly steps: number }> {
  const steps = traces.reduce((sum, trace) => sum + trace.steps.length, 0);
  if (steps === 0) {
    return { exitCode: 0, stdout: "", stderr: "", elapsedMs: 0, error: null, steps: 0 };
  }
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `kin-v3-${label}-`));
  try {
    NodeFS.copyFileSync(model, NodePath.join(dir, "lane.bend"));
    NodeFS.writeFileSync(NodePath.join(dir, "check.bend"), renderTraceCheck(traces));
    const result = await runBendAsync(bin, ["check.bend", "--check-only"], dir);
    return { ...result, steps };
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

export async function runVerify(options: VerifyOptions = {}): Promise<VerifyReport> {
  const started = process.hrtime.bigint();
  const bendPath = options.bendDir ?? defaultBendDir;
  const corpus = options.corpusDir ?? defaultCorpusDir;
  const bound = loadBound(options.bound);
  const env = options.env ?? process.env;
  const pin = readPinnedBendVersion();
  const bin = options.bendBin === null ? null : (options.bendBin ?? findBend(env));
  const version = bin === null ? null : readBendVersion(bin);
  const matchesPin = version !== null && version === pin;
  const installed = bin !== null && version !== null;

  const gateStarted = process.hrtime.bigint();
  const gate = checkGateIntegrity(bendPath);
  const gateMs = Number(process.hrtime.bigint() - gateStarted) / 1e6;
  const v0Reasons = [...gate.reasons];
  if (options.strictPin === true && installed && !matchesPin) {
    v0Reasons.push(`bend ${version} does not match the pin ${pin}`);
  }
  const v0: LevelResult = {
    level: "V0",
    status: v0Reasons.length === 0 ? "passed" : "failed",
    reason: v0Reasons.length === 0 ? null : v0Reasons.join("; "),
    elapsedMs: gateMs,
    proves: v0Reasons.length === 0 ? gate.proves : [],
    doesNotProve: gate.doesNotProve,
    sampled: false,
  };

  const loopholeStarted = process.hrtime.bigint();
  const loopholes = probeLoopholes(installed ? bin : null, version);
  const loopholeMs = Number(process.hrtime.bigint() - loopholeStarted) / 1e6;

  let v1: LevelResult;
  let v2: LevelResult;
  if (!installed || bin === null) {
    v1 = skipped("V1", SKIPPED_BEND, false);
    v2 = skipped("V2", SKIPPED_BEND, false);
  } else {
    const args = ["PROOF.bend", "--check-only", ...(options.verdict === true ? ["--verdict"] : [])];
    const proof = runBend(bin, args, bendPath);
    const verdictNote =
      options.verdict === true
        ? "This run requested --verdict. A missing Lean toolchain fails the level."
        : "The everyday checker ran. --verdict (Lean kernel) was not requested, so this is not the kernel recheck.";
    v1 = fromBend(
      "V1",
      proof,
      [
        "The Bend laws imported by PROOF.bend hold for the Bend model, as far as this checker goes.",
      ],
      [
        verdictNote,
        "Proofs cover the laws that were written, about Bend code. They say nothing about the TypeScript orchestrator.",
      ],
      false,
    );
    v2 = {
      level: "V2",
      status: v1.status,
      reason:
        v1.status === "passed"
          ? "Included in the V1 checker run. Not a second independent proof."
          : v1.reason,
      elapsedMs: 0,
      proves:
        v1.status === "passed"
          ? [
              "Reviewer crown is the identity.",
              "Crown with an absent will is the identity.",
              "Crown leaves will_missing unchanged.",
              "An author in gated with a will becomes crowned.",
              "A second crown of an already crowned author is the identity.",
              "A duplicate move is the identity.",
              "The crown move agrees with crown.",
              "Fail does not uncrown.",
              "next_regnal is the successor.",
            ]
          : [],
      doesNotProve: [
        "Not a proof that Kin's TypeScript orchestrator implements these transitions.",
        "Not a proof of regnal serialization across threads. The successor is proved; the lock is not.",
        "Checked by the same bend process as V1.",
      ],
      sampled: false,
    };
  }

  const traces = readCorpus(corpus);
  let v3: LevelResult;
  let v3Wall = 0;
  if (!installed || bin === null) {
    v3 = skipped("V3", SKIPPED_BEND, false);
  } else if (traces.length === 0 || traces.every((trace) => trace.steps.length === 0)) {
    v3 = skipped("V3", "no traces in the corpus", false);
  } else {
    const model = NodePath.join(bendPath, "lane.bend");
    const halves = splitTraces(traces);
    const wallStarted = process.hrtime.bigint();
    const [left, right] = await Promise.all([
      checkHalf(bin, model, halves.left, "left"),
      checkHalf(bin, model, halves.right, "right"),
    ]);
    v3Wall = Number(process.hrtime.bigint() - wallStarted) / 1e6;
    const failed = [left, right].find((half) => half.exitCode !== 0 || half.error !== null);
    v3 = {
      level: "V3",
      status: failed === undefined ? "passed" : "failed",
      reason:
        failed === undefined ? null : `${failed.stdout}\n${failed.stderr}`.trim() || failed.error,
      elapsedMs: v3Wall,
      proves:
        failed === undefined
          ? [
              `Every recorded trace step matches the Bend model. Checked ${traces.length} traces in two parallel halves (wall ${v3Wall.toFixed(1)}ms, left ${left.elapsedMs.toFixed(1)}ms, right ${right.elapsedMs.toFixed(1)}ms).`,
            ]
          : [],
      doesNotProve: [
        "Only the traces in the corpus were checked. This is not a proof about traces that were not recorded.",
        "Agreement between the TypeScript mirror and Bend does not prove the running server.",
      ],
      sampled: false,
    };
  }

  let v4: LevelResult;
  if (!installed || bin === null) {
    v4 = skipped("V4", SKIPPED_BEND, true);
  } else {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-v4-"));
    try {
      NodeFS.copyFileSync(NodePath.join(bendPath, "lane.bend"), NodePath.join(dir, "lane.bend"));
      NodeFS.writeFileSync(NodePath.join(dir, "sweep.bend"), renderSweep(bound));
      const sweep = runBend(bin, ["sweep.bend", "--check-only"], dir);
      v4 = fromBend(
        "V4",
        sweep,
        [
          `Reviewer lanes and lanes with an absent will are not crowned for every move sequence of length 1..${bound}, and Crown leaves will_missing unchanged. Exhaustive up to that bound.`,
        ],
        [
          `Not a proof for sequences longer than ${bound}.`,
          "Not a proof of the TypeScript orchestrator.",
        ],
        true,
      );
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }

  const levels = [v0, v1, v2, v3, v4];
  const anyFailed = levels.some((level) => level.status === "failed");
  const anySkipped = levels.some((level) => level.status === "skipped");
  const verdict = anyFailed ? "failed" : anySkipped ? "degraded" : "passed";
  const traceInCorpus = options.traceInCorpus ?? traces.length > 0;
  const healReasons: string[] = [];
  if (verdict !== "passed") healReasons.push(`kin verify verdict is ${verdict}`);
  if (!gate.lawsApproved) healReasons.push("V0 did not accept the laws");
  if (!traceInCorpus) healReasons.push("the failing trace is not in the regression corpus");
  const total = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    verdict,
    exitCode: verdict === "passed" ? 0 : verdict === "failed" ? 1 : 2,
    bend: { installed, path: bin, version, pin, matchesPin },
    levels,
    timingsMs: {
      V0: v0.elapsedMs,
      V1: v1.elapsedMs,
      V2: v2.elapsedMs,
      V3: v3.elapsedMs,
      V4: v4.elapsedMs,
      v3Wall,
      loopholes: loopholeMs,
      total,
    },
    loopholes,
    gate,
    oracleCoverage: ORACLE_COVERAGE,
    laneStates: LANE_STATES,
    laneStateNote:
      "Lane states are defined in packages/kin-reliability/src/lane/states.ts. Lane 2 (lineage-core) owns the authoritative machine; these names are DESIGN.md section 13.",
    healed: healReasons.length === 0,
    healReasons,
  };
}

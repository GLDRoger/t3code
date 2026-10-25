// @effect-diagnostics nodeBuiltinImport:off - The sweep reads config and appends the fix-lane outbox on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { configDir } from "../paths.ts";

/**
 * Hourly error sweep. The rate limit and cap live in `config/sweep.json`.
 * A fix lane is a `delegate_task` request. Opening a lane is not healing:
 * that needs `kin verify` to pass with the failing trace in the corpus.
 */
export interface SweepConfig {
  readonly intervalMs: number;
  readonly perHourCap: number;
  readonly minMsBetweenOpens: number;
  readonly dedupeWindowMs: number;
  readonly triageModel: string;
}

export function loadSweepConfig(file = NodePath.join(configDir, "sweep.json")): SweepConfig {
  const parsed = JSON.parse(NodeFS.readFileSync(file, "utf8")) as SweepConfig;
  if (parsed.intervalMs < 60_000) {
    throw new Error("sweep intervalMs must be at least 60000");
  }
  if (parsed.perHourCap < 1) throw new Error("sweep perHourCap must be at least 1");
  return parsed;
}

export function defaultReliabilityDir(): string {
  return NodePath.join(NodeOS.homedir(), ".kin", "reliability");
}

/**
 * The sweep writes under an explicit directory, or under `~/.kin` once that
 * directory exists. It does not create `~/.kin` on its own, so a stock T3
 * server does not grow a Kin home just by booting.
 */
export function activeReliabilityDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.KIN_RELIABILITY_SWEEP === "0") return null;
  if (env.KIN_RELIABILITY_DIR !== undefined && env.KIN_RELIABILITY_DIR.length > 0) {
    return env.KIN_RELIABILITY_DIR;
  }
  const home = NodePath.join(NodeOS.homedir(), ".kin");
  if (NodeFS.existsSync(home)) return NodePath.join(home, "reliability");
  return null;
}

export const TRIAGE_PREFIX = `You classify one Kin error signature into a house and a fix brief.
Houses: providers, persistence, worktree, reliability, unassigned.
Reply with the house and one paragraph. Do not invent a stack trace.
The signature and samples follow.`;

export function triagePrompt(signature: string, samples: readonly string[]): string {
  return `${TRIAGE_PREFIX}\n\nSignature: ${signature}\nSamples:\n${samples.join("\n")}\n`;
}

export function signatureOf(message: string): string {
  const normalized = message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, "<uuid>")
    .replace(/\b[0-9a-f]{7,40}\b/giu, "<hex>")
    .replace(/\/[^\s]+/gu, "<path>")
    .replace(/\d+/gu, "<n>")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  return NodeCrypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export interface ErrorEvent {
  readonly atMs: number;
  readonly source: "log" | "run" | "oracle" | "chaos";
  readonly message: string;
  readonly detail?: string;
}

export interface TriageHit {
  readonly house: string;
  readonly brief: string;
}

export interface Triage {
  readonly modelId: string;
  readonly mode: "heuristic" | "model";
  classify(input: {
    readonly prompt: string;
    readonly signature: string;
    readonly samples: readonly string[];
  }): TriageHit;
}

export function heuristicTriage(config: SweepConfig): Triage {
  return {
    modelId: config.triageModel,
    mode: "heuristic",
    classify(input) {
      const text = input.samples.join("\n").toLowerCase();
      let house = "unassigned";
      if (text.includes("worktree") || text.includes("git")) house = "worktree";
      else if (text.includes("provider") || text.includes("stream")) house = "providers";
      else if (text.includes("sqlite") || text.includes("database")) house = "persistence";
      else if (text.includes("oracle") || text.includes("i-")) house = "reliability";
      const sample = input.samples[0] ?? "";
      return {
        house,
        brief: `Fix error class ${input.signature} in the ${house} house.\n\n${sample}`,
      };
    },
  };
}

export interface FixLaneRequest {
  readonly clientRequestId: string;
  readonly role: "implementation";
  readonly isolation: "worktree";
  readonly mode: "async";
  readonly title: string;
  readonly task: string;
  readonly triageModel: string;
  readonly triageMode: "heuristic" | "model";
  readonly house: string;
  readonly signature: string;
}

/** Shape of upstream `delegate_task`, without lane 1's profile field. */
export function toDelegateTaskInput(request: FixLaneRequest): {
  readonly task: string;
  readonly title: string;
  readonly role: "implementation";
  readonly isolation: "worktree";
  readonly mode: "async";
  readonly clientRequestId: string;
  readonly target?: { readonly model: string };
} {
  return {
    task: request.task,
    title: request.title,
    role: request.role,
    isolation: request.isolation,
    mode: request.mode,
    clientRequestId: request.clientRequestId,
    ...(request.triageMode === "model" ? { target: { model: request.triageModel } } : {}),
  };
}

export interface SignatureState {
  readonly lastAt: number;
  readonly healed: boolean;
  readonly requestId: string;
}

export interface SweepState {
  readonly lastRunMs: number | null;
  readonly lastOpenMs: number | null;
  readonly hourBucket: number | null;
  readonly openedThisHour: number;
  readonly signatures: Readonly<Record<string, SignatureState>>;
}

export function emptySweepState(): SweepState {
  return {
    lastRunMs: null,
    lastOpenMs: null,
    hourBucket: null,
    openedThisHour: 0,
    signatures: {},
  };
}

export interface SweepGroup {
  readonly signature: string;
  readonly samples: readonly string[];
  readonly count: number;
  readonly source: ErrorEvent["source"];
}

export function groupErrors(errors: readonly ErrorEvent[]): readonly SweepGroup[] {
  const groups = new Map<
    string,
    { samples: string[]; count: number; source: ErrorEvent["source"] }
  >();
  for (const error of errors) {
    const signature = signatureOf(error.message);
    const existing = groups.get(signature);
    const sample = error.detail === undefined ? error.message : `${error.message}\n${error.detail}`;
    if (existing === undefined) {
      groups.set(signature, { samples: [sample], count: 1, source: error.source });
    } else {
      existing.count += 1;
      if (existing.samples.length < 3) existing.samples.push(sample);
    }
  }
  return [...groups.entries()].map(([signature, group]) => ({
    signature,
    samples: group.samples,
    count: group.count,
    source: group.source,
  }));
}

export interface SweepDecision {
  readonly signature: string;
  readonly action: "open" | "deduped" | "rate_limited" | "capped";
  readonly request?: FixLaneRequest;
}

export interface SweepOutcome {
  readonly decisions: readonly SweepDecision[];
  readonly state: SweepState;
  readonly opened: readonly FixLaneRequest[];
}

export function runSweep(input: {
  readonly errors: readonly ErrorEvent[];
  readonly state: SweepState;
  readonly config: SweepConfig;
  readonly nowMs: number;
  readonly triage?: Triage;
}): SweepOutcome {
  const triage = input.triage ?? heuristicTriage(input.config);
  const bucket = Math.floor(input.nowMs / input.config.intervalMs);
  let openedThisHour = input.state.hourBucket === bucket ? input.state.openedThisHour : 0;
  let lastOpenMs = input.state.lastOpenMs;
  // The rate limit is about how often a sweep may open lanes, not about
  // spacing items inside one batch. The per-hour cap bounds that batch.
  const rateLimited =
    input.state.lastOpenMs !== null &&
    input.nowMs - input.state.lastOpenMs < input.config.minMsBetweenOpens;
  const signatures: Record<string, SignatureState> = { ...input.state.signatures };
  const decisions: SweepDecision[] = [];
  const opened: FixLaneRequest[] = [];

  for (const group of groupErrors(input.errors)) {
    const previous = signatures[group.signature];
    if (previous !== undefined && !previous.healed) {
      decisions.push({ signature: group.signature, action: "deduped" });
      continue;
    }
    if (previous !== undefined && input.nowMs - previous.lastAt < input.config.dedupeWindowMs) {
      decisions.push({ signature: group.signature, action: "deduped" });
      continue;
    }
    if (rateLimited) {
      decisions.push({ signature: group.signature, action: "rate_limited" });
      continue;
    }
    if (openedThisHour >= input.config.perHourCap) {
      decisions.push({ signature: group.signature, action: "capped" });
      continue;
    }
    const prompt = triagePrompt(group.signature, group.samples);
    const hit = triage.classify({
      prompt,
      signature: group.signature,
      samples: group.samples,
    });
    const request: FixLaneRequest = {
      clientRequestId: `kin-sweep:${group.signature}:${bucket}`,
      role: "implementation",
      isolation: "worktree",
      mode: "async",
      title: `fix ${group.signature}`,
      task: `${prompt}\nHouse: ${hit.house}\n\n${hit.brief}`,
      triageModel: triage.modelId,
      triageMode: triage.mode,
      house: hit.house,
      signature: group.signature,
    };
    opened.push(request);
    openedThisHour += 1;
    lastOpenMs = input.nowMs;
    signatures[group.signature] = {
      lastAt: input.nowMs,
      healed: false,
      requestId: request.clientRequestId,
    };
    decisions.push({ signature: group.signature, action: "open", request });
  }

  return {
    decisions,
    opened,
    state: {
      lastRunMs: input.nowMs,
      lastOpenMs,
      hourBucket: bucket,
      openedThisHour,
      signatures,
    },
  };
}

export interface HealInput {
  readonly verdict: "passed" | "failed" | "degraded";
  readonly lawsApproved: boolean;
  readonly traceInCorpus: boolean;
}

/** A fix counts as healed only when `kin verify` passed and the trace was kept. */
export function healDecision(input: HealInput): {
  readonly healed: boolean;
  readonly reasons: readonly string[];
} {
  const reasons: string[] = [];
  if (input.verdict !== "passed") reasons.push(`kin verify verdict is ${input.verdict}`);
  if (!input.lawsApproved) reasons.push("V0 did not accept the laws");
  if (!input.traceInCorpus) reasons.push("the failing trace is not in the regression corpus");
  return { healed: reasons.length === 0, reasons };
}

export function markHealed(state: SweepState, signature: string, nowMs: number): SweepState {
  const previous = state.signatures[signature];
  if (previous === undefined) return state;
  return {
    ...state,
    signatures: {
      ...state.signatures,
      [signature]: { ...previous, healed: true, lastAt: nowMs },
    },
  };
}

export const SWEEP_TASK_PROMPT = `Run the Kin hourly error sweep.
Read the reliability error log, group failures by signature, and submit one delegate_task per new signature using the outbox.
Use the cheap triage model named in the sweep config.
Do not call a fix healed until kin verify passes with the failing trace in the regression corpus.
Do not edit LAWS.bend.`;

export function errorSweepTaskSpec(config: SweepConfig): {
  readonly title: string;
  readonly schedule: { readonly type: "interval"; readonly everyMs: number };
  readonly prompt: string;
  readonly triageModel: string;
} {
  return {
    title: "Kin hourly error sweep",
    schedule: { type: "interval", everyMs: config.intervalMs },
    prompt: SWEEP_TASK_PROMPT,
    triageModel: config.triageModel,
  };
}

function statePath(dir: string): string {
  return NodePath.join(dir, "sweep-state.json");
}

function errorPath(dir: string): string {
  return NodePath.join(dir, "errors.jsonl");
}

function outboxPath(dir: string): string {
  return NodePath.join(dir, "fix-lane-outbox.jsonl");
}

export function readSweepState(dir: string): SweepState {
  const file = statePath(dir);
  if (!NodeFS.existsSync(file)) return emptySweepState();
  return JSON.parse(NodeFS.readFileSync(file, "utf8")) as SweepState;
}

export function readErrorLog(dir: string): readonly ErrorEvent[] {
  const file = errorPath(dir);
  if (!NodeFS.existsSync(file)) return [];
  return NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ErrorEvent);
}

export function appendError(dir: string, error: ErrorEvent): void {
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.appendFileSync(errorPath(dir), `${JSON.stringify(error)}\n`);
}

export interface TickResult {
  readonly ran: boolean;
  readonly opened: number;
  readonly deferred: number;
}

/**
 * One scheduler tick. The worker calls this every few seconds; the sweep
 * itself runs only when `intervalMs` has elapsed. Fix lanes are appended
 * to the outbox as `delegate_task` payloads. Live dispatch needs a parent
 * run, which upstream `delegate_task` requires and this tick does not have.
 */
export function tickErrorSweep(input: {
  readonly dir: string;
  readonly nowMs: number;
  readonly config?: SweepConfig;
  readonly triage?: Triage;
}): TickResult {
  const config = input.config ?? loadSweepConfig();
  NodeFS.mkdirSync(input.dir, { recursive: true });
  const state = readSweepState(input.dir);
  if (state.lastRunMs !== null && input.nowMs - state.lastRunMs < config.intervalMs) {
    return { ran: false, opened: 0, deferred: 0 };
  }
  const outcome = runSweep({
    errors: readErrorLog(input.dir),
    state,
    config,
    nowMs: input.nowMs,
    ...(input.triage === undefined ? {} : { triage: input.triage }),
  });
  NodeFS.writeFileSync(statePath(input.dir), `${JSON.stringify(outcome.state)}\n`);
  if (outcome.opened.length > 0) {
    const lines = outcome.opened
      .map((request) => JSON.stringify(toDelegateTaskInput(request)))
      .join("\n");
    NodeFS.appendFileSync(outboxPath(input.dir), `${lines}\n`);
  }
  const deferred = outcome.decisions.filter(
    (decision) => decision.action !== "open" && decision.action !== "deduped",
  ).length;
  return { ran: true, opened: outcome.opened.length, deferred };
}

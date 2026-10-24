// @effect-diagnostics nodeBuiltinImport:off - Seeded chaos plans hash and read config outside an Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { configDir } from "../paths.ts";
import { faultsForTier, faultById, type FaultSpec, type Rng, type TierId } from "./catalogue.ts";
import { interpretFault } from "./interpret.ts";
import { liveChaosArmed, type ChaosArm } from "./inject.ts";
import { failedOracles, type OracleResult } from "./oracles.ts";

export interface ChaosBudgets {
  readonly smokeBudgetMs: number;
  readonly nightlyBudgetMs: number;
  readonly canaryCostCapUsdPerDay: number;
  readonly weeklyCostCapUsdPerWeek: number;
  readonly canaryEstimatedUsd: number;
  readonly weeklyEstimatedUsd: number;
}

export const SMOKE_BUDGET_MS = 8 * 60 * 1000;

export function loadChaosBudgets(file = NodePath.join(configDir, "chaos.json")): ChaosBudgets {
  const parsed = JSON.parse(NodeFS.readFileSync(file, "utf8")) as ChaosBudgets;
  return parsed;
}

function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return {
    next() {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

function mixSeed(seed: number, text: string): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export interface FaultPlan {
  readonly seed: number;
  readonly scenario: string;
  readonly faultId: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly tier: TierId;
  readonly commit: string;
}

export function planFor(seed: number, fault: FaultSpec, tier: TierId, commit: string): FaultPlan {
  const params = fault.vary(mulberry32(mixSeed(seed, fault.id)));
  return { seed, scenario: fault.id, faultId: fault.id, params, tier, commit };
}

export function reproCommand(plan: FaultPlan): string {
  return `kin chaos repro --seed ${plan.seed} --scenario ${plan.scenario} --tier ${plan.tier} --commit ${plan.commit}`;
}

export interface ScenarioResult {
  readonly plan: FaultPlan;
  readonly repro: string;
  readonly failed: readonly OracleResult[];
  readonly skipped: string | null;
  readonly chargedUsd: number;
}

export interface TierReport {
  readonly tier: TierId;
  readonly seed: number;
  readonly commit: string;
  readonly budgetMs: number | null;
  readonly elapsedMs: number;
  readonly overBudget: boolean;
  readonly costCapUsd: number | null;
  readonly chargedUsd: number;
  readonly dryRun: boolean;
  readonly scenarios: readonly ScenarioResult[];
  readonly newFailures: readonly string[];
}

function budgetFor(tier: TierId, budgets: ChaosBudgets): number | null {
  if (tier === "smoke") return budgets.smokeBudgetMs;
  if (tier === "nightly") return budgets.nightlyBudgetMs;
  return null;
}

function costCap(tier: TierId, budgets: ChaosBudgets): { cap: number | null; estimated: number } {
  if (tier === "canary") {
    return { cap: budgets.canaryCostCapUsdPerDay, estimated: budgets.canaryEstimatedUsd };
  }
  if (tier === "weekly") {
    return { cap: budgets.weeklyCostCapUsdPerWeek, estimated: budgets.weeklyEstimatedUsd };
  }
  return { cap: null, estimated: 0 };
}

export interface RunTierOptions {
  readonly tier: TierId;
  readonly seed: number;
  readonly commit: string;
  readonly arm: ChaosArm;
  readonly budgets?: ChaosBudgets;
  readonly spentUsd?: number;
  readonly seedsPerFault?: number;
  readonly baselineKeys?: readonly string[];
}

function failureKey(scenario: string, oracle: string): string {
  return `${scenario}:${oracle}`;
}

export function runTier(options: RunTierOptions): TierReport {
  const budgets = options.budgets ?? loadChaosBudgets();
  const started = process.hrtime.bigint();
  const faults = faultsForTier(options.tier);
  const repeats = options.tier === "nightly" ? (options.seedsPerFault ?? 3) : 1;
  const { cap, estimated } = costCap(options.tier, budgets);
  const live = options.tier === "canary" || options.tier === "weekly";
  const armed = live && liveChaosArmed(options.arm);
  let charged = options.spentUsd ?? 0;
  const scenarios: ScenarioResult[] = [];

  for (const fault of faults) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const seed = (options.seed + repeat) >>> 0;
      const plan = planFor(seed, fault, options.tier, options.commit);
      if (live && !armed) {
        const world = interpretFault(fault.id, plan.params);
        scenarios.push({
          plan,
          repro: reproCommand(plan),
          failed: failedOracles(world),
          skipped:
            "dry-run: live provider calls need KIN_CHAOS=1, KIN_CHAOS_LIVE=1, and a non-production process",
          chargedUsd: 0,
        });
        continue;
      }
      if (live && cap !== null && charged + estimated > cap) {
        scenarios.push({
          plan,
          repro: reproCommand(plan),
          failed: [],
          skipped: `cost cap $${cap} would be exceeded (spent $${charged}, next $${estimated})`,
          chargedUsd: 0,
        });
        continue;
      }
      if (live && armed) {
        charged += estimated;
        scenarios.push({
          plan,
          repro: reproCommand(plan),
          failed: [],
          skipped:
            "live chaos is armed, but this package does not call a provider; the plan is recorded and the estimate is charged against the cap",
          chargedUsd: estimated,
        });
        continue;
      }
      const world = interpretFault(fault.id, plan.params);
      scenarios.push({
        plan,
        repro: reproCommand(plan),
        failed: failedOracles(world),
        skipped: null,
        chargedUsd: 0,
      });
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const budgetMs = budgetFor(options.tier, budgets);
  const failedKeys = baselineFromReport({ scenarios }).keys;
  const baseline = new Set(options.baselineKeys ?? []);
  return {
    tier: options.tier,
    seed: options.seed,
    commit: options.commit,
    budgetMs,
    elapsedMs,
    overBudget: budgetMs !== null && elapsedMs > budgetMs,
    costCapUsd: cap,
    chargedUsd: charged - (options.spentUsd ?? 0),
    dryRun: live && !armed,
    scenarios,
    newFailures: failedKeys.filter((key) => !baseline.has(key)),
  };
}

export function runPlan(
  plan: FaultPlan,
  arm: ChaosArm,
  budgets = loadChaosBudgets(),
): ScenarioResult {
  const live = plan.tier === "canary" || plan.tier === "weekly";
  const { cap, estimated } = costCap(plan.tier, budgets);
  const armed = live && liveChaosArmed(arm);
  if (live && !armed) {
    return {
      plan,
      repro: reproCommand(plan),
      failed: failedOracles(interpretFault(plan.faultId, plan.params)),
      skipped:
        "dry-run: live provider calls need KIN_CHAOS=1, KIN_CHAOS_LIVE=1, and a non-production process",
      chargedUsd: 0,
    };
  }
  if (live && cap !== null && estimated > cap) {
    return {
      plan,
      repro: reproCommand(plan),
      failed: [],
      skipped: `cost cap $${cap} would be exceeded (spent $0, next $${estimated})`,
      chargedUsd: 0,
    };
  }
  if (live && armed) {
    return {
      plan,
      repro: reproCommand(plan),
      failed: [],
      skipped:
        "live chaos is armed, but this package does not call a provider; the plan is recorded and the estimate is charged against the cap",
      chargedUsd: estimated,
    };
  }
  return {
    plan,
    repro: reproCommand(plan),
    failed: failedOracles(interpretFault(plan.faultId, plan.params)),
    skipped: null,
    chargedUsd: 0,
  };
}

export function repro(input: {
  readonly seed: number;
  readonly scenario: string;
  readonly tier: TierId;
  readonly commit: string;
  readonly arm: ChaosArm;
}): ScenarioResult {
  const fault = assertKnownScenario(input.scenario, input.tier);
  return runPlan(planFor(input.seed, fault, input.tier, input.commit), input.arm);
}

export interface FailureBaseline {
  readonly keys: readonly string[];
}

export function baselineFromReport(report: {
  readonly scenarios: readonly ScenarioResult[];
}): FailureBaseline {
  return {
    keys: report.scenarios.flatMap((scenario) =>
      scenario.failed.map((oracle) => failureKey(scenario.plan.scenario, oracle.id)),
    ),
  };
}

export function reportHash(report: TierReport): string {
  const stable = {
    tier: report.tier,
    seed: report.seed,
    scenarios: report.scenarios.map((scenario) => ({
      plan: scenario.plan,
      failed: scenario.failed.map((oracle) => oracle.id),
      skipped: scenario.skipped,
      chargedUsd: scenario.chargedUsd,
    })),
  };
  return NodeCrypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function assertKnownScenario(scenario: string, tier: TierId): FaultSpec {
  const fault = faultById(scenario);
  if (fault === undefined || !fault.tiers.includes(tier)) {
    throw new Error(`${scenario} is not in the ${tier} catalogue`);
  }
  return fault;
}

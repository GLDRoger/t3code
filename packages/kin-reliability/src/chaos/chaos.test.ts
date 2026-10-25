import { describe, expect, it } from "@effect/vitest";

import {
  SMOKE_BUDGET_MS,
  loadChaosBudgets,
  planFor,
  repro,
  reportHash,
  runTier,
} from "./runner.ts";
import { faultsForTier, faultById } from "./catalogue.ts";
import { chaosActive, readProviderChunk, readToolJson } from "./inject.ts";
import { CHAOS_SECRET, interpretFault } from "./interpret.ts";
import { failedOracles, runOracles, STUCK_LIMIT_MS, type World } from "./oracles.ts";

const arm = { env: { KIN_CHAOS: "1", NODE_ENV: "test" } };

describe("chaos program", () => {
  it("keeps the smoke budget at 8 minutes or less", () => {
    const budgets = loadChaosBudgets();
    expect(budgets.smokeBudgetMs).toBe(SMOKE_BUDGET_MS);
    expect(budgets.smokeBudgetMs).toBeLessThanOrEqual(8 * 60 * 1000);
    expect(budgets.canaryCostCapUsdPerDay).toBe(3);
    expect(budgets.weeklyCostCapUsdPerWeek).toBe(10);
  });

  it("covers the Kin fault classes", () => {
    const ids = new Set(faultsForTier("nightly").map((fault) => fault.faultClass));
    expect([...ids].sort()).toEqual(
      ["clock", "crash", "db", "provider_stream", "tool_json", "worktree_git", "ws"].sort(),
    );
    expect(faultsForTier("smoke").length).toBeGreaterThanOrEqual(8);
    expect(faultsForTier("canary").map((fault) => fault.id)).toEqual(["canary.synthetic_turn"]);
    expect(faultsForTier("weekly").map((fault) => fault.id)).toEqual(["weekly.live_stream"]);
  });

  it("passes every oracle on the smoke tier and stays inside the budget", () => {
    const report = runTier({ tier: "smoke", seed: 7, commit: "abc", arm });
    const failed = report.scenarios.flatMap((scenario) =>
      scenario.failed.map((oracle) => `${scenario.plan.scenario}:${oracle.id}:${oracle.detail}`),
    );
    expect(failed).toEqual([]);
    expect(report.overBudget).toBe(false);
    expect(report.elapsedMs).toBeLessThan(report.budgetMs ?? 1);
    const first = report.scenarios[0];
    expect(first?.repro).toContain("kin chaos repro");
    expect(first?.repro).toContain("--seed 7");
    expect(first?.repro).toContain(`--commit abc`);
  });

  it("repros the same plan from the seed", () => {
    const fault = faultById("provider.stream_cut");
    expect(fault).toBeDefined();
    if (fault === undefined) return;
    const plan = planFor(11, fault, "smoke", "abc");
    const once = repro({ seed: 11, scenario: plan.scenario, tier: "smoke", commit: "abc", arm });
    const twice = repro({ seed: 11, scenario: plan.scenario, tier: "smoke", commit: "abc", arm });
    expect(once.plan.params).toEqual(twice.plan.params);
    expect(once.plan.params.at).toMatch(/mid_text|mid_tool_call/);
    expect(once.failed).toEqual([]);
    const left = runTier({ tier: "smoke", seed: 11, commit: "abc", arm });
    const right = runTier({ tier: "smoke", seed: 11, commit: "abc", arm });
    expect(reportHash(left)).toBe(reportHash(right));
    const nightly = runTier({ tier: "nightly", seed: 3, commit: "abc", arm });
    expect(
      nightly.scenarios.flatMap((scenario) =>
        scenario.failed.map((oracle) => `${scenario.plan.scenario}:${oracle.id}:${oracle.detail}`),
      ),
    ).toEqual([]);
    expect(nightly.overBudget).toBe(false);
  });

  it("refuses live spend past the canary cap", () => {
    const budgets = loadChaosBudgets();
    let spent = 0;
    let blocked = 0;
    const live = { env: { KIN_CHAOS: "1", KIN_CHAOS_LIVE: "1", NODE_ENV: "test" } };
    for (let index = 0; index < 20; index += 1) {
      const report = runTier({
        tier: "canary",
        seed: index + 1,
        commit: "abc",
        arm: live,
        budgets,
        spentUsd: spent,
      });
      spent += report.chargedUsd;
      blocked += report.scenarios.filter((scenario) =>
        scenario.skipped?.startsWith("cost cap"),
      ).length;
    }
    expect(spent).toBeLessThanOrEqual(budgets.canaryCostCapUsdPerDay);
    expect(blocked).toBeGreaterThan(0);
  });

  it("dry-runs the weekly tier unless live chaos is armed", () => {
    const report = runTier({
      tier: "weekly",
      seed: 1,
      commit: "abc",
      arm: { env: { NODE_ENV: "test" } },
    });
    expect(report.dryRun).toBe(true);
    expect(report.chargedUsd).toBe(0);
    expect(report.scenarios[0]?.skipped).toContain("dry-run");
  });

  it("does not activate seams in production", () => {
    const chunk = '{"tool":"write","full":true}';
    expect(chaosActive({ env: { KIN_CHAOS: "1", NODE_ENV: "production" } })).toBe(false);
    expect(chaosActive({ env: { KIN_CHAOS: "1", KIN_RUNTIME: "production" } })).toBe(false);
    expect(chaosActive({ env: { KIN_CHAOS: "1" }, production: true })).toBe(false);
    expect(chaosActive({ env: { NODE_ENV: "test" } })).toBe(false);
    expect(chaosActive({ env: { KIN_CHAOS: "1", NODE_ENV: "test" } })).toBe(true);
    const off = { env: { KIN_CHAOS: "1", NODE_ENV: "production" } };
    expect(readProviderChunk(off, "provider.stream", chunk)).toBe(chunk);
    expect(readToolJson(off, "tool.json", chunk)).toBe(chunk);
    const on = { env: { KIN_CHAOS: "1", NODE_ENV: "test" } };
    expect(readProviderChunk(on, "provider.stream", chunk).length).toBeLessThan(chunk.length);
    expect(readToolJson(on, "tool.json", chunk)).not.toBe(chunk);
    expect(readProviderChunk(on, "db", chunk)).toBe(chunk);
  });
});

describe("oracles", () => {
  function healthy(): World {
    return interpretFault("provider.empty_response", {});
  }

  it("names all nine", () => {
    expect(runOracles(healthy()).map((oracle) => oracle.id)).toEqual([
      "I-LOSS",
      "I-CORRUPT",
      "I-WRONG",
      "I-DOUBLE",
      "I-STUCK",
      "I-RAW",
      "I-HONEST",
      "I-LEAK",
      "I-RECORD",
    ]);
  });

  it("fails the oracle that the broken world violates", () => {
    const base = healthy();
    const cases: ReadonlyArray<readonly [string, World]> = [
      ["I-LOSS", { ...base, savedText: [] }],
      ["I-CORRUPT", { ...base, partialWrite: true }],
      ["I-DOUBLE", { ...base, deliveries: ["a"], appliedWrites: ["a", "a"] }],
      ["I-STUCK", { ...base, pendingMsAfterClear: STUCK_LIMIT_MS + 1 }],
      ["I-RAW", { ...base, rawErrorVisible: true }],
      ["I-HONEST", { ...base, recovered: false, plainSentences: [] }],
      ["I-LEAK", { ...base, logs: base.secret }],
      ["I-RECORD", { ...base, actions: ["missing-action"] }],
    ];
    for (const [id, world] of cases) {
      const failed = failedOracles(world).map((oracle) => oracle.id);
      expect(failed, id).toContain(id);
    }
    expect(base.secret).toBe(CHAOS_SECRET);
    expect(failedOracles({ ...base, crossProject: true }).map((oracle) => oracle.id)).toContain(
      "I-LEAK",
    );
    const crownedReviewer = {
      ...base,
      laneTrace: [
        {
          move: "crown" as const,
          role: "reviewer" as const,
          will: "present" as const,
          phaseAfter: "crowned" as const,
        },
      ],
    };
    expect(failedOracles(crownedReviewer).map((oracle) => oracle.id)).toContain("I-WRONG");
  });
});

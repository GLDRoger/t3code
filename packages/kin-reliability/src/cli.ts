#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - `kin` is a CLI; stdout and wall-clock `now` are the interface.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { loadChaosBudgets, repro, runTier } from "./chaos/runner.ts";
import type { TierId } from "./chaos/catalogue.ts";
import { TIER_IDS } from "./chaos/catalogue.ts";
import { appendError, loadSweepConfig, tickErrorSweep } from "./sweep/sweep.ts";
import { BEND_AGENTS_BLOCK, INSTALL_INSTRUCTIONS, installBend } from "./verify/bend.ts";
import { runVerify } from "./verify/run.ts";

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function has(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function tierOf(value: string | undefined): TierId {
  if (value !== undefined && (TIER_IDS as readonly string[]).includes(value))
    return value as TierId;
  throw new Error(`tier must be one of ${TIER_IDS.join(", ")}`);
}

function printVerifyText(report: Awaited<ReturnType<typeof runVerify>>): void {
  console.log(`kin verify: ${report.verdict}`);
  console.log(
    `bend ${report.bend.version ?? "not installed"} (pin ${report.bend.pin}, match ${report.bend.matchesPin})`,
  );
  for (const level of report.levels) {
    const reason = level.reason === null ? "" : `: ${level.reason.split("\n")[0]}`;
    console.log(`${level.level} ${level.status} ${level.elapsedMs.toFixed(1)}ms${reason}`);
  }
  console.log(report.loopholes.summary);
  console.log(report.laneStateNote);
  console.log(`healed ${report.healed}`);
  if (!report.bend.installed) console.log(INSTALL_INSTRUCTIONS);
}

/**
 * `kin verify`, `kin chaos`, `kin sweep`.
 * The product CLI is `kin`; until lane 1 mounts it, `t3 kin …` and
 * `node --experimental-strip-types packages/kin-reliability/src/cli.ts …` both work.
 */
export async function runKinCli(args: readonly string[]): Promise<number> {
  const [command, sub, ...rest] = args;
  if (command === "agents-block" || (command === "verify" && has(args, "--print-agents-block"))) {
    console.log(BEND_AGENTS_BLOCK);
    return 0;
  }
  if (command === "verify") {
    if (has(args, "--install-bend")) {
      const installed = installBend();
      if (installed.exitCode !== 0) {
        console.error(installed.stderr || installed.stdout || installed.error);
        return installed.exitCode ?? 1;
      }
    }
    const boundText = flag(args, "--bound");
    const bendDir = flag(args, "--bend-dir");
    const corpusDir = flag(args, "--corpus");
    const report = await runVerify({
      ...(bendDir === undefined ? {} : { bendDir }),
      ...(corpusDir === undefined ? {} : { corpusDir }),
      ...(boundText === undefined ? {} : { bound: Number(boundText) }),
      strictPin: has(args, "--strict"),
      verdict: has(args, "--verdict"),
    });
    printVerifyText(report);
    if (has(args, "--json")) console.log(JSON.stringify(report));
    return report.exitCode;
  }
  if (command === "chaos") {
    const budgets = loadChaosBudgets();
    const arm = { env: process.env };
    if (sub === "repro") {
      const scenario = flag(rest, "--scenario");
      const seed = Number(flag(rest, "--seed") ?? "1");
      const commit = flag(rest, "--commit") ?? "unknown";
      if (scenario === undefined) throw new Error("repro needs --scenario");
      const result = repro({
        seed,
        scenario,
        tier: tierOf(flag(rest, "--tier")),
        commit,
        arm,
      });
      console.log(JSON.stringify(result, null, 2));
      console.log(result.repro);
      return result.failed.length === 0 ? 0 : 1;
    }
    const tier = tierOf(flag(rest, "--tier") ?? sub ?? "smoke");
    const report = runTier({
      tier,
      seed: Number(flag(rest, "--seed") ?? "1"),
      commit: flag(rest, "--commit") ?? "unknown",
      arm,
      budgets,
    });
    const out = flag(rest, "--out");
    if (out !== undefined) {
      NodeFS.mkdirSync(out, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(out, "summary.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
    console.log(JSON.stringify(report, null, 2));
    return report.overBudget || report.scenarios.some((scenario) => scenario.failed.length > 0)
      ? 1
      : 0;
  }
  if (command === "sweep") {
    const dir = flag(args, "--dir");
    if (dir === undefined) throw new Error("sweep needs --dir");
    const now = Number(flag(args, "--now") ?? Date.now());
    const message = flag(args, "--error");
    if (message !== undefined) {
      appendError(dir, { atMs: now, source: "log", message });
    }
    const result = tickErrorSweep({ dir, nowMs: now, config: loadSweepConfig() });
    console.log(JSON.stringify(result));
    return 0;
  }
  console.log(`kin verify [--bound N] [--strict] [--verdict] [--install-bend] [--print-agents-block]
kin chaos run --tier smoke|nightly|canary|weekly --seed N --commit SHA
kin chaos repro --seed N --scenario ID --tier TIER --commit SHA
kin sweep --dir DIR [--now MS] [--error MESSAGE]
kin agents-block`);
  return command === undefined ? 0 : 2;
}

const entry = process.argv[1];
const isDirect = entry !== undefined && import.meta.url === NodeURL.pathToFileURL(entry).href;
if (isDirect) {
  runKinCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

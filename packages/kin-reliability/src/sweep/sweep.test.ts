// @effect-diagnostics nodeBuiltinImport:off - Sweep tests use a temp directory on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { healDecision } from "./sweep.ts";
import {
  errorSweepTaskSpec,
  groupErrors,
  loadSweepConfig,
  runSweep,
  signatureOf,
  tickErrorSweep,
  toDelegateTaskInput,
  TRIAGE_PREFIX,
  triagePrompt,
} from "./sweep.ts";

describe("error sweep", () => {
  it("reads the cap and the rate limit from config", () => {
    const config = loadSweepConfig();
    expect(config.perHourCap).toBe(3);
    expect(config.minMsBetweenOpens).toBe(600_000);
    expect(config.intervalMs).toBe(3_600_000);
    expect(config.triageModel.length).toBeGreaterThan(0);
    expect(errorSweepTaskSpec(config).schedule).toEqual({
      type: "interval",
      everyMs: config.intervalMs,
    });
  });

  it("groups errors that differ only by ids and paths", () => {
    const left = signatureOf("stream cut /tmp/run/a uuid 11111111-1111-4111-8111-111111111111");
    const right = signatureOf("stream cut /tmp/run/b uuid 22222222-2222-4222-8222-222222222222");
    expect(left).toBe(right);
    expect(signatureOf("database locked")).not.toBe(left);
    const groups = groupErrors([
      { atMs: 1, source: "log", message: "stream cut /tmp/a 1" },
      { atMs: 2, source: "log", message: "stream cut /tmp/b 2" },
      { atMs: 3, source: "oracle", message: "database locked" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.count === 2)?.source).toBe("log");
  });

  it("keeps a byte-stable triage prefix", () => {
    const first = triagePrompt("sig-a", ["one"]);
    const second = triagePrompt("sig-b", ["two"]);
    expect(first.startsWith(TRIAGE_PREFIX)).toBe(true);
    expect(first.slice(0, TRIAGE_PREFIX.length)).toBe(second.slice(0, TRIAGE_PREFIX.length));
    expect(first).not.toBe(second);
  });

  it("opens at most the cap and dedupes an open signature", () => {
    const config = {
      ...loadSweepConfig(),
      perHourCap: 2,
      minMsBetweenOpens: 600_000,
    };
    const errors = ["alpha", "beta", "gamma"].map((name) => ({
      atMs: 0,
      source: "log" as const,
      message: `failure class ${name}`,
    }));
    const first = runSweep({
      errors,
      state: {
        lastRunMs: null,
        lastOpenMs: null,
        hourBucket: null,
        openedThisHour: 0,
        signatures: {},
      },
      config,
      nowMs: 10_000_000,
    });
    expect(first.opened).toHaveLength(2);
    expect(first.decisions.filter((decision) => decision.action === "capped")).toHaveLength(1);
    expect(first.opened[0]?.triageMode).toBe("heuristic");
    const delegate = toDelegateTaskInput(first.opened[0]!);
    expect(delegate.role).toBe("implementation");
    expect(delegate.mode).toBe("async");
    expect(delegate.clientRequestId).toContain("kin-sweep:");
    expect(delegate.target).toBeUndefined();
    const second = runSweep({
      errors,
      state: first.state,
      config,
      nowMs: 10_000_000 + config.minMsBetweenOpens,
    });
    expect(second.opened).toHaveLength(0);
    expect(
      second.decisions.every(
        (decision) =>
          decision.action === "deduped" ||
          decision.action === "rate_limited" ||
          decision.action === "capped",
      ),
    ).toBe(true);
  });

  it("rate-limits a sweep that runs again too soon", () => {
    const config = { ...loadSweepConfig(), perHourCap: 5, minMsBetweenOpens: 600_000 };
    const errors = [{ atMs: 0, source: "log" as const, message: "only one" }];
    const first = runSweep({
      errors,
      state: {
        lastRunMs: null,
        lastOpenMs: null,
        hourBucket: null,
        openedThisHour: 0,
        signatures: {},
      },
      config,
      nowMs: 5_000_000,
    });
    const again = runSweep({
      errors: [{ atMs: 1, source: "log", message: "a different failure" }],
      state: first.state,
      config,
      nowMs: 5_000_000 + 1_000,
    });
    expect(again.decisions.map((decision) => decision.action)).toEqual(["rate_limited"]);
  });

  it("counts a fix as healed only when verify passed", () => {
    expect(
      healDecision({ verdict: "passed", lawsApproved: true, traceInCorpus: true }).healed,
    ).toBe(true);
    expect(
      healDecision({ verdict: "degraded", lawsApproved: true, traceInCorpus: true }).healed,
    ).toBe(false);
    expect(
      healDecision({ verdict: "passed", lawsApproved: true, traceInCorpus: false }).reasons.join(
        " ",
      ),
    ).toContain("regression corpus");
    expect(
      healDecision({ verdict: "passed", lawsApproved: false, traceInCorpus: true }).healed,
    ).toBe(false);
  });

  it("writes delegate_task lines on the hourly tick and skips early ticks", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-sweep-"));
    const now = 20_000_000;
    tickErrorSweep({
      dir,
      nowMs: now,
      config: { ...loadSweepConfig(), minMsBetweenOpens: 0, perHourCap: 3 },
    });
    NodeFS.appendFileSync(
      NodePath.join(dir, "errors.jsonl"),
      `${JSON.stringify({ atMs: now, source: "oracle", message: "I-LOSS saved text missing" })}\n`,
    );
    const early = tickErrorSweep({
      dir,
      nowMs: now + 1_000,
      config: { ...loadSweepConfig(), minMsBetweenOpens: 0, perHourCap: 3 },
    });
    expect(early.ran).toBe(false);
    const due = tickErrorSweep({
      dir,
      nowMs: now + loadSweepConfig().intervalMs,
      config: { ...loadSweepConfig(), minMsBetweenOpens: 0, perHourCap: 3 },
    });
    expect(due.opened).toBe(1);
    const outbox = NodeFS.readFileSync(NodePath.join(dir, "fix-lane-outbox.jsonl"), "utf8");
    expect(outbox).toContain("kin-sweep:");
    expect(JSON.parse(outbox).role).toBe("implementation");
  });
});

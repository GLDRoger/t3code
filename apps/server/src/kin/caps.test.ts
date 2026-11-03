import { describe, expect, it } from "@effect/vitest";

import { KIN_MAIN_THREAD_CHILD_CAP } from "@t3tools/contracts";

import { delegationCapDecision } from "./caps.ts";

const child = (driver: string, status = "running") => ({ driver, status });

describe("delegation caps", () => {
  it("stops a main thread at 20 active children", () => {
    const children = Array.from({ length: KIN_MAIN_THREAD_CHILD_CAP }, () => child("codex"));
    const decision = delegationCapDecision({
      children,
      targetDriver: "claudeAgent",
      usedPercent: null,
    });
    expect(decision.admit).toBe(false);
    if (!decision.admit) expect(decision.reason).toContain("20");
  });

  it("ignores finished children and honors a plan cap", () => {
    const children = [
      ...Array.from({ length: 7 }, () => child("codex")),
      child("codex", "completed"),
      child("claudeAgent", "failed"),
    ];
    expect(delegationCapDecision({ children, targetDriver: "codex", usedPercent: 10 }).admit).toBe(
      true,
    );
    const full = [...children, child("codex")];
    const decision = delegationCapDecision({
      children: full,
      targetDriver: "codex",
      usedPercent: 10,
    });
    expect(decision.admit).toBe(false);
    if (!decision.admit) expect(decision.reason).toContain("Codex");
  });

  it("stops a plan that is at its usage cap", () => {
    const decision = delegationCapDecision({
      children: [],
      targetDriver: "claudeAgent",
      usedPercent: 90,
    });
    expect(decision.admit).toBe(false);
    if (!decision.admit) expect(decision.reason).toContain("90%");
  });
});

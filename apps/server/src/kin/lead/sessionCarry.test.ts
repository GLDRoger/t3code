import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { type CarryFacts, decideCarry } from "./sessionCarry.ts";

const clean: CarryFacts = {
  enabled: true,
  provider: "claudeAgent",
  ownerThread: true,
  sameChat: true,
  previousCompleted: true,
  marked: false,
  foreignRun: false,
  gapMs: 55 * 60_000,
  sameBoot: true,
  sameModel: true,
  sameInstructions: true,
  sameToolList: true,
  sameLead: true,
  sameMembers: true,
  sameLists: true,
  sameBudgets: true,
  sameRecipes: true,
  sameZone: true,
  paused: false,
  sameStanding: true,
  indexLinesChanged: 40,
  missed: false,
};

describe("decides carry only when every condition holds", () => {
  it.each([
    ["off", { enabled: false, provider: "codex" }],
    ["provider", { provider: "codex", ownerThread: false }],
    ["thread", { ownerThread: false, sameChat: false }],
    ["chat", { sameChat: false, previousCompleted: false }],
    ["ended", { previousCompleted: false, marked: true }],
    ["marked", { marked: true, foreignRun: true }],
    ["foreign_run", { foreignRun: true, gapMs: null }],
    ["expired", { gapMs: 55 * 60_000 + 1, sameBoot: false }],
    ["boot", { sameBoot: false, sameModel: false }],
    ["model", { sameModel: false, sameInstructions: false }],
    ["instructions", { sameInstructions: false, sameToolList: false }],
    ["tool_list", { sameToolList: false, sameLead: false }],
    ["lead", { sameLead: false, sameMembers: false }],
    ["members", { sameMembers: false, sameLists: false }],
    ["lists", { sameLists: false, paused: true }],
    ["paused", { paused: true, sameStanding: false }],
    ["standing", { sameStanding: false, indexLinesChanged: 41 }],
    ["index", { indexLinesChanged: 41, missed: true }],
    ["missed", { missed: true }],
  ] satisfies ReadonlyArray<readonly [string, Partial<CarryFacts>]>)(
    "%s wins over later failures",
    (reason, patch) => {
      expect(decideCarry({ ...clean, ...patch })).toEqual({ carry: false, reason });
    },
  );

  it("carries at both inclusive limits", () => {
    expect(decideCarry(clean)).toEqual({ carry: true });
  });
});

effectIt.effect("starts fresh when budgets, recipes or the owner time zone changes", () =>
  Effect.sync(() => {
    const unchanged = { ...clean, sameBudgets: true, sameRecipes: true, sameZone: true };
    for (const [key, reason] of [
      ["sameBudgets", "budgets"],
      ["sameRecipes", "recipes"],
      ["sameZone", "zone"],
    ] as const) {
      expect(decideCarry({ ...unchanged, [key]: false })).toEqual({ carry: false, reason });
    }
  }),
);

effectIt.effect("size wins over boot and accepts the inclusive limit", () =>
  Effect.sync(() => {
    const atLimit = { ...clean, contextTokens: 100_000, compactAtTokens: 100_000 };
    expect(decideCarry(atLimit)).toEqual({ carry: true });
    expect(decideCarry({ ...atLimit, contextTokens: 100_001, sameBoot: false })).toEqual({
      carry: false,
      reason: "size",
    });
  }),
);

effectIt.effect("refills the session after compaction", () =>
  Effect.sync(() => {
    const compacted = { ...clean, compactedSince: true };
    expect(decideCarry(compacted)).toEqual({ carry: true, refill: true });
    expect(decideCarry({ ...compacted, missed: true })).toEqual({
      carry: false,
      reason: "missed",
    });
  }),
);

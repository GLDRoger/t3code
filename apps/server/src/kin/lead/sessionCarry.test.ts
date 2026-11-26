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
    ["members", { sameMembers: false, paused: true }],
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

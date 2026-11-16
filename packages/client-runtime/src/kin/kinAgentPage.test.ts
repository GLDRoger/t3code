import { describe, expect, it } from "vitest";

import { kinAgentPageCan, kinAgentUsageLine } from "./kinAgentPage.ts";

describe("kinAgentPageCan", () => {
  it.each([
    ["owner", { access: "owner" as const }, "full", true],
    ["co-owner", { access: "co_owner" as const }, "full", true],
    ["project lead", { access: "member" as const, leadsAProject: true }, "short", false],
    ["member", { access: "member" as const }, "short", false],
    ["not yet known", { access: null }, "short", false],
  ])("%s", (_who, viewer, card, edits) => {
    const can = kinAgentPageCan(viewer);
    expect(can.card).toBe(card);
    for (const what of ["edit", "model", "character", "access", "pause", "remove"] as const)
      expect(can[what]).toBe(edits);
  });
});

describe("kinAgentUsageLine", () => {
  it.each([
    [{ turns: 0, tokens: 0 }, "No replies yet this month."],
    [{ turns: 1, tokens: 900 }, "1 reply this month, about 900 tokens."],
    [{ turns: 12, tokens: 1_240_000 }, "12 replies this month, about 1.2M tokens."],
  ])("%j", (used, line) => {
    expect(kinAgentUsageLine(used as never)).toBe(line);
  });
});

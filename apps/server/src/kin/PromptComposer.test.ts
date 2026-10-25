import { describe, expect, it } from "@effect/vitest";

import { composePrompt, composeStablePrefix } from "./PromptComposer.ts";

const shared = {
  runtimeInstructions: "runtime\nYou are running in Kin.",
  kinBasePrompt: "Kin base",
  profileBody: "You are the implementer.",
  userMdTexts: ["House notes"],
  stableHouseContext: "house north",
};

describe("PromptComposer", () => {
  it("keeps the prefix byte-identical for two agents with the same profile and house", () => {
    const first = composePrompt({
      ...shared,
      brief: "Task A\nstarted at 2026-10-24T13:51:00Z\ncounter 1",
    });
    const second = composePrompt({
      ...shared,
      brief: "Task B\nstarted at 2026-10-24T18:02:11Z\ncounter 99",
    });

    expect(first.prefix).toBe(second.prefix);
    expect(first.prefix).toBe(composeStablePrefix(shared));
    expect(first.prefix).not.toContain("2026-10-24");
    expect(first.text.endsWith("counter 1")).toBe(true);
    expect(second.text.endsWith("counter 99")).toBe(true);
    expect(first.text).not.toBe(second.text);
    expect(first.suffix.startsWith("Kin base")).toBe(true);
    expect(first.suffix).not.toContain("You are running in Kin.");
    expect(first.suffix.endsWith("counter 1")).toBe(true);
  });
});

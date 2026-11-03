import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { composeOrderedPrompt, composePrompt, composeStablePrefix } from "./PromptComposer.ts";
import { renderKeeperSlot, withoutEmptyTask } from "./turnBrief.ts";

const shared = {
  runtimeInstructions: "runtime\nYou are running in Kin.",
  kinBasePrompt: "Kin base",
  profileBody: "You are the implementer.",
  userMdTexts: ["House notes"],
  stableHouseContext: "House: web-ui",
};

describe("ordered Kin prompt", () => {
  it("puts the house brief and keeper slot after a byte-stable prefix, and the task last", () => {
    const now = DateTime.makeUnsafe("2026-10-24T12:00:00.000Z");
    const houseLine = [
      "Start here",
      "Agent map: .kin/web.md",
      "Your family",
      "web-ui II",
      "The court",
      "server I",
      "House wills and notes",
    ].join("\n");
    const keeper = withoutEmptyTask(
      renderKeeperSlot({
        house: "web-ui",
        ownerRules: "## Owner rules\n\nDo not weaken a law.\n",
        houseMap: "The web house owns the routes.",
        chronicleText: "As of 2026-10-24T12:00:00.000Z\n\nThe court is quiet.\n",
        now,
        task: "",
      }),
    );
    const first = composeOrderedPrompt({
      prefix: composeStablePrefix(shared),
      houseLine,
      keeper,
      task: "Task A at 2026-10-24T13:51:00Z",
    });
    const second = composeOrderedPrompt({
      prefix: first.prefix,
      houseLine,
      keeper,
      task: "Task B at 2026-10-24T18:02:11Z",
    });
    const composed = composePrompt({ ...shared, brief: first.brief });

    expect(first.prefix).toBe(second.prefix);
    expect(first.prefix).toBe(composed.prefix);
    expect(first.prefix).not.toContain("2026-10-24T13:51");
    expect(first.prompt.indexOf("Start here")).toBeLessThan(first.prompt.indexOf("Your family"));
    expect(first.prompt.indexOf("Your family")).toBeLessThan(first.prompt.indexOf("The court"));
    expect(first.prompt.indexOf("The court")).toBeLessThan(
      first.prompt.indexOf("House wills and notes"),
    );
    expect(first.prompt.indexOf("House wills and notes")).toBeLessThan(
      first.prompt.indexOf("## Owner rules"),
    );
    expect(first.prompt.indexOf("## Owner rules")).toBeLessThan(
      first.prompt.indexOf("## Chronicle"),
    );
    expect(first.prompt.endsWith("Task A at 2026-10-24T13:51:00Z")).toBe(true);
    expect(second.prompt.endsWith("Task B at 2026-10-24T18:02:11Z")).toBe(true);
  });
});

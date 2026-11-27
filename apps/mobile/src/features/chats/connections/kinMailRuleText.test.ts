import { describe, expect, it } from "vite-plus/test";

import { kinMailRulePhoneLines, kinPhoneBreakable } from "./kinMailRuleText";

const ZWSP = String.fromCharCode(0x200b);

describe("the phone's mail rule text", () => {
  it("marks the only places an address may wrap: after @ and after a dot inside a word", () => {
    expect(kinPhoneBreakable("From orders@junipercold.example, with a file")).toBe(
      `From orders@${ZWSP}junipercold.${ZWSP}example, with a file`,
    );
    expect(kinPhoneBreakable("Paused by the owner or a co-owner.")).toBe(
      "Paused by the owner or a co-owner.",
    );
  });

  it("says the lead and its words, why it isn't running, and this month's runs, a line each", () => {
    expect(
      kinMailRulePhoneLines({
        does: "Finance: File the bill.",
        counts: "12 of 30 this month · last ran 26 Nov, 10:42",
        state: { detail: "Paused by the owner or a co-owner." },
      }),
    ).toBe(
      "Finance: File the bill.\nPaused by the owner or a co-owner.\n12 of 30 this month · last ran 26 Nov, 10:42",
    );
    expect(
      kinMailRulePhoneLines({
        does: "Finance: File it.",
        counts: "0 of 30",
        state: { detail: null },
      }),
    ).toBe("Finance: File it.\n0 of 30");
  });
});

import { KinChatError, type KinLeadProfile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinAgentGroups,
  kinRestoreProblem,
  kinRetireOffer,
  kinRetireProblem,
  kinRetiredDirectAgentId,
  kinRetiredWhen,
} from "./kinAgentRetire.ts";

const refusal = (reason: KinChatError["reason"]) =>
  new KinChatError({ reason, message: "The host's own words, never shown." });

describe("retiring an agent", () => {
  it("splits the owner's agents into the ones at work and the retired ones", () => {
    const lead = (agentId: string, retired: boolean) =>
      ({
        agentId,
        ...(retired ? { retired: { at: "2026-11-10T09:00:00.000Z", byPersonId: null } } : {}),
      }) as unknown as KinLeadProfile;
    const groups = kinAgentGroups([lead("tech", false), lead("old", true), lead("growth", false)]);
    expect(groups.active.map((held) => held.agentId)).toEqual(["tech", "growth"]);
    expect(groups.retired.map((held) => held.agentId)).toEqual(["old"]);
  });

  it("offers Retire only while another active agent stays", () => {
    expect(kinRetireOffer({ name: "Tech lead" }, 2)).toEqual({ offered: true });
    expect(kinRetireOffer({ name: "Tech lead" }, 1)).toEqual({
      offered: false,
      why: "Tech lead is your only active agent, so it can't be retired. Add another agent first.",
    });
  });

  it.each([
    ["invalid_state", "Tech lead is your only active agent"],
    ["not_allowed", "Only the person who set up this agent can retire it."],
    ["not_found", "This agent is no longer here."],
    ["unavailable", "Agents aren't running on this server right now."],
  ] as const)("says why a retire was refused as %s", (reason, text) => {
    expect(kinRetireProblem(refusal(reason), "Tech lead")).toContain(text);
  });

  it("says why a restore was refused, and never the host's own message", () => {
    expect(kinRestoreProblem(refusal("conflict"), "Finance")).toBe(
      "An active agent already uses this name. Rename one first.",
    );
    expect(kinRestoreProblem(refusal("not_allowed"), "Finance")).toBe(
      "Only the person who set up this agent can restore it.",
    );
    expect(kinRestoreProblem(new Error("socket closed"), "Finance")).toBe(
      "Couldn't restore Finance. Check your connection and try again.",
    );
  });

  it("names the day an agent was retired", () => {
    const now = Date.parse("2026-11-11T12:00:00");
    expect(kinRetiredWhen("2026-11-11T08:00:00", now)).toBe("Retired today");
    expect(kinRetiredWhen("2026-11-02T08:00:00", now)).toMatch(/^Retired .*2\b/);
    expect(kinRetiredWhen("2025-03-02T08:00:00", now)).toContain("2025");
    expect(kinRetiredWhen(undefined, now)).toBe("Retired");
  });

  it("finds a direct chat's retired agent, and none in a group", () => {
    const members = [
      { leftAt: null, principal: { _tag: "person", personId: "owner" } },
      { leftAt: null, principal: { _tag: "agent", agentId: "old" } },
    ] as never;
    const retired = new Set(["old"]);
    expect(kinRetiredDirectAgentId({ kind: "direct", members }, retired)).toBe("old");
    expect(kinRetiredDirectAgentId({ kind: "team_group", members }, retired)).toBeNull();
    expect(kinRetiredDirectAgentId({ kind: "direct", members }, new Set())).toBeNull();
  });
});

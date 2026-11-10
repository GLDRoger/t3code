import { KinAgentId, KinMemberId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinApplyMention,
  kinGroupNameCheck,
  kinMentionQuery,
  kinMentionsIn,
  type KinMentionCandidate,
} from "./kinGroups.ts";

const lead = (id: string, name: string): KinMentionCandidate => ({
  memberId: KinMemberId.make(`m-${id}`),
  agentId: KinAgentId.make(id),
  name,
});
const growth = lead("growth", "Growth");
const growthLead = lead("growth-lead", "Growth lead");
const tech = lead("tech", "Tech lead");
const leads = [growth, growthLead, tech];

describe("kin group mentions", () => {
  it("offers the leads the typed @ could name", () => {
    const names = (text: string, cursor = text.length) =>
      kinMentionQuery(text, cursor, leads)?.matches.map((match) => match.name) ?? null;
    expect(names("@")).toEqual(["Growth", "Growth lead", "Tech lead"]);
    expect(names("ask @te")).toEqual(["Tech lead"]);
    // A later word of a name finds it; a name typed in full has nothing left to offer.
    expect(names("@lead")).toEqual(["Growth lead", "Tech lead"]);
    expect(names("@Growth")).toEqual(["Growth lead"]);
    expect(names("@Growth l")).toEqual(["Growth lead"]);
    expect(names("@Tech lead")).toBeNull();
    // Not a mention: mid-word, past the name, on another line, or before the cursor's @.
    expect(names("mail me@te")).toBeNull();
    expect(names("@Tech lead what now")).toBeNull();
    expect(names("@te\nmore")).toBeNull();
    expect(names("@te and more", 3)).toEqual(["Tech lead"]);
    expect(kinMentionQuery("@te", 3, [])).toBeNull();
  });

  it("puts the name in place of what was typed", () => {
    expect(kinApplyMention("ask @te about it", 4, 7, "Tech lead")).toEqual({
      text: "ask @Tech lead about it",
      cursor: 15,
    });
    expect(kinApplyMention("@", 0, 1, "Growth")).toEqual({ text: "@Growth ", cursor: 8 });
  });

  it("reads who a message names from its text alone", () => {
    const named = (text: string) => kinMentionsIn(text, leads);
    expect(named("@Tech lead can you look?")).toEqual([tech.memberId]);
    expect(named("@tech LEAD, and @Growth lead: thoughts")).toEqual([
      growthLead.memberId,
      tech.memberId,
    ]);
    // The longer name wins its own text; the shorter one still counts where it stands alone.
    expect(named("@Growth lead")).toEqual([growthLead.memberId]);
    expect(named("@Growth lead and @Growth")).toEqual([growthLead.memberId, growth.memberId]);
    expect(named("@Growthish plans, me@Growth, @Tech leader")).toEqual([]);
    expect(named("no one named")).toEqual([]);
  });

  it("holds back a name the host would refuse", () => {
    expect(kinGroupNameCheck("  Launch  ")).toEqual({ ok: true, title: "Launch" });
    expect(kinGroupNameCheck("   ").ok).toBe(false);
    expect(kinGroupNameCheck("x".repeat(61)).ok).toBe(false);
  });
});

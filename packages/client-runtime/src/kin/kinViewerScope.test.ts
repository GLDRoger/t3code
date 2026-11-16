import { describe, expect, it } from "vite-plus/test";

import { kinNothingOwed, kinNothingShown, kinScopeNote, kinViewerScope } from "./kinViewerScope.ts";

const me = (access: "owner" | "co_owner" | "member", leads: ReadonlyArray<string> = []) =>
  ({
    access,
    leads: leads.map((title, index) => ({ recordId: `p${index}`, key: `P-${index}`, title })),
  }) as unknown as Parameters<typeof kinViewerScope>[0];

describe("kinViewerScope", () => {
  it("says an empty place is empty only to the owner level, and to anyone else what they can see", () => {
    for (const access of ["owner", "co_owner"] as const) {
      const scope = kinViewerScope(me(access));
      expect(kinScopeNote("money", scope)).toBeNull();
      expect(kinNothingShown("money", scope)).toBeNull();
      expect(kinNothingOwed(scope)).toBe("Nobody owes you anything right now.");
    }
    const member = kinViewerScope(me("member"));
    expect(kinNothingShown("money", member)?.title).toBe("Nothing shared with you");
    expect(kinNothingOwed(member)).toContain("The owner or a co-owner decides");
    const lead = kinViewerScope(me("member", ["Invented launch", "Invented app"]));
    expect(kinScopeNote("money", lead)).toBe(
      "Only figures shared with the team, and money filed under Invented launch and Invented app.",
    );
    // Before the host has said who this is, never overclaim.
    expect(kinNothingShown("clients", kinViewerScope(null))?.title).toBe("No clients you can see");
  });
});

import { describe, expect, it } from "@effect/vitest";

import { kinPlaceReach } from "./kinJoin.ts";
import {
  kinDestinations,
  kinDockSelection,
  kinDockShown,
  kinPlaceInPlace,
  kinSettingsGroups,
  kinSettingsPageOf,
} from "./kinNavigation.ts";

const none = { money: false, clients: false, docs: false };

// The seeded roles: the owner and a co-owner run the company; a lead leads a project; a member
// has Clients switched on.
const ROLES = {
  owner: { ownerLevel: true, computer: true, reaches: null },
  coOwner: { ownerLevel: true, computer: false, reaches: null },
  lead: {
    ownerLevel: false,
    computer: false,
    reaches: kinPlaceReach({ places: none, leads: ["P-1"] }),
  },
  member: {
    ownerLevel: false,
    computer: false,
    reaches: kinPlaceReach({ places: { ...none, clients: true }, leads: [] }),
  },
} as const;

describe("kinDestinations", () => {
  it("gives each role the destinations it can open, in the dock's order", () => {
    const of = (role: keyof typeof ROLES) =>
      kinDestinations({ work: true, refused: none, ...ROLES[role] });
    expect(of("owner")).toEqual(["chats", "tasks", "money", "clients", "docs"]);
    expect(of("coOwner")).toEqual(["chats", "tasks", "money", "clients", "docs"]);
    expect(of("lead")).toEqual(["chats", "tasks", "money", "clients", "docs"]);
    expect(of("member")).toEqual(["chats", "tasks", "clients"]);
  });

  it("drops a place the host refused, and everything but Chats without Work", () => {
    expect(
      kinDestinations({ work: true, refused: { ...none, money: true }, ...ROLES.lead }),
    ).toEqual(["chats", "tasks", "clients", "docs"]);
    expect(kinDestinations({ work: false, refused: none, ...ROLES.owner })).toEqual(["chats"]);
    // A member whose reach isn't known yet gets no place that may turn out refused.
    expect(
      kinDestinations({ work: true, refused: none, ownerLevel: false, reaches: null }),
    ).toEqual(["chats", "tasks"]);
  });
});

describe("kinDockShown", () => {
  const owner = ["chats", "tasks", "money", "clients", "docs"] as const;
  it.each([
    // live answer, device's last dock, drawn, known
    ["live", owner, null, owner, true],
    ["live replaces an older cache", ["chats", "tasks"], owner, ["chats", "tasks"], true],
    ["cold start offline keeps the cached places", null, owner, owner, false],
    ["nothing known and nothing cached", null, null, ["chats"], false],
  ] as const)("%s", (_, live, cached, tabs, known) => {
    expect(kinDockShown({ live, cached })).toEqual({ tabs, known });
  });
});

describe("kinDockSelection", () => {
  const member = ["chats", "tasks"] as const;
  const withClients = ["chats", "tasks", "clients"] as const;
  it.each([
    // held, dock, known, shown, leave
    ["in a place the host took away: leave for Chats", "clients", member, true, "chats", true],
    ["in a place while it isn't known yet: stay", "clients", member, false, "chats", false],
    ["in a place still there: stay", "clients", withClients, true, "clients", false],
    ["elsewhere when a place is switched on: stay", "chats", withClients, true, "chats", false],
    ["elsewhere while unknown: stay", "tasks", member, false, "tasks", false],
  ] as const)("%s", (_, held, tabs, known, shown, leave) => {
    expect(kinDockSelection({ held, tabs, known })).toEqual({ shown, leave });
  });
});

describe("kinPlaceInPlace", () => {
  const member = ["chats", "tasks"] as const;
  const withClients = ["chats", "tasks", "clients"] as const;
  // The web never navigates for the host: the open place follows it on its own address.
  it.each([
    // held, places, known, shows
    ["in place and refused: stay and say so", "clients", member, true, "refused"],
    ["refused, then granted: the same address shows it", "clients", withClients, true, "shown"],
    ["while it isn't known yet: stay, loading", "clients", member, false, "pending"],
    ["a place still there", "clients", withClients, false, "shown"],
  ] as const)("%s", (_, held, tabs, known, shows) => {
    expect(kinPlaceInPlace({ held, tabs, known })).toBe(shows);
  });
});

describe("kinSettingsGroups", () => {
  const groups = (role: keyof typeof ROLES, notifications = false) =>
    kinSettingsGroups({ ...ROLES[role], notifications, recommendations: role === "owner" });

  it("gives everyone You, the owner level Company, and This computer only where it opens", () => {
    expect(groups("owner").map((group) => group.id)).toEqual(["you", "company", "computer"]);
    expect(groups("coOwner").map((group) => group.id)).toEqual(["you", "company"]);
    expect(groups("lead").map((group) => group.id)).toEqual(["you"]);
    expect(groups("member").map((group) => group.id)).toEqual(["you"]);
    expect(groups("member")[0]?.pages).toEqual(["profile", "appearance"]);
    expect(groups("member", true)[0]?.pages).toEqual(["profile", "notifications", "appearance"]);
    expect(groups("coOwner")[1]?.pages).toEqual([
      "team",
      "agents",
      "check-ins",
      "connections",
      "deals",
      "memory",
      "company",
      "approvals",
    ]);
    // What Kin suggested is the owner's alone: a co-owner's Company has no Recommendations.
    expect(groups("owner")[1]?.pages.at(-1)).toBe("recommendations");
    // A teammate with Clients on reads the deal stages, and nothing else of the company's.
    const member = kinSettingsGroups({
      ...ROLES.member,
      notifications: false,
      recommendations: false,
      deals: true,
    });
    expect(member.map((group) => [group.id, group.pages])).toEqual([
      ["you", ["profile", "appearance"]],
      ["company", ["deals"]],
    ]);
    expect(kinSettingsPageOf("deals", member)).toBe("deals");
    expect(kinSettingsPageOf("deals", groups("member"))).toBe("profile");
  });

  it("opens a Company address only for the owner level; anything else lands on the profile", () => {
    expect(kinSettingsPageOf("connections", groups("coOwner"))).toBe("connections");
    expect(kinSettingsPageOf("connections", groups("member"))).toBe("profile");
    expect(kinSettingsPageOf("recommendations", groups("owner"))).toBe("recommendations");
    expect(kinSettingsPageOf("recommendations", groups("coOwner"))).toBe("profile");
    expect(kinSettingsPageOf("team", groups("lead"))).toBe("profile");
    expect(kinSettingsPageOf("appearance", groups("member"))).toBe("appearance");
    expect(kinSettingsPageOf("nonsense", groups("owner"))).toBe("profile");
    expect(kinSettingsPageOf(undefined, groups("owner"))).toBe("profile");
  });
});

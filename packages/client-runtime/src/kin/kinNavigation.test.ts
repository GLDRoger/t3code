import { describe, expect, it } from "@effect/vitest";

import { kinPlaceReach } from "./kinJoin.ts";
import { kinDestinations, kinSettingsGroups, kinSettingsPageOf } from "./kinNavigation.ts";

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

describe("kinSettingsGroups", () => {
  const groups = (role: keyof typeof ROLES, notifications = false) =>
    kinSettingsGroups({ ...ROLES[role], notifications });

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
      "memory",
      "company",
      "approvals",
    ]);
  });

  it("opens a Company address only for the owner level; anything else lands on the profile", () => {
    expect(kinSettingsPageOf("connections", groups("coOwner"))).toBe("connections");
    expect(kinSettingsPageOf("connections", groups("member"))).toBe("profile");
    expect(kinSettingsPageOf("team", groups("lead"))).toBe("profile");
    expect(kinSettingsPageOf("appearance", groups("member"))).toBe("appearance");
    expect(kinSettingsPageOf("nonsense", groups("owner"))).toBe("profile");
    expect(kinSettingsPageOf(undefined, groups("owner"))).toBe("profile");
  });
});

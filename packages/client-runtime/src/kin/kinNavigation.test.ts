import { describe, expect, it } from "@effect/vitest";
import { KinAccessMeResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { kinPlaceReach } from "./kinJoin.ts";
import {
  kinDestinations,
  kinDockSelection,
  kinDockShown,
  kinPhoneSettingsRows,
  kinPlaceInPlace,
  kinSettingsGroups,
  kinSettingsPageOf,
} from "./kinNavigation.ts";
import { kinPlacesFromMe } from "./kinPlaces.ts";

const none = { money: false, clients: false, docs: false };
const decodeMe = Schema.decodeSync(KinAccessMeResult);

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

describe("kinPlacesFromMe", () => {
  const me = (
    access: "owner" | "co_owner" | "member",
    places: Partial<typeof none>,
    refused: { readonly money: boolean; readonly docs: boolean } | undefined,
    leads: ReadonlyArray<string> = [],
  ) =>
    decodeMe({
      personId: "rhea",
      access,
      places: { ...none, ...places },
      leads: leads.map((key) => ({ recordId: key, key, title: "Invented project" })),
      ...(refused === undefined ? {} : { refused }),
    });
  const all = ["chats", "tasks", "money", "clients", "docs"];
  // Each role's tabs as the nav and the dock drew them from Work's, Money's and Docs' streams.
  it.each([
    // role, me, owner level, tabs
    ["owner", me("owner", {}, { money: false, docs: false }), true, all],
    ["co-owner", me("co_owner", {}, { money: false, docs: false }), true, all],
    ["lead", me("member", {}, { money: false, docs: false }, ["P-1"]), false, all],
    [
      "member with Clients",
      me("member", { clients: true }, { money: true, docs: true }),
      false,
      ["chats", "tasks", "clients"],
    ],
    [
      "member with Money",
      me("member", { clients: true, money: true }, { money: false, docs: true }),
      false,
      ["chats", "tasks", "money", "clients"],
    ],
    ["the owner's own session before the host answers", null, true, all],
    ["a member before the host answers", null, false, ["chats", "tasks"]],
  ] as const)("%s", (_, held, ownerLevel, tabs) => {
    expect(kinPlacesFromMe({ me: held, ownerLevel, work: true })).toEqual({
      destinations: tabs,
      answered: held !== null,
    });
  });

  it("leaves an older host's places to their own streams, and drops all but Chats without Work", () => {
    expect(
      kinPlacesFromMe({ me: me("member", {}, undefined), ownerLevel: false, work: true }),
    ).toBe(null);
    const owner = me("owner", {}, { money: false, docs: false });
    expect(kinPlacesFromMe({ me: owner, ownerLevel: true, work: false })?.destinations).toEqual([
      "chats",
    ]);
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
    expect(groups("lead").map((group) => group.id)).toEqual(["you", "company"]);
    expect(groups("member").map((group) => group.id)).toEqual(["you", "company"]);
    // A teammate's Company holds What Kin checked, the watches on their own things, and
    // Connections, with only their own mailbox there.
    expect(groups("member")[1]?.pages).toEqual(["watches", "connections"]);
    expect(groups("member")[0]?.pages).toEqual(["profile", "appearance"]);
    expect(groups("member", true)[0]?.pages).toEqual(["profile", "notifications", "appearance"]);
    expect(groups("coOwner")[1]?.pages).toEqual([
      "team",
      "agents",
      "check-ins",
      "watches",
      "connections",
      "deals",
      "memory",
      "company",
      "approvals",
      "host",
    ]);
    // Kin's computer is the owner level's: a teammate never reaches it, even by its address.
    expect(kinSettingsPageOf("host", groups("member"))).toBe("profile");
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
      ["company", ["deals", "watches", "connections"]],
    ]);
    expect(kinSettingsPageOf("deals", member)).toBe("deals");
    expect(kinSettingsPageOf("deals", groups("member"))).toBe("profile");
  });

  it("keeps the phone's Settings to the day's rows: Company for the owner level, the log for a teammate", () => {
    const owner = ["team", "agents", "company", "watches", "host", "stop"];
    expect(kinPhoneSettingsRows(ROLES.owner)).toEqual({
      you: ["profile", "notifications", "appearance", "mailbox"],
      company: owner,
    });
    expect(kinPhoneSettingsRows(ROLES.coOwner).company).toEqual(owner);
    // Clients on or off, a teammate's Company is What Kin checked alone: no read-only Deals.
    expect(kinPhoneSettingsRows(ROLES.member).company).toEqual(["watches"]);
    expect(kinPhoneSettingsRows(ROLES.lead).company).toEqual(["watches"]);
  });

  it("opens a Company address only for the owner level; anything else lands on the profile", () => {
    expect(kinSettingsPageOf("connections", groups("coOwner"))).toBe("connections");
    // A teammate's Connections is theirs too: only their own mailbox is on it.
    expect(kinSettingsPageOf("connections", groups("member"))).toBe("connections");
    expect(kinSettingsPageOf("company", groups("member"))).toBe("profile");
    expect(kinSettingsPageOf("recommendations", groups("owner"))).toBe("recommendations");
    expect(kinSettingsPageOf("recommendations", groups("coOwner"))).toBe("profile");
    expect(kinSettingsPageOf("team", groups("lead"))).toBe("profile");
    expect(kinSettingsPageOf("appearance", groups("member"))).toBe("appearance");
    expect(kinSettingsPageOf("nonsense", groups("owner"))).toBe("profile");
    expect(kinSettingsPageOf(undefined, groups("owner"))).toBe("profile");
  });
});

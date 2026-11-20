// @effect-diagnostics globalDate:off - Fixtures build times relative to a fixed clock.
import { describe, expect, it } from "vite-plus/test";

import {
  KinAgentId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  type KinPartyPage,
  type KinPartyRow,
  type KinProjectRow,
} from "@t3tools/contracts";

import {
  kinProjectPeopleChoices,
  kinNewTaskChoices,
  kinClientContactLine,
  kinClientPageView,
  kinClientRow,
  kinClientsNothing,
  kinClientsQuery,
  kinClientsStartFilter,
  kinClientsTabShown,
  kinClientsTabs,
  KIN_CLIENTS_DEFAULT_FILTER,
  kinLastContactLine,
  kinProjectsByClient,
  kinTouchAt,
  kinTouchNext,
} from "./kinWorkClients.ts";

describe("kinLastContactLine", () => {
  const now = new Date("2026-11-15T10:00:00.000Z");
  it.each([
    [undefined, null],
    [null, "No logged contact yet"],
    ["2026-11-15T08:00:00.000Z", "Last contact today"],
    ["2026-11-13T09:00:00.000Z", "Last contact 2 days ago"],
    ["2026-11-08T10:00:00.000Z", "No logged contact for 7 days"],
    ["2026-09-01T10:00:00.000Z", "No logged contact for 75 days"],
  ] as const)("%s reads %s", (lastAt, line) => {
    expect(kinLastContactLine(lastAt, now)).toBe(line);
  });
});

describe("kinClientContactLine", () => {
  const now = new Date("2026-11-15T10:00:00.000Z");
  const createdAt = "2026-09-30T10:00:00.000Z";
  const day = (iso: string) =>
    new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(iso));
  const touch = { id: "t", title: "Invoice: INV-3", note: null, when: "", removable: false };
  it.each([
    [undefined, undefined, null],
    // Never "yet" beside the pulse's "46 days": both count from when the client was added.
    [null, undefined, `No contact logged since they were added ${day(createdAt)}, 46 days ago`],
    [
      "2026-11-13T09:00:00.000Z",
      touch,
      `Last contact ${day("2026-11-13T09:00:00.000Z")}, 2 days ago: Invoice: INV-3`,
    ],
  ] as const)("%s reads %s", (lastContactAt, latest, line) => {
    expect(kinClientContactLine({ lastContactAt, createdAt }, latest, now)).toBe(line);
  });
});

describe("kinTouchAt", () => {
  it("is now for today and midday for an earlier day, never ahead", () => {
    const now = new Date(2026, 10, 15, 9);
    expect(kinTouchAt("2026-11-15", now)).toBeUndefined();
    expect(kinTouchAt("2026-11-20", now)).toBeUndefined();
    expect(kinTouchAt("2026-11-14", now)).toBe(new Date(2026, 10, 14, 12).toISOString());
  });
});

describe("kinTouchNext", () => {
  it("leaves a follow-up only with a title, due all day on the day picked", () => {
    expect(kinTouchNext("  ", "2026-11-24")).toBeUndefined();
    expect(kinTouchNext(" Send the pilot outline ", "")).toEqual({
      title: "Send the pilot outline",
    });
    expect(kinTouchNext("Send the pilot outline", "2026-11-24")).toEqual({
      title: "Send the pilot outline",
      dueAt: "2026-11-24",
      dueAllDay: true,
    });
    expect(kinTouchNext("x".repeat(281), "")).toHaveProperty("problem");
  });
});

describe("kinClientRow", () => {
  const now = new Date("2026-11-15T10:00:00.000Z");
  const names = { people: new Map(), agents: new Map(), me: null, zone: "Asia/Kolkata" };
  const row: KinPartyRow = {
    recordId: KinRecordId.make("r-C-1"),
    key: KinRecordKey.make("C-1"),
    name: "Pinecrest Pharmacy",
    kind: "client",
    owner: { _tag: "person", personId: KinPersonId.make("owner") },
    active: true,
    sensitive: false,
    weOwe: 0,
    theyOwe: 0,
    late: 0,
    overdue: 0,
    next: null,
    rev: 1,
  };
  it("counts for whoever runs the company and names only for a teammate", () => {
    expect(kinClientRow({ ...row, lastContactAt: null }, names, now).line).toBe(
      "Nothing open · No logged contact yet",
    );
    // A teammate's row comes without counts, so its zeros aren't "Nothing open".
    expect(kinClientRow(row, names, now).line).toBe("");
  });

  const zoya = KinPersonId.make("zoya");
  const named = { ...names, people: new Map([[zoya, "Zoya"]]) };
  const prospect: KinPartyRow = {
    ...row,
    prospect: true,
    source: "Harbour trade fair",
    owner: { _tag: "person", personId: zoya },
    lastContactAt: null,
  };
  it.each([
    ["a prospect", prospect, named, "Prospect", "Zoya", "No next step · from Harbour trade fair"],
    [
      "your own prospect",
      prospect,
      { ...named, me: zoya },
      "Prospect",
      "",
      "No next step · from Harbour trade fair",
    ],
    [
      "a client with nothing next",
      { ...row, lastContactAt: null },
      names,
      null,
      "Nothing open · No logged contact yet",
      "No next step",
    ],
    // Without counts a row can't know there is no next step; a vendor has none to take.
    ["a teammate's name-only row", row, names, null, "", null],
    [
      "a vendor",
      { ...row, kind: "vendor", lastContactAt: null },
      names,
      null,
      "Vendor · Nothing open",
      null,
    ],
    ["a closed prospect", { ...prospect, active: false }, named, "Prospect", "Zoya · Closed", null],
  ] as const)("%s reads its mark, line and next", (_what, held, who, mark, line, next) => {
    const view = kinClientRow(held, who, now);
    expect([view.mark, view.line, view.next, view.noNext]).toEqual([
      mark,
      line,
      next,
      next?.startsWith("No next step") === true,
    ]);
  });

  it("names the next step it has, late or not, and never says there is none", () => {
    const next = {
      key: KinRecordKey.make("W-4"),
      title: "Send the plan",
      dueAt: null,
      dueAllDay: true,
      late: true,
    };
    expect(kinClientRow({ ...prospect, next }, named, now)).toMatchObject({
      next: "Late: Send the plan",
      noNext: false,
    });
  });
});

describe("the clients list's Show and Looked after by", () => {
  const orgId = KinOrgId.make("invented-org");
  const arjun = { _tag: "person", personId: KinPersonId.make("arjun") } as const;
  it.each([
    ["open", {}],
    ["prospects", { prospect: true }],
    ["clients", { kind: "client" }],
    ["vendors", { kind: "vendor" }],
    ["closed", { active: false }],
  ] as const)("%s asks the host for %o", (show, asked) => {
    expect(kinClientsQuery(orgId, { ...KIN_CLIENTS_DEFAULT_FILTER, show })).toEqual({
      orgId,
      ...asked,
    });
  });

  it("asks for whoever looks after them, and words alongside", () => {
    expect(
      kinClientsQuery(orgId, { show: "prospects", lookedAfter: arjun, text: " Fen " }),
    ).toEqual({ orgId, prospect: true, owner: arjun, text: "Fen" });
  });

  it("starts a teammate with Clients on at their own, and everyone else at everyone's", () => {
    const personId = KinPersonId.make("zoya");
    const on = { clients: true } as never;
    expect(kinClientsStartFilter({ access: "member", personId, places: on }).lookedAfter).toEqual({
      _tag: "person",
      personId,
    });
    for (const me of [
      { access: "owner", personId, places: on },
      { access: "co_owner", personId },
      { access: "member", personId, places: { clients: false } as never },
      { access: "member", personId },
    ] as const)
      expect(kinClientsStartFilter(me)).toBe(KIN_CLIENTS_DEFAULT_FILTER);
    expect(kinClientsStartFilter(null)).toBe(KIN_CLIENTS_DEFAULT_FILTER);
  });

  it("says why nothing shows, and offers a prospect where adding one helps", () => {
    const me = KinPersonId.make("zoya");
    const nothing = (filter: Partial<typeof KIN_CLIENTS_DEFAULT_FILTER>) =>
      kinClientsNothing({ ...KIN_CLIENTS_DEFAULT_FILTER, ...filter }, undefined, me);
    expect(nothing({})).toMatchObject({ title: "No clients or prospects yet", offerNew: true });
    expect(nothing({ show: "prospects" })).toMatchObject({ title: "No prospects", offerNew: true });
    expect(nothing({ show: "vendors" })).toMatchObject({ title: "No vendors", offerNew: false });
    expect(nothing({ lookedAfter: { _tag: "person", personId: me } })).toMatchObject({
      title: "You don't look after any yet",
      offerNew: true,
    });
    expect(nothing({ lookedAfter: arjun })).toMatchObject({ offerNew: false });
  });
});

describe("kinClientPageView", () => {
  const now = new Date("2026-11-20T10:00:00.000Z");
  const zoya = KinPersonId.make("zoya");
  const names = { people: new Map([[zoya, "Zoya"]]), agents: new Map(), me: null, zone: "UTC" };
  const page = (party: Partial<KinPartyPage["party"]>, can?: KinPartyPage["can"]) =>
    ({
      party: {
        recordId: KinRecordId.make("r-C-7"),
        key: KinRecordKey.make("C-7"),
        name: "Brightwater Clinics",
        kind: "client",
        owner: { _tag: "person", personId: zoya },
        active: true,
        sensitive: false,
        weOwe: 0,
        theyOwe: 0,
        late: 0,
        overdue: 0,
        next: null,
        rev: 1,
        notes: "",
        terms: null,
        address: null,
        gstin: null,
        placeOfSupply: null,
        sensitiveFields: [],
        createdAt: "2026-11-01T10:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
        closedAt: null,
        seq: 1,
        ...party,
      },
      weOwe: { records: [], total: 0 },
      theyOwe: { records: [], total: 0 },
      projects: [],
      contacts: [],
      ...(can === undefined ? {} : { can }),
    }) as unknown as KinPartyPage;

  it("reads Prospect, where it came from and who looks after it", () => {
    const view = kinClientPageView(
      page({ prospect: true, source: "Harbour trade fair", tags: ["clinics"] }),
      names,
      now,
      true,
    );
    expect(view).toMatchObject({
      line: "Prospect · from Harbour trade fair",
      lookedAfter: { name: "Zoya" },
      source: "Harbour trade fair",
      tags: ["clinics"],
      nextStep: { next: null },
    });
    expect(kinClientPageView(page({}), names, now, true).line).toBe("Client");
  });

  it("opens with the soonest thing owed, and a vendor has no Next step row", () => {
    const next = {
      key: KinRecordKey.make("W-38"),
      title: "Send the revised proposal",
      dueAt: "2026-11-18T00:00:00.000Z",
      dueAllDay: true,
      late: true,
    };
    const step = kinClientPageView(page({ next }), names, now, true).nextStep?.next;
    expect(step).toMatchObject({ title: "Send the revised proposal", late: true });
    expect(step?.line).toMatch(/^Was due .+ · W-38$/);
    expect(kinClientPageView(page({ kind: "vendor" }), names, now, true).nextStep).toBeNull();
  });

  it("takes what the host says this reader may do, and from an older host only the owner level", () => {
    const can = { edit: true, log: true, owner: false };
    expect(kinClientPageView(page({}, can), names, now, false).can).toEqual(can);
    expect(kinClientPageView(page({}), names, now, true).can).toEqual({
      edit: true,
      log: true,
      owner: true,
    });
    expect(kinClientPageView(page({}), names, now, false).can).toEqual({
      edit: false,
      log: false,
      owner: false,
    });
  });
});

describe("kinProjectsByClient", () => {
  const now = new Date(2026, 10, 15, 10);
  const meera = KinPersonId.make("meera");
  const names = { people: new Map([[meera, "Meera"]]), agents: new Map(), me: null, zone: null };
  const clients: Record<string, string> = { Pinecrest: "C-1", "Ambermill Foods": "C-2" };
  const project = (key: string, party: string | null, more: Partial<KinProjectRow> = {}) =>
    ({
      recordId: KinRecordId.make(`r-${key}`),
      key: KinRecordKey.make(key),
      name: `Project ${key}`,
      party:
        party === null
          ? null
          : {
              recordId: KinRecordId.make(`r-${party}`),
              key: KinRecordKey.make(clients[party] ?? ""),
              title: party,
            },
      owner: { _tag: "person", personId: meera },
      state: "open",
      targetAt: null,
      targetAllDay: true,
      open: 6,
      late: 0,
      health: "on_track",
      sensitive: false,
      sensitiveInherited: false,
      rev: 1,
      ...more,
    }) satisfies KinProjectRow;

  it("groups under each client by name, with projects not for a client last", () => {
    const groups = kinProjectsByClient(
      [
        project("P-1", null),
        project("P-2", "Pinecrest"),
        project("P-3", "Ambermill Foods"),
        project("P-4", "Pinecrest"),
      ],
      names,
      now,
    );
    expect(groups.map((group) => [group.title, group.rows.map((row) => row.key)])).toEqual([
      ["Ambermill Foods", ["P-3"]],
      ["Pinecrest", ["P-2", "P-4"]],
      ["Not for a client", ["P-1"]],
    ]);
    expect(groups.map((group) => group.party)).toEqual(["C-2", "C-1", null]);
  });

  it("names the lead and counts, with the target only when there is one", () => {
    const target = new Date(2026, 10, 17, 23, 59).toISOString();
    const [withTarget, without] = kinProjectsByClient(
      [project("P-1", "Pinecrest", { targetAt: target }), project("P-2", null)],
      names,
      now,
    ).flatMap((group) => group.rows);
    expect(withTarget?.line).toMatch(/^Meera · 6 open · target \D*17\D*$/);
    expect(without).toMatchObject({ line: "Meera · 6 open", health: { label: "On track" } });
  });

  // The host sends each viewer only the projects they may see; the tab draws no empty heading.
  it.each([
    ["the owner", null, ["P-1", "P-2", "P-3"], "Meera", ["Pinecrest", "Not for a client"]],
    ["its lead", meera, ["P-1", "P-2", "P-3"], "You", ["Pinecrest", "Not for a client"]],
    ["a member on one project", KinPersonId.make("zoya"), ["P-2"], "Meera", ["Pinecrest"]],
  ])("for %s, a heading only over projects there are", (_who, me, shown, lead, headings) => {
    const all = [project("P-1", null), project("P-2", "Pinecrest"), project("P-3", null)];
    const groups = kinProjectsByClient(
      all.filter((row) => shown.includes(row.key)),
      { ...names, me },
      now,
    );
    expect(groups.map((group) => group.title)).toEqual(headings);
    expect(groups.every((group) => group.rows.length > 0)).toBe(true);
    expect(groups[0]?.rows[0]?.line).toBe(`${lead} · 6 open`);
  });

  it("is no groups for no projects", () => {
    expect(kinProjectsByClient([], names, now)).toEqual([]);
  });
});

describe("kinClientsTabs", () => {
  it("offers Deals only to someone with Clients on, and shows Clients for a deals address without it", () => {
    expect(kinClientsTabs(true).map((tab) => tab.id)).toEqual(["clients", "deals", "projects"]);
    // A project lead with Clients off reaches the place for their client, never its deals.
    expect(kinClientsTabs(false).map((tab) => tab.id)).toEqual(["clients", "projects"]);
    expect(kinClientsTabShown("deals", false)).toBe("clients");
    expect(kinClientsTabShown("projects", false)).toBe("projects");
    expect(kinClientsTabShown("deals", true)).toBe("deals");
  });
});

describe("kinProjectPeopleChoices", () => {
  const person = (id: string, displayName: string) => ({
    personId: KinPersonId.make(id),
    orgId: KinOrgId.make("invented-org"),
    handle: id,
    displayName,
    githubLogin: null,
  });
  it("offers teammates then agents at work, never one already on it or retired", () => {
    // Arjun holds a task in it after being taken off: listed, not on it, so offered again.
    const finance = KinAgentId.make("finance");
    const chief = KinAgentId.make("chief");
    const old = KinAgentId.make("old");
    const choices = kinProjectPeopleChoices({
      people: [person("zoya", "Zoya"), person("arjun", "Arjun"), person("dev", "Dev")],
      names: {
        agents: new Map([
          [finance, "Finance"],
          [chief, "Chief of staff"],
          [old, "Old helper"],
        ]),
        retired: new Set([old]),
      },
      on: [
        { who: { _tag: "person", personId: KinPersonId.make("zoya") }, onIt: true },
        { who: { _tag: "agent", agentId: finance }, onIt: true },
        { who: { _tag: "person", personId: KinPersonId.make("arjun") }, onIt: false },
      ],
    });
    expect(choices.map((one) => one.name)).toEqual(["Arjun", "Dev", "Chief of staff"]);
  });
});

describe("kinNewTaskChoices", () => {
  it("offers a teammate only the projects they lead and no client, as the host takes them", () => {
    const p1 = { key: KinRecordKey.make("P-1") };
    const p2 = { key: KinRecordKey.make("P-2") };
    const choices = { clients: ["C-1"], projects: [p1, p2] };
    const leads = [{ key: p1.key }] as never;
    expect(kinNewTaskChoices(choices, { access: "member", leads })).toEqual({
      clients: [],
      projects: [p1],
    });
    for (const access of ["owner", "co_owner"] as const)
      expect(kinNewTaskChoices(choices, { access, leads: [] })).toBe(choices);
    // Until the host says, or from a host that sends no leads, the host is left to refuse.
    expect(kinNewTaskChoices(choices, null)).toBe(choices);
    expect(kinNewTaskChoices(choices, { access: "member" })).toBe(choices);
    // With Clients on, any client they see goes on their own task.
    expect(
      kinNewTaskChoices(choices, { access: "member", leads, places: { clients: true } as never }),
    ).toEqual({ clients: ["C-1"], projects: [p1] });
  });
});

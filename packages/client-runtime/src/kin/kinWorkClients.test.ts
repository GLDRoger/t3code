// @effect-diagnostics globalDate:off - Fixtures build times relative to a fixed clock.
import { describe, expect, it } from "vite-plus/test";

import {
  KinAgentId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  type KinPartyRow,
  type KinProjectRow,
} from "@t3tools/contracts";

import {
  kinProjectPeopleChoices,
  kinNewTaskChoices,
  kinClientContactLine,
  kinClientRow,
  kinLastContactLine,
  kinProjectsByClient,
  kinTouchAt,
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
  });
});

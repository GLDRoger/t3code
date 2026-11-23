import { KIN_BUSY } from "./kinAnswers.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  KinChatError,
  KinInviteId,
  KinOrgId,
  KinPersonId,
  type KinPeopleCreateInviteResult,
} from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import type { AtomCommandResult } from "../state/runtime.ts";

import {
  KIN_NEW_TEAMMATE_SEES,
  KIN_TEAM_NO_EDITS,
  createKinTeamActions,
  kinInviteLink,
  kinInviteTyped,
  KIN_INVITE_LOCAL_ONLY_NOTE,
  kinShareLink,
  kinNamesakeHandle,
  kinOpenCountsFollower,
  kinPickLine,
  kinRemovedNamesake,
  kinTeamEntrySummary,
  kinTeamView,
  kinTeammateActions,
  kinTeammateKind,
  kinTeammateNameMatch,
  kinTeammatePage,
  kinTeammateKindEditable,
  type KinTeamEdits,
  type KinTeamList,
} from "./kinTeam.ts";

const orgId = KinOrgId.make("org");
const owner = KinPersonId.make("owner");
const mira = KinPersonId.make("mira");
const tomas = KinPersonId.make("tomas");
const person = (personId: KinPersonId, displayName: string) => ({
  personId,
  orgId,
  handle: personId,
  displayName,
  githubLogin: null,
  createdAt: "2026-11-01T00:00:00.000Z",
});
const invite = (id: string, displayName: string, personId: KinPersonId | null = null) => ({
  inviteId: KinInviteId.make(id),
  personId,
  displayName,
  handle: displayName.toLowerCase(),
  createdAt: "2026-11-10T00:00:00.000Z",
  expiresAt: "2026-11-17T12:00:00.000Z",
});
const list: KinTeamList = {
  people: [person(tomas, "Tomas"), person(owner, "Olu"), person(mira, "Mira")],
  joined: [mira],
  invites: [invite("i-new", "Anouk"), invite("i-tomas", "Tomas", tomas)],
};
const states = (edits: KinTeamEdits, from: KinTeamList = list) =>
  kinTeamView(from, edits, owner).map((row) => [row.name, row.state, row.inviteId]);

describe("kinTeamView", () => {
  it("tells apart you, joined, invited and no access, and ties an unopened link to its person", () => {
    expect(states(KIN_TEAM_NO_EDITS)).toEqual([
      ["Olu", "you", null],
      ["Mira", "joined", null],
      ["Anouk", "invited", "i-new"],
      ["Tomas", "no_access", "i-tomas"],
    ]);
    // The list's row: who they are as its line, and a status only when they aren't simply here.
    const withProfiles: KinTeamList = {
      ...list,
      people: [...list.people, person(KinPersonId.make("ines"), "Ines")],
      profiles: [
        { personId: mira, roleTags: ["design"], awayUntil: "2026-11-30" },
        { personId: owner, roleTags: [] },
      ] as never,
    };
    expect(
      kinTeamView(withProfiles, KIN_TEAM_NO_EDITS, owner).map((row) => [
        row.name,
        row.line,
        row.status,
      ]),
    ).toEqual([
      ["Olu", "You", null],
      ["Mira", "design", "Away"],
      ["Anouk", "", "Invited"],
      ["Ines", "", "No access"],
      ["Tomas", "", "Invited"],
    ]);
    expect(kinTeamEntrySummary(list, owner)).toBe("1 teammate, 1 hasn't joined yet");
    // A co-owner's count holds the owner too: every row the Team page lists besides their own.
    const asMira = {
      ...list,
      people: [{ ...person(owner, "Olu"), access: "owner" as const }, person(mira, "Mira")],
    };
    expect(kinTeamEntrySummary(asMira, mira)).toBe("1 teammate, 1 hasn't joined yet");
    expect(
      kinTeamEntrySummary({ people: [person(owner, "Olu")], joined: [], invites: [] }, owner),
    ).toBe("Add the people you work with");
  });

  it("offers the way back that fits where each person stands", () => {
    const [you, joined, invited, noAccess] = kinTeamView(list, KIN_TEAM_NO_EDITS, owner);
    expect(kinTeammateActions(you!)).toEqual({ link: null, cancel: null, remove: false });
    expect(kinTeammateActions(joined!)).toMatchObject({ cancel: null, remove: true });
    expect(kinTeammateActions(invited!)).toMatchObject({
      link: { label: "Make a new link" },
      cancel: { label: "Cancel invite" },
      remove: false,
    });
    // An unopened link is still a way in, so it can be taken away.
    expect(kinTeammateActions(noAccess!)).toMatchObject({ remove: true });
    // Already removed, the link out is ended by cancelling it, never by removing them again.
    const [, , , removed] = kinTeamView(
      { ...list, removed: [{ personId: tomas, access: "member" }] },
      KIN_TEAM_NO_EDITS,
      owner,
    );
    expect(kinTeammateActions(removed!)).toMatchObject({
      cancel: { label: "Cancel unopened link" },
      remove: false,
    });
  });

  it("shows the owner and co-owners, and lets only the owner act on a co-owner or change a kind", () => {
    const kinds: KinTeamList = {
      ...list,
      people: [
        { ...person(owner, "Olu"), access: "owner" },
        { ...person(mira, "Mira"), access: "co_owner" },
      ],
    };
    // Mira, a co-owner, looking: the owner is shown as the owner, with nothing to do there.
    const [you, theOwner] = kinTeamView(kinds, KIN_TEAM_NO_EDITS, mira);
    expect([you?.detail, theOwner?.state, theOwner?.detail]).toEqual(["You", "owner", "Owner"]);
    expect([you?.line, theOwner?.line]).toEqual(["You", "Owner"]);
    expect(kinTeammateActions(theOwner!, "co_owner")).toEqual({
      link: null,
      cancel: null,
      remove: false,
    });
    expect(kinTeammateKindEditable(theOwner!, "owner")).toBe(false);
    const [, coOwner] = kinTeamView(kinds, KIN_TEAM_NO_EDITS, owner);
    expect([coOwner?.detail, coOwner?.line]).toEqual(["Co-owner", "Co-owner"]);
    expect(kinTeammateActions(coOwner!, "co_owner").remove).toBe(false);
    expect(kinTeammateActions(coOwner!, "owner").remove).toBe(true);
    expect(kinTeammateKindEditable(coOwner!, "owner")).toBe(true);
    expect(kinTeammateKindEditable(coOwner!, "co_owner")).toBe(false);
    // Removed, the owner's picker holds the level a new link brings them back at, not the
    // member's level the host holds meanwhile; a host that doesn't say keeps today's.
    const away = (back?: "co_owner" | "member") =>
      kinTeamView(
        {
          ...kinds,
          people: [{ ...person(owner, "Olu"), access: "owner" }, person(mira, "Mira")],
          removed: [{ personId: mira, ...(back === undefined ? {} : { access: back }) }],
        },
        KIN_TEAM_NO_EDITS,
        owner,
      )[1]!;
    expect(kinTeammateKind(away("co_owner"))).toBe("co_owner");
    expect(kinTeammateKind(away("member"))).toBe("member");
    expect(kinTeammateKind(away())).toBe("member");
    expect(kinTeammateKindEditable(away("co_owner"), "owner")).toBe(true);
  });

  it("carries a member's places and says which projects they lead", () => {
    const placed: KinTeamList = {
      ...list,
      people: [{ ...person(mira, "Mira"), access: "member" }],
      joined: [mira],
      invites: [],
      places: [
        {
          personId: mira,
          clients: true,
          docs: false,
          money: false,
          leads: [{ recordId: "p1" as never, key: "P-1", title: "Atlas" as never }],
        },
      ],
    };
    const [row] = kinTeamView(placed, KIN_TEAM_NO_EDITS, owner);
    expect([row?.detail, row?.line, row?.places?.clients]).toEqual([
      "Leads Atlas",
      "Leads Atlas",
      true,
    ]);
  });

  it("opens a teammate's page on what they can see and do, with the rest folded and removal last", () => {
    const placed: KinTeamList = {
      ...list,
      places: [{ personId: mira, clients: true, docs: true, money: false, leads: [] }],
    };
    const [, joined, invited, noAccess] = kinTeamView(placed, KIN_TEAM_NO_EDITS, owner);
    expect(kinTeammatePage(joined!, "owner")).toEqual({
      canSee: true,
      canDo: true,
      folds: ["tasks", "projects", "reach", "profile", "devices"],
      link: "devices",
      remove: true,
    });
    // Before they join there is no person yet: the link is the page.
    expect(kinTeammatePage(invited!, "owner")).toEqual({
      canSee: false,
      canDo: false,
      folds: [],
      link: "open",
      remove: false,
    });
    // Without a device, the link to let them back in stays open, and there are no devices to fold.
    expect(kinTeammatePage(noAccess!, "owner")).toMatchObject({
      folds: ["tasks", "reach", "profile"],
      link: "open",
      remove: true,
    });
    // A co-owner looking at another: they see everything, so no switches, and only the owner acts.
    const coOwner = kinTeamView(
      { ...list, people: [{ ...person(mira, "Mira"), access: "co_owner" }] },
      KIN_TEAM_NO_EDITS,
      owner,
    )[0]!;
    expect(kinTeammatePage(coOwner, "co_owner")).toEqual({
      canSee: false,
      canDo: false,
      folds: ["tasks", "reach", "profile"],
      link: null,
      remove: false,
    });
  });

  it("warns, never refuses, when a new name shares a first name with the team or an open invite", () => {
    expect(kinTeammateNameMatch(list, "mira k")).toBe(
      "Someone called Mira is already on the team. Make the link only if this is someone else.",
    );
    expect(kinTeammateNameMatch(list, " Anouk ")).toBe(
      "Anouk already has an invite that hasn't been opened. Make the link only if this is someone else.",
    );
    expect(kinTeammateNameMatch(list, "Priya")).toBeNull();
    expect(kinTeammateNameMatch(list, "  ")).toBeNull();
    // Someone removed is the host's bring-back offer, not this warning.
    expect(
      kinTeammateNameMatch({ ...list, removed: [{ personId: tomas, access: "member" }] }, "Tomas"),
    ).toBeNull();
  });
});

describe("kinInviteLink", () => {
  it("is the link the phone app and the browser both redeem", () => {
    const secret = "kin-default.0b6f.AbC_d-9";
    const link = kinInviteLink("https://kin.example.test:8443/", secret);
    expect(link).toBe(`https://kin.example.test:8443/kin/invite#${secret}`);
    expect(resolveRemotePairingTarget({ pairingUrl: link })).toMatchObject({
      credential: secret,
      httpBaseUrl: "https://kin.example.test:8443/",
      kinInvite: true,
    });
  });
});

describe("kinInviteTyped", () => {
  it.each([
    ["nothing typed", "", KIN_NEW_TEAMMATE_SEES, false],
    ["only spaces", "   ", KIN_NEW_TEAMMATE_SEES, false],
    ["a name", "Ishaan", KIN_NEW_TEAMMATE_SEES, true],
    ["a switch moved", "", { ...KIN_NEW_TEAMMATE_SEES, money: true }, true],
  ] as const)("%s: asks before closing is %s", (_what, name, sees, typed) => {
    expect(kinInviteTyped({ name, sees })).toBe(typed);
  });
});

describe("kinShareLink", () => {
  it("carries the host's public address when it has one, and notes only a link that opens nowhere else", () => {
    const secret = "kin-default.0b6f.AbC_d-9";
    const cases = [
      // Public given: on it, whatever this device reaches Kin at.
      [
        "https://kin.ambermill.example.test",
        "https://office.example.test/",
        "https://kin.ambermill.example.test/",
        null,
      ],
      [
        "https://kin.ambermill.example.test",
        "http://localhost:5733/",
        "https://kin.ambermill.example.test/",
        null,
      ],
      // Public absent: this device's own address, noted when only this machine reaches it.
      [undefined, "https://kin.example.test/", "https://kin.example.test/", null],
      [undefined, "http://localhost:5733/", "http://localhost:5733/", KIN_INVITE_LOCAL_ONLY_NOTE],
      [undefined, "http://127.0.0.1:3773", "http://127.0.0.1:3773/", KIN_INVITE_LOCAL_ONLY_NOTE],
    ] as const;
    for (const [publicUrl, httpBaseUrl, base, note] of cases)
      expect(kinShareLink({ publicUrl, httpBaseUrl }, secret)).toEqual({
        link: `${base}kin/invite#${secret}`,
        note,
      });
  });
});

const made: KinPeopleCreateInviteResult = {
  inviteId: KinInviteId.make("i-fresh"),
  secret: "kin-default.i-fresh.s3cret",
  displayName: "Tomas",
  handle: "tomas",
  expiresAt: "2026-11-18T00:00:00.000Z",
};
const refused = (reason: KinChatError["reason"]): AtomCommandResult<never, unknown> =>
  AsyncResult.failure(Cause.fail(new KinChatError({ reason, message: "host words" })));
const ok = <A>(value: A): AtomCommandResult<A, unknown> => AsyncResult.success(value);

function harness(answers: {
  readonly create?: () => AtomCommandResult<KinPeopleCreateInviteResult, unknown>;
  readonly revoke?: () => AtomCommandResult<unknown, unknown>;
  readonly remove?: () => AtomCommandResult<unknown, unknown>;
}) {
  const calls: Array<string> = [];
  let edits = KIN_TEAM_NO_EDITS;
  const seen: Array<KinTeamEdits> = [];
  const actions = createKinTeamActions({
    orgId,
    createInvite: async (input) => {
      calls.push(`create:${input.displayName}:${input.personId ?? "new"}`);
      return (answers.create ?? (() => ok(made)))();
    },
    revokeInvite: async (input) => {
      calls.push(`revoke:${input.inviteId}`);
      return (answers.revoke ?? (() => ok<unknown>({ revoked: true })))();
    },
    removeAccess: async (input) => {
      calls.push(`remove:${input.personId}`);
      return (answers.remove ?? (() => ok<unknown>({ revoked: true })))();
    },
    setAccess: async (input) => {
      calls.push(`access:${input.personId}:${input.access}`);
      return ok<unknown>(input);
    },
    update: (change) => {
      edits = change(edits);
      seen.push(edits);
    },
    refresh: async () => {
      calls.push("refresh");
    },
  });
  return { actions, calls, seen, edits: () => edits };
}

describe("createKinTeamActions", () => {
  it("stops the unopened link before making its replacement", async () => {
    const { actions, calls } = harness({});
    const result = await actions.makeLink({
      displayName: "Tomas",
      personId: tomas,
      replaces: KinInviteId.make("i-tomas"),
    });
    expect(calls.filter((call) => call !== "refresh")).toEqual([
      "revoke:i-tomas",
      "create:Tomas:tomas",
    ]);
    expect(result).toMatchObject({ ok: true, invite: { secret: made.secret, replaced: true } });
  });

  it("treats a link that is already gone as stopped, and makes no link when stopping fails", async () => {
    const gone = harness({ revoke: () => refused("not_found") });
    const replaces = KinInviteId.make("i-new");
    expect(
      (await gone.actions.makeLink({ displayName: "Anouk", personId: null, replaces })).ok,
    ).toBe(true);
    const offline = harness({ revoke: () => refused("unavailable") });
    expect(
      (await offline.actions.makeLink({ displayName: "Anouk", personId: null, replaces })).ok,
    ).toBe(false);
    expect(offline.calls).not.toContain("create:Anouk:new");
    // The row comes back: the old link still works.
    expect(states(offline.edits())).toContainEqual(["Anouk", "invited", "i-new"]);
    expect(offline.edits().problem).toBe(`Couldn't cancel this invite. ${KIN_BUSY}`);
  });

  it("says the earlier link is gone when the replacement could not be made", async () => {
    const { actions } = harness({ create: () => refused("unavailable") });
    const result = await actions.makeLink({
      displayName: "Anouk",
      personId: null,
      replaces: KinInviteId.make("i-new"),
    });
    expect(result).toEqual({
      ok: false,
      problem: `Couldn't make this link. ${KIN_BUSY} The earlier link was stopped.`,
    });
  });

  it("offers to bring back the removed person a new name matches, in the host's words", async () => {
    const { actions } = harness({ create: () => refused("conflict") });
    expect(
      await actions.makeLink({ displayName: "Tomas", personId: null, replaces: null }),
    ).toEqual({ ok: false, problem: "host words", bringBack: true });
    // Tomas has no access; Mira, who has joined, and the owner are never a namesake to bring back.
    expect(kinRemovedNamesake(list, " tomas ")?.personId).toBe(tomas);
    expect(kinRemovedNamesake(list, "Mira")).toBeNull();
    // Someone else named Tomas joins: both rows and the picker line read apart by handle.
    const other = KinPersonId.make("tomas-2");
    const both = {
      ...list,
      people: [...list.people, person(other, "Tomas")],
      joined: [mira, other],
    };
    expect(
      kinTeamView(both, KIN_TEAM_NO_EDITS, owner)
        .filter((row) => row.name === "Tomas")
        .map((row) => row.detail.split(" · ")[0]),
    ).toEqual(["@tomas-2", "@tomas"]);
    expect(kinNamesakeHandle(both.people, person(mira, "Mira"))).toBeNull();
    expect(kinPickLine(kinNamesakeHandle(both.people, person(other, "Tomas")), "Invited")).toBe(
      "@tomas-2 · Invited",
    );
  });

  it("shows a removal at once, takes it back on refusal, and after a yes lets the host's list speak", async () => {
    const no = harness({ remove: () => refused("not_allowed") });
    const pending = no.actions.removeAccess(mira);
    expect(states(no.edits())).toContainEqual(["Mira", "no_access", null]);
    expect(await pending).toBe(false);
    expect(states(no.edits())).toContainEqual(["Mira", "joined", null]);
    expect(no.edits().problem).toBe("Only the owner can remove their access.");

    const yes = harness({});
    expect(await yes.actions.removeAccess(tomas)).toBe(true);
    // Held as removed, unopened link and all, until the list was read again; then the host decides,
    // so a new link made afterwards shows on the row.
    expect(yes.seen.map((edits) => edits.removed.has(tomas))).toEqual([true, false]);
    expect(yes.calls).toEqual(["remove:tomas", "refresh"]);
    expect(states(yes.edits())).toContainEqual(["Tomas", "no_access", "i-tomas"]);
  });
});

describe("kinOpenCountsFollower", () => {
  it("reads the counts again when a task change lands, once per change for every open screen", () => {
    const follow = kinOpenCountsFollower();
    // [company, Work's task change number or null while it isn't live, read again?]
    const steps: ReadonlyArray<readonly [string, number | null, boolean]> = [
      ["a", null, false], // Work not live yet: nothing to follow
      ["a", 4, true], // first seen: the counts may predate it (avatars keep them alive)
      ["a", 4, false], // a second screen showing counts over the first
      ["a", 5, true], // a task finished
      ["a", null, false], // offline: keep what is shown
      ["a", 5, false], // back, nothing moved
      ["b", 5, true], // another company follows on its own
      ["a", 2, true], // the stream started over
    ];
    expect(steps.map(([key, seq]) => follow(key, seq))).toEqual(steps.map(([, , read]) => read));
  });
});

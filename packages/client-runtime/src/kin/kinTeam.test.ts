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
  KIN_TEAM_NO_EDITS,
  createKinTeamActions,
  kinInviteLink,
  kinInviteLinkLocalOnly,
  kinTeamEntrySummary,
  kinTeamView,
  kinTeammateActions,
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
    expect(kinTeamEntrySummary(list, owner)).toBe("1 teammate, 1 hasn't joined yet");
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
    expect(kinInviteLinkLocalOnly("http://localhost:5733/")).toBe(true);
    expect(kinInviteLinkLocalOnly("http://127.0.0.1:3773")).toBe(true);
    expect(kinInviteLinkLocalOnly("https://kin.example.test/")).toBe(false);
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
    expect(offline.edits().problem).toBe(
      "Couldn't cancel this invite right now. Try again in a moment.",
    );
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
      problem:
        "Couldn't make this link right now. Try again in a moment. The earlier link was stopped.",
    });
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

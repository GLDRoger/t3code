import {
  EnvironmentAuthorizationError,
  KinChatError,
  type KinInviteId,
  type KinOrgId,
  type KinPeopleCreateInviteInput,
  type KinPeopleCreateInviteResult,
  type KinPeopleListInvitesResult,
  type KinPeopleListResult,
  type KinPeopleRemoveAccessInput,
  type KinPeopleRevokeInviteInput,
  type KinPersonId,
} from "@t3tools/contracts";
import { KIN_INVITE_LINK_PATH } from "@t3tools/shared/remote";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import type { KinAvatarView } from "./kinScreenState.ts";

export const KIN_TEAM_TITLE = "Team";
export const KIN_TEAM_ADD = "Add teammate";
export const KIN_TEAM_LOAD_FAILED = "Couldn't load your team";
export const KIN_TEAMMATE_NAME_MAX = 80;

export const KIN_TEAM_ADD_COPY = {
  title: "Add a teammate",
  detail:
    "Kin makes a link for you to send them. Opening it lets them chat with you and with the agents and groups you add them to. They can't see your code or settings.",
  nameLabel: "Their name",
  namePlaceholder: "Sami Okafor",
  nameHint: "This is how they appear in chats.",
  submit: "Make link",
} as const;

export const KIN_TEAM_EMPTY = {
  title: "No teammates yet",
  detail: "Add someone by name and Kin gives you a link to send them.",
} as const;

export const KIN_TEAM_ONLY_OWNER = {
  title: "Only the owner can open this",
  detail: "The team is managed by the person who runs this workspace.",
} as const;

/** The people and unused invite links of an org, as the host last answered. */
export interface KinTeamList {
  readonly people: KinPeopleListResult["people"];
  readonly joined: KinPeopleListResult["joined"];
  readonly invites: KinPeopleListInvitesResult["invites"];
}

/** What the owner did that the host hasn't confirmed yet, and the last refusal. */
export interface KinTeamEdits {
  readonly cancelled: ReadonlySet<KinInviteId>;
  /** Access being removed: shown as gone until the host's answer has been read back. */
  readonly removed: ReadonlySet<KinPersonId>;
  readonly problem: string | null;
}

export const KIN_TEAM_NO_EDITS: KinTeamEdits = {
  cancelled: new Set(),
  removed: new Set(),
  problem: null,
};

export type KinTeammateState = "you" | "joined" | "invited" | "no_access";

export interface KinTeammate {
  readonly key: string;
  readonly name: string;
  readonly avatar: KinAvatarView;
  /** Null until the invite is opened: only then is there a person. */
  readonly personId: KinPersonId | null;
  /** The link that hasn't been opened yet, if one is out. */
  readonly inviteId: KinInviteId | null;
  readonly state: KinTeammateState;
  /** The row's second line: whether they have joined, and what is still out. */
  readonly detail: string;
}

const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** "18 Nov": the last day an invite link works. */
const formatKinInviteDay = (iso: string): string => dayFormat.format(Date.parse(iso));

const ORDER: Record<KinTeammateState, number> = { you: 0, joined: 1, invited: 2, no_access: 3 };

/** Everyone on the team, joined or not, with the owner first. */
export function kinTeamView(
  list: KinTeamList,
  edits: KinTeamEdits,
  ownerPersonId: string | null,
): ReadonlyArray<KinTeammate> {
  const joined = new Set<string>(list.joined);
  const invites = list.invites.filter((invite) => !edits.cancelled.has(invite.inviteId));
  const rows: Array<KinTeammate> = [];
  for (const person of list.people) {
    const you = person.personId === ownerPersonId;
    // Removing access also cancels the person's unused links.
    const removed = edits.removed.has(person.personId);
    const invite = removed ? undefined : invites.find((held) => held.personId === person.personId);
    const state: KinTeammateState = you
      ? "you"
      : joined.has(person.personId) && !removed
        ? "joined"
        : "no_access";
    const until = invite === undefined ? "" : formatKinInviteDay(invite.expiresAt);
    rows.push({
      key: `person:${person.personId}`,
      name: person.displayName,
      avatar: { kind: "person", seed: `person:${person.personId}` },
      personId: person.personId,
      inviteId: you ? null : (invite?.inviteId ?? null),
      state,
      detail:
        state === "you"
          ? "You"
          : state === "joined"
            ? invite === undefined
              ? "Joined"
              : `Joined. A link for another device hasn't been opened; it works until ${until}.`
            : invite === undefined
              ? "No access. Make a new link to let them back in."
              : `Hasn't opened the new link. It works until ${until}.`,
    });
  }
  for (const invite of invites) {
    if (invite.personId !== null) continue;
    rows.push({
      key: `invite:${invite.inviteId}`,
      name: invite.displayName,
      avatar: { kind: "person", seed: `invite:${invite.inviteId}` },
      personId: null,
      inviteId: invite.inviteId,
      state: "invited",
      detail: `Hasn't joined yet. The link works until ${formatKinInviteDay(invite.expiresAt)}.`,
    });
  }
  return rows.sort(
    (a, b) =>
      ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name) || (a.key < b.key ? -1 : 1),
  );
}

/** People with an open link to get back in; a first invite has no person yet. */
export const kinInvitedPeople = (
  invites: KinTeamList["invites"] | null,
): ReadonlyArray<KinPersonId> =>
  (invites ?? []).flatMap((invite) => (invite.personId === null ? [] : [invite.personId]));

/**
 * Who a people picker shows: teammates who hold Kin now, then re-invited ones who haven't opened
 * the new link, shown as invited and not pickable. Teammates whose access was removed are left out.
 */
export function kinPickablePeople<P extends { readonly personId: KinPersonId }>(
  people: ReadonlyArray<P>,
  joined: ReadonlyArray<KinPersonId>,
  invited: ReadonlyArray<KinPersonId>,
): ReadonlyArray<{ readonly person: P; readonly invited: boolean }> {
  const holds = new Set(joined);
  const asked = new Set(invited);
  return [
    ...people.filter((p) => holds.has(p.personId)).map((person) => ({ person, invited: false })),
    ...people
      .filter((p) => !holds.has(p.personId) && asked.has(p.personId))
      .map((person) => ({ person, invited: true })),
  ];
}

/** The second line of the way in from the chat list. */
export function kinTeamEntrySummary(
  list: KinTeamList | null,
  ownerPersonId: string | null,
): string {
  if (list === null) return "The people who chat with you and your agents";
  const rows = kinTeamView(list, KIN_TEAM_NO_EDITS, ownerPersonId);
  const joined = rows.filter((row) => row.state === "joined").length;
  const waiting = rows.filter((row) => row.state === "invited").length;
  if (joined === 0 && waiting === 0) return "Add the people you work with";
  const parts = [
    ...(joined === 0 ? [] : [joined === 1 ? "1 teammate" : `${joined} teammates`]),
    ...(waiting === 0
      ? []
      : [waiting === 1 ? "1 hasn't joined yet" : `${waiting} haven't joined yet`]),
  ];
  return parts.join(", ");
}

/** A teammate's name as the host will store it, or what to fix. */
export function kinTeammateNameCheck(
  value: string,
): { readonly ok: true; readonly name: string } | { readonly ok: false; readonly problem: string } {
  const name = value.trim();
  if (name === "") return { ok: false, problem: "Type their name." };
  if (name.length > KIN_TEAMMATE_NAME_MAX)
    return { ok: false, problem: `Keep the name under ${KIN_TEAMMATE_NAME_MAX} characters.` };
  return { ok: true, name };
}

/**
 * The link the owner sends: the invite page on the address this device reaches Kin at. A browser
 * opens it; the phone app takes it pasted, scanned, or handed over by that page.
 */
export function kinInviteLink(httpBaseUrl: string, secret: string): string {
  const url = new URL(KIN_INVITE_LINK_PATH, httpBaseUrl);
  url.hash = secret;
  return url.toString();
}

/** A link to this computer's own address opens nowhere else; said beside the link. */
export function kinInviteLinkLocalOnly(httpBaseUrl: string): boolean {
  if (!URL.canParse(httpBaseUrl)) return false;
  const { hostname } = new URL(httpBaseUrl);
  return hostname === "localhost" || hostname === "[::1]" || /^127\./.test(hostname);
}

export const KIN_INVITE_LOCAL_ONLY_NOTE =
  "This link uses an address that only works on this device, so it won't open on anyone else's. Open Kin at the address your team can reach, then make the link there.";

export const KIN_INVITE_PHONE_NOTE =
  'It opens in a browser, or in the phone app: on its first screen they tap "I have a join link".';

/** What the owner reads beside a link, once: who it lets in, that it works once, and until when. */
export function kinInviteLinkCopy(invite: {
  readonly displayName: string;
  readonly expiresAt: string;
  readonly replaced: boolean;
}): { readonly title: string; readonly detail: string } {
  const name = invite.displayName;
  return {
    title: `Send this link to ${name}`,
    detail: `Anyone with this link can join as ${name} until it is used. It works once, until ${formatKinInviteDay(invite.expiresAt)}. Kin doesn't send it for you and won't show it again; if it gets lost, make a new one here.${invite.replaced ? " The earlier link no longer works." : ""}`,
  };
}

/** The confirmation before a teammate is signed out everywhere. */
export function kinRemoveAccessCopy(name: string): {
  readonly title: string;
  readonly detail: string;
  readonly confirm: string;
} {
  return {
    title: `Remove ${name}'s access?`,
    detail: `${name} is signed out on every device and any unused link stops working. Their messages stay, and they keep their place in groups and chats, so a new link brings them back to all of it.`,
    confirm: "Remove access",
  };
}

/** The button that takes back an unopened link, and the confirmation before it does. */
function kinCancelInviteCopy(teammate: KinTeammate) {
  const label = teammate.state === "invited" ? "Cancel invite" : "Cancel unopened link";
  return {
    label,
    title: `${label}?`,
    detail: `The link you gave ${teammate.name} stops working. You can make a new one later.`,
    keep: "Keep it",
  };
}

/** What a teammate's details offer, by where they stand. */
export function kinTeammateActions(teammate: KinTeammate): {
  /** The button that makes a link, and what it says underneath. */
  readonly link: { readonly label: string; readonly hint: string } | null;
  readonly cancel: ReturnType<typeof kinCancelInviteCopy> | null;
  readonly remove: boolean;
} {
  if (teammate.state === "you") return { link: null, cancel: null, remove: false };
  const replaces = teammate.inviteId !== null;
  return {
    link:
      teammate.state === "joined"
        ? {
            label: "Link for another device",
            hint: replaces
              ? "Makes a fresh link and stops the unopened one working."
              : "For a new phone or browser. The devices they already use stay signed in.",
          }
        : {
            label: "Make a new link",
            hint: replaces
              ? "Use this if the link was lost. The earlier link stops working."
              : "Lets them back in as the same person, with their chats.",
          },
    cancel: replaces ? kinCancelInviteCopy(teammate) : null,
    remove: teammate.personId !== null && (teammate.state === "joined" || replaces),
  };
}

/** One line per lead on a teammate's details; the lead's own details change it. */
export function kinTeammateLeadLine(allowed: boolean | null): string {
  return allowed === null ? "Checking…" : allowed ? "Can message" : "Can't message";
}

const isChatError = Schema.is(KinChatError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/** Why a team change didn't happen, in the owner's words. `doing` reads "make this link". */
function kinTeamProblem(error: unknown, doing: string): string {
  if (isAuthorizationError(error)) return `This device isn't allowed to ${doing}.`;
  if (!isChatError(error)) return `Couldn't ${doing}. Check your connection and try again.`;
  switch (error.reason) {
    case "not_allowed":
      return `Only the owner can ${doing}.`;
    case "not_found":
      return "That person or link is no longer here.";
    case "disabled":
      return "Kin is turned off on this server.";
    default:
      return `Couldn't ${doing} right now. Try again in a moment.`;
  }
}

const isGone = (error: unknown) => isChatError(error) && error.reason === "not_found";

type Sent<A> = Promise<AtomCommandResult<A, unknown>>;

/** A link fresh from the host. The secret lives only in the screen that shows it. */
export interface KinMadeInvite extends KinPeopleCreateInviteResult {
  /** An earlier unopened link was stopped to make this one. */
  readonly replaced: boolean;
}

/**
 * The owner's team changes. Cancelling and removing show at once and come back if the host
 * refuses; a link is only shown once the host has made it.
 */
export function createKinTeamActions(options: {
  readonly orgId: KinOrgId;
  readonly createInvite: (input: KinPeopleCreateInviteInput) => Sent<KinPeopleCreateInviteResult>;
  readonly revokeInvite: (input: KinPeopleRevokeInviteInput) => Sent<unknown>;
  readonly removeAccess: (input: KinPeopleRemoveAccessInput) => Sent<unknown>;
  readonly update: (change: (edits: KinTeamEdits) => KinTeamEdits) => void;
  /** Reads the people and links again; settles when both are in, or couldn't be read. */
  readonly refresh: () => Promise<void>;
}) {
  const { orgId, update } = options;
  const without = <A>(set: ReadonlySet<A>, value: A) => {
    const next = new Set(set);
    next.delete(value);
    return next;
  };
  const cancelInvite = async (inviteId: KinInviteId): Promise<boolean> => {
    update((edits) => ({
      ...edits,
      problem: null,
      cancelled: new Set(edits.cancelled).add(inviteId),
    }));
    const result = await options.revokeInvite({ orgId, inviteId });
    const failure = AsyncResult.isSuccess(result) ? null : squashAtomCommandFailure(result);
    // Already opened or run out: the list says which once it is read again.
    const done = failure === null || isGone(failure);
    if (!done)
      update((edits) => ({
        ...edits,
        cancelled: without(edits.cancelled, inviteId),
        problem: kinTeamProblem(failure, "cancel this invite"),
      }));
    void options.refresh();
    return done;
  };
  return {
    cancelInvite,
    /**
     * A link for a new teammate, or for a person who needs another. `replaces` is their unopened
     * link, stopped first so two never work at once.
     */
    makeLink: async (input: {
      readonly displayName: string;
      readonly personId: KinPersonId | null;
      readonly replaces: KinInviteId | null;
    }): Promise<
      | { readonly ok: true; readonly invite: KinMadeInvite }
      | { readonly ok: false; readonly problem: string }
    > => {
      if (input.replaces !== null && !(await cancelInvite(input.replaces)))
        return { ok: false, problem: kinTeamProblem(null, "make this link") };
      const result = await options.createInvite({
        orgId,
        displayName: input.displayName,
        ...(input.personId === null ? {} : { personId: input.personId }),
      });
      void options.refresh();
      if (AsyncResult.isSuccess(result)) {
        if (input.replaces !== null) {
          const replaced = input.replaces;
          update((edits) => ({ ...edits, cancelled: without(edits.cancelled, replaced) }));
        }
        return { ok: true, invite: { ...result.value, replaced: input.replaces !== null } };
      }
      const problem = kinTeamProblem(squashAtomCommandFailure(result), "make this link");
      return {
        ok: false,
        problem: input.replaces === null ? problem : `${problem} The earlier link was stopped.`,
      };
    },
    removeAccess: async (personId: KinPersonId): Promise<boolean> => {
      update((edits) => ({
        ...edits,
        problem: null,
        removed: new Set(edits.removed).add(personId),
      }));
      const result = await options.removeAccess({ orgId, personId });
      const ok = AsyncResult.isSuccess(result);
      // The row stays as removed until the list that says so is in, so it never flickers back.
      if (ok) await options.refresh();
      update((edits) => ({
        ...edits,
        removed: without(edits.removed, personId),
        problem: ok
          ? edits.problem
          : kinTeamProblem(squashAtomCommandFailure(result), "remove their access"),
      }));
      if (!ok) void options.refresh();
      return ok;
    },
    dismissProblem: () => update((edits) => ({ ...edits, problem: null })),
  };
}

export type KinTeamActions = ReturnType<typeof createKinTeamActions>;

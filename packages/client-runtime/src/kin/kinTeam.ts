import {
  KinChatError,
  type KinInviteId,
  type KinOrgId,
  type KinPeopleCreateInviteInput,
  type KinPeopleCreateInviteResult,
  type KinPeopleListInvitesResult,
  type KinPeopleListResult,
  type KinPeopleRemoveAccessInput,
  type KinPeopleRevokeInviteInput,
  type KinPeopleSetAccessInput,
  type KinPersonAccess,
  type KinPersonId,
  type KinPersonPlaces,
  type KinPersonProfile,
  kinIsLocalOnlyHost,
  kinOwnerLevel,
  kinWhenFormat,
} from "@t3tools/contracts";
import { KIN_INVITE_LINK_PATH } from "@t3tools/shared/remote";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import type { KinAvatarView } from "./kinScreenState.ts";
import { kinRoleLine } from "./kinProfiles.ts";
import { kinFailureText } from "./kinAnswers.ts";

export const KIN_TEAM_TITLE = "Team";
export const KIN_TEAM_ADD = "Add teammate";
export const KIN_TEAM_LOAD_FAILED = "Couldn't load your team";
export const KIN_TEAMMATE_NAME_MAX = 80;

export const KIN_TEAM_ADD_COPY = {
  linkDropped: (name: string) =>
    `The connection dropped before the link could be shown. Make a new link for ${name} from Team once you're back online.`,
  title: "Add a teammate",
  detail:
    "Kin makes a link for you to send them. Opening it lets them chat with you, your agents and the groups you add them to. They can't see your code or settings.",
  nameLabel: "Their name",
  namePlaceholder: "Sami Okafor",
  nameHint: "This is how they appear in chats.",
  submit: "Make link",
  someoneElse: "Someone else with the same name",
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
  /** Everyone's roles, when read; rows show them under the name. */
  readonly profiles?: ReadonlyArray<KinPersonProfile> | undefined;
  /** What each person sees beyond Tasks, from a host that has places. */
  readonly places?: ReadonlyArray<KinPersonPlaces> | undefined;
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

export type KinTeammateState = "you" | "owner" | "joined" | "invited" | "no_access";

export interface KinTeammate {
  readonly key: string;
  readonly name: string;
  readonly avatar: KinAvatarView;
  /** Null until the invite is opened: only then is there a person. */
  readonly personId: KinPersonId | null;
  /** The link that hasn't been opened yet, if one is out. */
  readonly inviteId: KinInviteId | null;
  readonly state: KinTeammateState;
  /** What they may do in Kin; an invite nobody opened is a member's. */
  readonly access: KinPersonAccess;
  /** The row's second line: whether they have joined, and what is still out. */
  readonly detail: string;
  /** Their role tags, as one line; empty when none. */
  readonly roles: string;
  /** "3 open, 1 late": what they hold now; empty when the host doesn't say. */
  readonly load: string;
  /** Their places and the projects they lead; null for the owner-level and invites. */
  readonly places: KinPersonPlaces | null;
}

/** "3 open, 1 late", "2 open" or "Nothing open". */
const kinLoadLine = (load: { readonly open: number; readonly late: number }) =>
  load.open === 0
    ? "Nothing open"
    : load.late === 0
      ? `${load.open} open`
      : `${load.open} open, ${load.late} late`;

/**
 * Open-task counts come with the profiles, which avatars keep alive and only people changes move.
 * A screen showing counts calls this with Work's task change number (null while Work isn't live);
 * true means read the profiles again. One per app, so screens stacked on each other read once.
 */
export function kinOpenCountsFollower(): (key: string, seq: number | null) => boolean {
  const read = new Map<string, number>();
  return (key, seq) => {
    if (seq === null || read.get(key) === seq) return false;
    read.set(key, seq);
    return true;
  };
}

/** The places a member's switches turn on, in the order the dock shows them. */
export const KIN_PLACE_SWITCHES = [
  {
    place: "money",
    label: "Can see Money",
    detail: "Read-only figures of what you share with the team.",
  },
  {
    place: "clients",
    label: "Can see Clients",
    detail: "Client names and contacts. Never terms or what they owe.",
  },
  {
    place: "docs",
    label: "Can see Docs",
    detail: "Company docs and those you share. A project's people read its docs anyway.",
  },
] as const;

/** "Leads Atlas, Billing": the projects someone runs, or nothing. */
const kinLeadsLine = (places: KinPersonPlaces | null) =>
  places === null || places.leads.length === 0
    ? ""
    : `Leads ${places.leads.map((project) => project.title).join(", ")}`;

const dayFormat = kinWhenFormat("date");

/** "18 Nov": the last day an invite link works. */
const formatKinInviteDay = (iso: string): string => dayFormat.format(Date.parse(iso));

const ORDER: Record<KinTeammateState, number> = {
  you: 0,
  owner: 1,
  joined: 2,
  invited: 3,
  no_access: 4,
};

/** The words for each kind, as the Team screens say them. */
const KIN_ACCESS_LABELS: Record<KinPersonAccess, string> = {
  owner: "Owner",
  co_owner: "Co-owner",
  member: "Member",
};

/** Everyone on the team, joined or not, with the owner first. */
export function kinTeamView(
  list: KinTeamList,
  edits: KinTeamEdits,
  ownerPersonId: string | null,
): ReadonlyArray<KinTeammate> {
  const joined = new Set<string>(list.joined);
  const invites = list.invites.filter((invite) => !edits.cancelled.has(invite.inviteId));
  const rows: Array<KinTeammate> = [];
  const roles = new Map(
    (list.profiles ?? []).map((profile) => [profile.personId, kinRoleLine(profile.roleTags)]),
  );
  const loads = new Map(
    (list.profiles ?? []).flatMap((profile) =>
      profile.load === undefined ? [] : [[profile.personId, kinLoadLine(profile.load)] as const],
    ),
  );
  for (const person of list.people) {
    const you = person.personId === ownerPersonId;
    const access = person.access ?? "member";
    // Removing access also cancels the person's unused links.
    const removed = edits.removed.has(person.personId);
    const invite = removed ? undefined : invites.find((held) => held.personId === person.personId);
    const state: KinTeammateState = you
      ? "you"
      : access === "owner"
        ? "owner"
        : joined.has(person.personId) && !removed
          ? "joined"
          : "no_access";
    const until = invite === undefined ? "" : formatKinInviteDay(invite.expiresAt);
    const places =
      access === "member"
        ? (list.places?.find((held) => held.personId === person.personId) ?? null)
        : null;
    const namesake = kinNamesakeHandle(list.people, person);
    rows.push({
      key: `person:${person.personId}`,
      name: person.displayName,
      avatar: { kind: "person", seed: `person:${person.personId}` },
      personId: person.personId,
      inviteId: you || state === "owner" ? null : (invite?.inviteId ?? null),
      state,
      access,
      roles: roles.get(person.personId) ?? "",
      load: loads.get(person.personId) ?? "",
      places,
      detail: `${namesake === null ? "" : `${namesake} · `}${
        state === "you"
          ? "You"
          : state === "owner"
            ? KIN_ACCESS_LABELS.owner
            : state === "joined"
              ? `${access === "co_owner" ? "Co-owner" : kinLeadsLine(places) || "Joined"}${
                  invite === undefined
                    ? ""
                    : `. A link for another device hasn't been opened; it works until ${until}.`
                }`
              : invite === undefined
                ? "No access. Make a new link to let them back in."
                : `Hasn't opened the new link. It works until ${until}.`
      }`,
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
      access: "member",
      roles: "",
      load: "",
      places: null,
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

/**
 * The removed person a new teammate's name matches, as the host matches it (name, or the handle
 * the name makes): who "Bring back" makes a new link for, instead of a second person.
 */
export function kinRemovedNamesake(
  list: Pick<KinTeamList, "people" | "joined"> | null,
  name: string,
): KinPeopleListResult["people"][number] | null {
  const wanted = name.trim().toLowerCase();
  const handle = wanted.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const joined = new Set<string>(list?.joined ?? []);
  return (
    list?.people.find(
      (person) =>
        !joined.has(person.personId) &&
        person.access !== "owner" &&
        (person.displayName.trim().toLowerCase() === wanted || person.handle === handle),
    ) ?? null
  );
}

/** "@meera-2" when someone else in `people` has this person's name, so the two read apart. */
export function kinNamesakeHandle(
  people: ReadonlyArray<{
    readonly personId: string;
    readonly displayName: string;
    readonly handle: string;
  }>,
  person: { readonly personId: string; readonly displayName: string; readonly handle: string },
): string | null {
  const name = person.displayName.trim().toLowerCase();
  return people.some(
    (other) =>
      other.personId !== person.personId && other.displayName.trim().toLowerCase() === name,
  )
    ? `@${person.handle}`
    : null;
}

/** A picker row's second line: the handle of a namesake, then the reason it is not pickable. */
export const kinPickLine = (namesake: string | null, unpickable: string | null): string | null =>
  [namesake, unpickable].filter((part) => part !== null).join(" · ") || null;

/** The second line of the way in from the chat list. */
export function kinTeamEntrySummary(
  list: KinTeamList | null,
  ownerPersonId: string | null,
): string {
  if (list === null) return "The people who chat with you and your agents";
  const rows = kinTeamView(list, KIN_TEAM_NO_EDITS, ownerPersonId);
  const joined = rows.filter((row) => row.state === "joined" || row.state === "owner").length;
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

export const KIN_INVITE_LOCAL_ONLY_NOTE =
  "This link uses an address that only works on this device, so it won't open on anyone else's. Open Kin at the address your team can reach, then make the link there.";

/**
 * A link for another device or person: on the host's public address (`kin.access.me`
 * `publicUrl`) when it has one, else on the address this device reaches Kin at. `note` is said
 * beside it only when that final link opens nowhere but this machine.
 */
export function kinShareLink(
  address: { readonly publicUrl: string | undefined; readonly httpBaseUrl: string },
  secret: string,
): { readonly link: string; readonly note: string | null } {
  const link = kinInviteLink(address.publicUrl ?? address.httpBaseUrl, secret);
  return {
    link,
    note: kinIsLocalOnlyHost(new URL(link).hostname) ? KIN_INVITE_LOCAL_ONLY_NOTE : null,
  };
}

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
    detail: `${name} is signed out on every device and any unused link stops working. Their open tasks stay in their name and show under Needs you, for you to give to someone else; nothing moves on its own. A new link brings them back with the same role, projects, tasks and chats.`,
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

/**
 * What a teammate's details offer, by where they stand and who is looking: only the owner acts on
 * a co-owner, and nobody on the owner.
 */
export function kinTeammateActions(
  teammate: KinTeammate,
  viewer: KinPersonAccess = "owner",
): {
  /** The button that makes a link, and what it says underneath. */
  readonly link: { readonly label: string; readonly hint: string } | null;
  readonly cancel: ReturnType<typeof kinCancelInviteCopy> | null;
  readonly remove: boolean;
} {
  if (
    teammate.state === "you" ||
    teammate.state === "owner" ||
    (teammate.access === "co_owner" && viewer !== "owner")
  )
    return { link: null, cancel: null, remove: false };
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

/** The kinds the owner may give someone who has joined, and what each lets them do. */
export const KIN_ACCESS_CHOICES = [
  {
    access: "co_owner",
    label: KIN_ACCESS_LABELS.co_owner,
    detail: "Runs the company with you: Tasks, Money, Clients, Docs, agents and Settings.",
  },
  {
    access: "member",
    label: KIN_ACCESS_LABELS.member,
    detail: "Chats with anyone in the company unless you restrict it, and Tasks shared with them.",
  },
] as const satisfies ReadonlyArray<{
  readonly access: KinPeopleSetAccessInput["access"];
  readonly label: string;
  readonly detail: string;
}>;

/** What the owner is asked before changing someone's kind. */
export function kinAccessChangeCopy(
  name: string,
  access: KinPeopleSetAccessInput["access"],
): { readonly title: string; readonly detail: string; readonly confirm: string } {
  return access === "co_owner"
    ? {
        title: `Make ${name} a co-owner?`,
        detail: `${name} will see Tasks, Money, Clients, Docs and Settings, use every agent in their own chats with it, and confirm what you can. Only you can change who is a co-owner.`,
        confirm: "Make co-owner",
      }
    : {
        title: `Make ${name} a member?`,
        detail: `${name} goes back to chats and the tasks shared with them. Agent work they started stops now.`,
        confirm: "Make member",
      };
}

/** Whether the viewer may change this teammate's kind: the owner, for anyone but themself. */
export const kinTeammateKindEditable = (teammate: KinTeammate, viewer: KinPersonAccess) =>
  viewer === "owner" && teammate.personId !== null && teammate.access !== "owner";

/** The owner and co-owners message every agent in their own chats: no per-agent switch applies. */
export const kinTeammateAgentsLine = (teammate: KinTeammate): string | null =>
  kinOwnerLevel(teammate.access)
    ? `${teammate.name} can message every agent, each in their own chat.`
    : null;

const isChatError = Schema.is(KinChatError);

/** Why a team change didn't happen, in the owner's words. `doing` reads "make this link". */
function kinTeamProblem(error: unknown, doing: string): string {
  if (isChatError(error) && error.reason === "disabled") return "Kin is turned off on this server.";
  return kinFailureText(error, `Couldn't ${doing}.`, {
    refused: `Only the owner can ${doing}.`,
    gone: "That person or link is no longer here.",
    device: `This device isn't allowed to ${doing}.`,
  });
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
  readonly setAccess: (input: KinPeopleSetAccessInput) => Sent<unknown>;
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
      /** Someone else who shares a removed person's name, not them. */
      readonly newPerson?: true;
    }): Promise<
      | { readonly ok: true; readonly invite: KinMadeInvite }
      | { readonly ok: false; readonly problem: string; readonly bringBack?: true }
    > => {
      if (input.replaces !== null && !(await cancelInvite(input.replaces)))
        return { ok: false, problem: kinTeamProblem(null, "make this link") };
      const result = await options.createInvite({
        orgId,
        displayName: input.displayName,
        ...(input.personId === null ? {} : { personId: input.personId }),
        ...(input.newPerson === true ? { newPerson: true } : {}),
      });
      void options.refresh();
      if (AsyncResult.isSuccess(result)) {
        if (input.replaces !== null) {
          const replaced = input.replaces;
          update((edits) => ({ ...edits, cancelled: without(edits.cancelled, replaced) }));
        }
        return { ok: true, invite: { ...result.value, replaced: input.replaces !== null } };
      }
      const failure = squashAtomCommandFailure(result);
      // The host found a removed person by this name: its words offer to bring them back.
      if (input.personId === null && isChatError(failure) && failure.reason === "conflict")
        return { ok: false, problem: failure.message, bringBack: true };
      const problem = kinTeamProblem(failure, "make this link");
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
    /** Makes them a co-owner or a member. Shown once the host has read it back. */
    setAccess: async (
      personId: KinPersonId,
      access: KinPeopleSetAccessInput["access"],
    ): Promise<boolean> => {
      update((edits) => ({ ...edits, problem: null }));
      const result = await options.setAccess({ orgId, personId, access });
      const ok = AsyncResult.isSuccess(result);
      await options.refresh();
      if (!ok)
        update((edits) => ({
          ...edits,
          problem: kinTeamProblem(squashAtomCommandFailure(result), "change what they can do"),
        }));
      return ok;
    },
    dismissProblem: () => update((edits) => ({ ...edits, problem: null })),
  };
}

export type KinTeamActions = ReturnType<typeof createKinTeamActions>;

/** A teammate's page. */
export const KIN_TEAM_COPY = {
  canDo: "What they can do",
  canSee: "What they can see",
  sharedAlways: "Tasks shared with the team, always.",
} as const;

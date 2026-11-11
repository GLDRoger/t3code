import {
  EnvironmentAuthorizationError,
  KIN_GROUP_TITLE_MAX_LENGTH,
  KinChatError,
  type KinAgentId,
  type KinChatMembersResult,
  type KinMemberId,
  type KinPrincipal,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { kinAgentAvatar, type KinAvatarView } from "./kinScreenState.ts";

export const KIN_GROUP_NAME_MAX = KIN_GROUP_TITLE_MAX_LENGTH;

type GroupMember = KinChatMembersResult["members"][number];

/** A group's name as the host will store it, or what to fix. */
export function kinGroupNameCheck(
  name: string,
):
  | { readonly ok: true; readonly title: string }
  | { readonly ok: false; readonly problem: string } {
  const title = name.trim();
  if (title === "") return { ok: false, problem: "Give the group a name." };
  if (title.length > KIN_GROUP_NAME_MAX)
    return { ok: false, problem: `Keep the name under ${KIN_GROUP_NAME_MAX} characters.` };
  return { ok: true, title };
}

const isChatError = Schema.is(KinChatError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/** Why a group change didn't happen, in the owner's words. `doing` reads "rename this group". */
export function kinGroupProblem(error: unknown, doing: string): string {
  if (isAuthorizationError(error)) return `This device isn't allowed to ${doing}.`;
  if (!isChatError(error)) return `Couldn't ${doing}. Check your connection and try again.`;
  switch (error.reason) {
    case "not_allowed":
      return `Only the group's owner can ${doing}.`;
    case "not_found":
      return "That group, agent or person is no longer here.";
    case "limit":
      return "This group is full.";
    case "unavailable":
      return `Couldn't ${doing} right now. Try again in a moment.`;
    case "disabled":
      return "Kin is turned off on this server.";
    default:
      return error.message.length > 0 ? error.message : `Couldn't ${doing}.`;
  }
}

export interface KinGroupMemberView {
  readonly memberId: KinMemberId;
  readonly name: string;
  readonly kind: "owner" | "lead" | "person";
  /** "You", "Answers when no one is named", or nothing. */
  readonly detail: string | null;
  readonly avatar: KinAvatarView;
  readonly principal: KinPrincipal;
  /** The lead that answers a message naming no one. */
  readonly answers: boolean;
}

const avatarOf = (principal: KinPrincipal): KinAvatarView =>
  principal._tag === "agent"
    ? kinAgentAvatar(principal.agentId)
    : { kind: "person", seed: `person:${principal.personId}` };

/** A message author's avatar: the same face their chat row and details show. */
export const kinAuthorAvatar = (
  author:
    | { readonly _tag: "agent"; readonly agentId: string }
    | { readonly _tag: "human"; readonly personId: string },
): KinAvatarView =>
  author._tag === "agent"
    ? kinAgentAvatar(author.agentId)
    : { kind: "person", seed: `person:${author.personId}` };

/** The people and leads in a group, in the host's order: owner, leads, then people. */
export function kinGroupMemberViews(
  group: KinChatMembersResult,
  me: string | null,
): ReadonlyArray<KinGroupMemberView> {
  const rank = (member: GroupMember) =>
    member.principal._tag !== "agent"
      ? member.role === "owner"
        ? 0
        : 3
      : member.principal.agentId === group.chat.leadAgentId
        ? 1
        : 2;
  return (
    group.members
      .filter((member) => member.leftAt === null)
      // The lead that answers leads the leads; the host's order holds within each kind.
      .map((member, index) => ({ member, index }))
      .sort((a, b) => rank(a.member) - rank(b.member) || a.index - b.index)
      .map(({ member }): KinGroupMemberView => {
        const { principal } = member;
        const answers = principal._tag === "agent" && principal.agentId === group.chat.leadAgentId;
        const you = principal._tag === "person" && principal.personId === me;
        return {
          memberId: member.memberId,
          name: member.displayName,
          kind: principal._tag === "agent" ? "lead" : member.role === "owner" ? "owner" : "person",
          detail: answers
            ? "Answers when no one is named"
            : you
              ? "You"
              : member.role === "owner"
                ? "Owner"
                : null,
          avatar: avatarOf(principal),
          principal,
          answers,
        };
      })
  );
}

/** "4 members", for the line under a group's name. */
export const kinGroupCountLabel = (count: number) =>
  count === 1 ? "1 member" : `${count} members`;

/** People's names by member id, so a group's messages say who wrote them. */
export function kinMemberNames(
  members: ReadonlyArray<GroupMember> | null,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const member of members ?? []) names.set(member.memberId, member.displayName);
  return names;
}

// Mentions: `@Name` of a lead in the group asks that lead to answer.

export interface KinMentionCandidate {
  readonly memberId: KinMemberId;
  readonly agentId: KinAgentId;
  readonly name: string;
}

/** The leads a message in this group can name. */
export function kinMentionCandidates(
  members: ReadonlyArray<GroupMember> | null,
): ReadonlyArray<KinMentionCandidate> {
  return (members ?? []).flatMap((member) =>
    member.leftAt === null && member.principal._tag === "agent"
      ? [{ memberId: member.memberId, agentId: member.principal.agentId, name: member.displayName }]
      : [],
  );
}

const MENTION_QUERY_MAX = 40;
const startsMention = (text: string, at: number) => at === 0 || /[\s([{"']/.test(text[at - 1]!);

/**
 * The `@…` being typed at the cursor and the leads it could name; null when there is none.
 * Names hold spaces, so the query runs from the `@` to the cursor and must begin a name.
 */
export function kinMentionQuery(
  text: string,
  cursor: number,
  candidates: ReadonlyArray<KinMentionCandidate>,
): {
  readonly start: number;
  readonly matches: ReadonlyArray<KinMentionCandidate>;
} | null {
  if (candidates.length === 0) return null;
  const before = text.slice(0, cursor);
  const start = before.lastIndexOf("@");
  if (start === -1 || !startsMention(text, start)) return null;
  const query = before.slice(start + 1);
  if (query.length > MENTION_QUERY_MAX || query.includes("\n")) return null;
  const wanted = query.toLowerCase();
  const matches = candidates.filter((candidate) => {
    const name = candidate.name.toLowerCase();
    // Typed in full, there is nothing left to offer.
    if (name === wanted) return false;
    if (name.startsWith(wanted)) return true;
    return !wanted.includes(" ") && name.split(/\s+/).some((word) => word.startsWith(wanted));
  });
  return matches.length === 0 ? null : { start, matches };
}

/** The text with the `@…` at `start` replaced by the lead's name, and where the cursor lands. */
export function kinApplyMention(
  text: string,
  start: number,
  cursor: number,
  name: string,
): { readonly text: string; readonly cursor: number } {
  const inserted = `@${name} `;
  const rest = text.slice(cursor).replace(/^ /, "");
  return { text: text.slice(0, start) + inserted + rest, cursor: start + inserted.length };
}

/** The leads a message names, read from its text: `@Name`, whole, in any letter case. */
export function kinMentionsIn(
  text: string,
  candidates: ReadonlyArray<KinMentionCandidate>,
): ReadonlyArray<KinMemberId> {
  if (!text.includes("@")) return [];
  const lower = text.toLowerCase();
  const taken: Array<readonly [number, number]> = [];
  const named: KinMemberId[] = [];
  // Longest first, so "@Growth lead" never also names a lead called "Growth".
  // Copied and sorted by hand: Hermes has no `toSorted`.
  for (const candidate of [...candidates].sort((a, b) => b.name.length - a.name.length)) {
    const needle = `@${candidate.name.toLowerCase()}`;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      const whole = end === lower.length || !/[\p{L}\p{N}_]/u.test(lower[end]!);
      const free = taken.every(([from, to]) => end <= from || at >= to);
      if (!startsMention(text, at) || !whole || !free) continue;
      taken.push([at, end]);
      if (!named.includes(candidate.memberId)) named.push(candidate.memberId);
    }
  }
  return named;
}

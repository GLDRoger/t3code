import {
  kinWhenFormat,
  type KinAgentId,
  type KinPersonId,
  type KinReachListResult,
  type KinReachParty,
} from "@t3tools/contracts";

import { kinFailureText } from "./kinAnswers.ts";
import { KIN_TEAM_AGENT_COPY } from "./kinProfiles.ts";

/**
 * Everyone may message everyone, but the pairs an owner or co-owner restricted. What an agent's
 * page, a person's page and Settings, Team show of those pairs, from `kin.reach.list`.
 */
export interface KinReachInput {
  readonly reach: KinReachListResult;
  readonly people: ReadonlyArray<{ readonly personId: KinPersonId; readonly displayName: string }>;
  readonly agents: ReadonlyArray<{ readonly agentId: KinAgentId; readonly name: string }>;
}

export interface KinReachPerson {
  readonly personId: KinPersonId;
  readonly name: string;
  readonly party: KinReachParty;
}

const partyKey = (party: KinReachParty) =>
  party.kind === "person" ? `person:${party.personId}` : `agent:${party.agentId}`;

/** One key for a pair, whichever side comes first. */
export const kinReachPairKey = (a: KinReachParty, b: KinReachParty) =>
  [partyKey(a), partyKey(b)].sort().join("|");

const byName = (a: { readonly name: string }, b: { readonly name: string }) =>
  a.name.localeCompare(b.name);

const personOf = (input: KinReachInput, personId: KinPersonId): KinReachPerson => ({
  personId,
  name: input.people.find((one) => one.personId === personId)?.displayName ?? "Someone",
  party: { kind: "person", personId },
});

/** The other side of every live restriction on `party`. */
const restrictedWith = (input: KinReachInput, party: KinReachParty) => {
  const key = partyKey(party);
  return input.reach.limits.flatMap((limit) =>
    partyKey(limit.one) === key ? [limit.other] : partyKey(limit.other) === key ? [limit.one] : [],
  );
};

/**
 * An agent's "Who can message": the people who can, each of them also who "Restrict someone"
 * offers, and the restricted ones to lift. Owners and co-owners are never listed: they always can.
 */
export function kinAgentReach(input: KinReachInput, agentId: KinAgentId) {
  const agent: KinReachParty = { kind: "agent", agentId };
  const shut = new Set(
    restrictedWith(input, agent).flatMap((one) => (one.kind === "person" ? [one.personId] : [])),
  );
  const people = input.reach.restrictable.map((personId) => personOf(input, personId));
  return {
    canMessage: people.filter((one) => !shut.has(one.personId)).sort(byName),
    restricted: [...shut].map((personId) => personOf(input, personId)).sort(byName),
  };
}

/**
 * A person's page: each agent with whether they can message it, and the people they can't
 * message. Null for someone who can't be restricted: an owner, a co-owner, or no longer here.
 */
export function kinPersonReach(input: KinReachInput, personId: KinPersonId) {
  if (!input.reach.restrictable.includes(personId)) return null;
  const others = restrictedWith(input, { kind: "person", personId });
  const shutAgents = new Set(others.flatMap((one) => (one.kind === "agent" ? [one.agentId] : [])));
  const shutPeople = new Set(
    others.flatMap((one) => (one.kind === "person" ? [one.personId] : [])),
  );
  return {
    agents: input.agents.map((agent) => ({
      agentId: agent.agentId,
      name: agent.name,
      restricted: shutAgents.has(agent.agentId),
      party: { kind: "agent", agentId: agent.agentId } as const,
    })),
    cantMessage: [...shutPeople].map((one) => personOf(input, one)).sort(byName),
    offered: input.reach.restrictable
      .filter((one) => one !== personId && !shutPeople.has(one))
      .map((one) => personOf(input, one))
      .sort(byName),
  };
}

const dayFormat = kinWhenFormat("date");

/** Every live restriction in the company, as Settings, Team lists them: a person first. */
export function kinReachRows(input: KinReachInput) {
  const nameOf = (party: KinReachParty) =>
    party.kind === "person"
      ? personOf(input, party.personId).name
      : (input.agents.find((agent) => agent.agentId === party.agentId)?.name ?? "An agent");
  return input.reach.limits.map((limit) => {
    const [a, b] = limit.one.kind === "agent" ? [limit.other, limit.one] : [limit.one, limit.other];
    return {
      key: kinReachPairKey(a, b),
      a,
      b,
      names: [nameOf(a), nameOf(b)] as const,
      detail: `Restricted by ${personOf(input, limit.setBy).name} on ${dayFormat.format(Date.parse(limit.setAt))}`,
    };
  });
}

const listed = (names: ReadonlyArray<string>) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * What a restricted pair's shared groups still carry: posts there aren't filtered, but a group
 * wakes no agent for, and passes no request from, a person restricted from it. Null when they
 * share none, or the host is too old to say. The host knows a pair's groups only once restricted.
 */
export function kinReachShared(
  input: KinReachInput,
  a: KinReachParty,
  b: KinReachParty,
): string | null {
  const key = kinReachPairKey(a, b);
  const limit = input.reach.limits.find((one) => kinReachPairKey(one.one, one.other) === key);
  if (limit?.groups === undefined || limit.groups.length === 0) return null;
  const row = kinReachRows({ ...input, reach: { ...input.reach, limits: [limit] } })[0]!;
  const [first, second] = row.names;
  const where = `In ${listed(limit.groups)}, ${first} and ${second} still see each other's messages`;
  return row.b.kind === "agent"
    ? `${where}, but none of ${first}'s requests there reach ${second}.`
    : `${where}.`;
}

/** Why a restriction or a lift didn't happen, in the owner's words. */
export function kinReachProblem(error: unknown): string {
  const reason =
    typeof error === "object" && error !== null && "reason" in error ? error.reason : null;
  switch (reason) {
    case "not_owner":
    case "not_allowed":
      return "Only the owner or a co-owner can restrict who messages whom.";
    case "conflict":
      return "Owners and co-owners can always message everyone.";
    case "not_found":
      return "That person or agent is no longer here.";
    default:
      return kinFailureText(error, "Couldn't change that.");
  }
}

export const KIN_REACH_COPY = {
  title: "Who can message",
  /** An agent page's opening line, true over a non-empty Restricted list too. */
  agentBody: (agent: string, anyRestricted: boolean) =>
    anyRestricted
      ? `Everyone in the company can message ${agent}, except the people under Restricted.`
      : `Everyone in the company can message ${agent}.`,
  restricted: "Restricted",
  canMessage: "Can message",
  lift: "Lift",
  restrict: "Restrict",
  restrictSomeone: "Restrict someone",
  restrictWith: "Restrict messaging with…",
  cantMessage: "Can't message",
  confirmTitle: (a: string, b: string) => `Restrict ${a} and ${b}?`,
  /** `b` is an agent: the person keeps their chat with it, to read. */
  confirmAgent: (person: string, agent: string) =>
    `Neither can message the other until you lift this. ${person} keeps their chat with ${agent} to read.`,
  confirmPeople: (a: string, b: string) =>
    `Neither can message the other until you lift this. ${a} and ${b} keep their chat to read.`,
  done: (a: string, b: string) => `${a} and ${b} can't message each other now.`,
  lifted: (a: string, b: string) => `${a} and ${b} can message each other again.`,
  everyone: (person: string) => `${person} can message everyone on the team.`,
  ownerLevel: (person: string) =>
    `${person} can message everyone, as an owner or co-owner. That can't be restricted.`,
  notJoined: (person: string) =>
    `Once ${person} joins, they can message every agent unless you restrict one here.`,
  allBody: "Everyone can message everyone, except these pairs.",
  allNone:
    "Nobody is restricted: everyone can message everyone. To restrict a pair, open a person above or an agent under Agents.",
  loadFailed: "Couldn't load who can message whom.",
} as const;

/** The Team page's line for the team agent: "everyone" only while nobody is restricted from it. */
export function kinTeamAgentDetail(
  reach: KinReachListResult | null,
  teamAgentId: KinAgentId | null,
): string {
  const restricted =
    reach !== null &&
    teamAgentId !== null &&
    restrictedWith({ reach, people: [], agents: [] }, { kind: "agent", agentId: teamAgentId })
      .length > 0;
  return restricted ? KIN_TEAM_AGENT_COPY.detailRestricted : KIN_TEAM_AGENT_COPY.detail;
}

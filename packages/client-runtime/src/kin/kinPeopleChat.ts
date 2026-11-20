import {
  kinIsPeopleChat,
  type KinAgentId,
  type KinChatSummary,
  type KinLeadsListResult,
  type KinPersonId,
} from "@t3tools/contracts";

import { KIN_CHECK_CONNECTION, kinFailureText } from "./kinAnswers.ts";
import { kinLeadOwnerSeesLine } from "./kinLeadPresentation.ts";

/**
 * A chat between two people. Anyone starts one with anyone on the team, and starting it again
 * opens the same one. The host lets only those two read it: not the owner, not a co-owner.
 */
export const KIN_PEOPLE_CHAT = {
  message: "Message",
  newChat: "Message someone",
  pickTitle: "Message someone",
  pickDetail: "A chat between the two of you. Only you and they can read it.",
  people: "People",
  agents: "Agents",
  noOne: "Nobody else is on the team yet.",
  noOneDetail: "The owner or a co-owner adds teammates from Settings.",
  loadFailed: KIN_CHECK_CONNECTION,
  /** At the chat's top, beside the other person's name: the host's rule, not a promise of ours. */
  privacy: "Only you two can read this.",
};

/** Why a teammate's chat didn't open, in Kin's words for each kind of failure. */
export const kinPeopleChatProblem = (error: unknown) =>
  kinFailureText(error, "Couldn't open that chat.", {
    refused: "You can't message this person.",
    gone: "That person is no longer on the team.",
  });

/** The other person in a chat between two people; null for any other chat. */
export function kinPeopleChatWith(
  chat: Pick<KinChatSummary, "kind" | "teamId" | "members">,
  me: ReadonlySet<string>,
): KinPersonId | null {
  if (!kinIsPeopleChat(chat)) return null;
  for (const member of chat.members)
    if (member.principal._tag === "person" && !me.has(member.principal.personId))
      return member.principal.personId;
  return null;
}

/** Why an agent's chat didn't open, in Kin's words for each kind of failure. */
export const kinAgentChatProblem = (error: unknown) =>
  kinFailureText(error, "Couldn't open that chat.", {
    refused: "You can't message this agent.",
    gone: "That agent is no longer here.",
  });

/** Who the viewer can start a chat with: everyone else on the team, by name. */
export function kinMessageablePeople<
  P extends { readonly personId: KinPersonId; readonly displayName: string },
>(people: ReadonlyArray<P>, me: KinPersonId | null): ReadonlyArray<P> {
  return people
    .filter((person) => person.personId !== me)
    .sort((one, other) => one.displayName.localeCompare(other.displayName));
}

/** An agent in the new-chat list: its name, and what teammates see about it when its owner wrote it. */
export interface KinNewChatAgent {
  readonly agentId: KinAgentId;
  readonly name: string;
  readonly intro: string | null;
}

export type KinNewChatLeads = {
  readonly leads: ReadonlyArray<
    Pick<KinLeadsListResult["leads"][number], "agentId" | "name"> & { readonly retired?: unknown }
  >;
  readonly contacts?:
    | ReadonlyArray<
        Pick<
          NonNullable<KinLeadsListResult["contacts"]>[number],
          "agentId" | "name" | "intro" | "ownerName"
        >
      >
    | undefined;
  readonly messageable?: KinLeadsListResult["messageable"];
};

/**
 * The agents a new chat lists: every one the host says the viewer may message, or on an older host
 * their own live agents and the agents they already have a chat with.
 */
function kinListedAgents(leads: KinNewChatLeads | null) {
  if (leads === null) return [];
  const own = new Set(leads.leads.map((lead) => lead.agentId));
  return (
    leads.messageable ?? [
      ...leads.leads
        .filter((lead) => lead.retired === undefined)
        .map((lead) => ({ ...lead, intro: "", ownerName: undefined })),
      ...(leads.contacts ?? []).filter((contact) => !own.has(contact.agentId)),
    ]
  );
}

/** Every agent the viewer may message, in the new-chat list's order and rows. */
export function kinMessageableAgents(
  leads: KinNewChatLeads | null,
): ReadonlyArray<KinNewChatAgent> {
  return kinListedAgents(leads).map(kinNewChatAgent);
}

const kinNewChatAgent = (agent: {
  readonly agentId: KinAgentId;
  readonly name: string;
  readonly intro: string;
}): KinNewChatAgent => ({
  agentId: agent.agentId,
  name: agent.name,
  intro: agent.intro.trim() === "" ? null : agent.intro.trim(),
});

/**
 * Everyone the viewer can start a chat with: people first, then every agent they may message.
 * Each kind is headed only when both show. `agentsNote` says who else reads a chat with an agent
 * that isn't the viewer's own.
 */
export function kinNewChatList<
  P extends { readonly personId: KinPersonId; readonly displayName: string },
>(people: ReadonlyArray<P>, me: KinPersonId | null, leads: KinNewChatLeads | null) {
  const persons = kinMessageablePeople(people, me);
  const own = new Set((leads?.leads ?? []).map((lead) => lead.agentId));
  const listed = kinListedAgents(leads);
  const agents = listed.map(kinNewChatAgent);
  const owners = new Set(
    listed.filter((agent) => !own.has(agent.agentId)).map((agent) => agent.ownerName),
  );
  const [owner] = owners;
  const headed = persons.length > 0 && agents.length > 0;
  return {
    people: persons,
    agents,
    peopleTitle: headed ? KIN_PEOPLE_CHAT.people : null,
    agentsTitle: headed ? KIN_PEOPLE_CHAT.agents : null,
    agentsNote:
      owners.size === 0 ? null : kinLeadOwnerSeesLine(owners.size === 1 ? owner : undefined),
  };
}

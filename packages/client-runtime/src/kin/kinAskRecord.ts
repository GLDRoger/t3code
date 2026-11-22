import type { KinAgentId, KinChatId, KinLeadContact, KinLeadsListResult } from "@t3tools/contracts";

import { kinMessageableAgents } from "./kinPeopleChat.ts";

export const KIN_ASK_RECORD = {
  askWho: "Ask an agent",
  ask: (name: string) => `Ask ${name}`,
} as const;

/** An agent the viewer can message, and their chat with it when they have one already. */
export interface KinAskAgent {
  readonly agentId: KinAgentId;
  readonly name: string;
  readonly chatId: KinChatId | null;
}

/**
 * Who an Ask can go to: every agent the new-chat list offers the viewer, in its order. A chat the
 * viewer already has with one is opened as it is; for any other, the chat is made on the pick.
 */
export function kinAskAgents(
  result: {
    readonly leads: ReadonlyArray<
      Pick<KinLeadsListResult["leads"][number], "agentId" | "name" | "ownerChatId"> & {
        readonly retired?: unknown;
      }
    >;
    readonly contacts?:
      | ReadonlyArray<Pick<KinLeadContact, "agentId" | "name" | "intro" | "ownerName" | "chatId">>
      | undefined;
    readonly messageable?: KinLeadsListResult["messageable"];
  } | null,
): ReadonlyArray<KinAskAgent> {
  if (result === null) return [];
  const chats = new Map<string, KinChatId>([
    ...(result.contacts ?? []).map((contact) => [contact.agentId, contact.chatId] as const),
    ...result.leads.map((lead) => [lead.agentId, lead.ownerChatId] as const),
  ]);
  return kinMessageableAgents(result).map(({ agentId, name }) => ({
    agentId,
    name,
    chatId: chats.get(agentId) ?? null,
  }));
}

/**
 * An entry as an Ask names it to an agent: an issued invoice's or quote's number, as the person
 * sees it, then the key the agent's tools take, "INV/26-27/004 (INV-1)"; else the key alone.
 */
export function kinAskName(key: string, number: unknown) {
  return typeof number === "string" && number.trim() !== "" ? `${number.trim()} (${key})` : key;
}

/**
 * What an Ask about an entry starts with in the agent's composer: its name for the agent, and its
 * title, so the person sees what they are asking about. A numbered name already ends in the
 * bracketed key, so its title follows bare, as Needs attention's Ask has it.
 */
export function kinAskRecordDraft(record: {
  readonly key: string;
  readonly title: string;
  readonly number?: unknown;
}) {
  const name = kinAskName(record.key, record.number);
  const title = record.title.trim();
  if (title === "") return `About ${name}: `;
  return name === record.key ? `About ${name} (${title}): ` : `About ${name} ${title}: `;
}

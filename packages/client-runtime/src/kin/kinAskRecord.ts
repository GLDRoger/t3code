import type { KinAgentId, KinChatId } from "@t3tools/contracts";

import { kinMessageableAgents, type KinNewChatLeads } from "./kinPeopleChat.ts";

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
  result:
    | (KinNewChatLeads & {
        readonly leads: ReadonlyArray<{
          readonly agentId: KinAgentId;
          readonly ownerChatId: KinChatId;
        }>;
        readonly contacts?:
          | ReadonlyArray<{ readonly agentId: KinAgentId; readonly chatId: KinChatId }>
          | undefined;
      })
    | null,
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
 * What an Ask about a task or a project starts with in the agent's composer: its key, which the
 * agent looks it up by, and its name, so the person sees what they are asking about.
 */
export function kinAskRecordDraft(record: { readonly key: string; readonly title: string }) {
  const title = record.title.trim();
  return title === "" ? `About ${record.key}: ` : `About ${record.key} (${title}): `;
}

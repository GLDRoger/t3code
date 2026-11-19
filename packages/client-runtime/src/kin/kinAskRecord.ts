import type { KinChatId } from "@t3tools/contracts";

export const KIN_ASK_RECORD = {
  askWho: "Ask an agent",
  ask: (name: string) => `Ask ${name}`,
} as const;

/** An agent the viewer can message, and the viewer's own chat with it. */
export interface KinAskAgent {
  readonly agentId: string;
  readonly name: string;
  readonly chatId: KinChatId;
}

/**
 * Who an Ask can go to: the viewer's own live agents, then the teammates' agents they may message,
 * each in the viewer's own chat with it.
 */
export function kinAskAgents(
  result: {
    readonly leads: ReadonlyArray<{
      readonly agentId: string;
      readonly name: string;
      readonly ownerChatId: KinChatId;
      readonly retired?: unknown;
    }>;
    readonly contacts?: ReadonlyArray<KinAskAgent> | undefined;
  } | null,
): ReadonlyArray<KinAskAgent> {
  if (result === null) return [];
  const own = result.leads
    .filter((lead) => lead.retired === undefined)
    .map((lead) => ({ agentId: lead.agentId, name: lead.name, chatId: lead.ownerChatId }));
  const seen = new Set(own.map((agent) => agent.agentId));
  const others = (result.contacts ?? [])
    .filter((contact) => !seen.has(contact.agentId))
    .map((contact) => ({ agentId: contact.agentId, name: contact.name, chatId: contact.chatId }));
  return [...own, ...others];
}

/**
 * What an Ask about a task or a project starts with in the agent's composer: its key, which the
 * agent looks it up by, and its name, so the person sees what they are asking about.
 */
export function kinAskRecordDraft(record: { readonly key: string; readonly title: string }) {
  const title = record.title.trim();
  return title === "" ? `About ${record.key}: ` : `About ${record.key} (${title}): `;
}

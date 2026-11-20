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
 * An entry as an Ask names it to an agent: an issued invoice's or quote's number, as the person
 * sees it, then the key the agent's tools take, "INV/26-27/004 (INV-1)"; else the key alone.
 */
export function kinAskName(key: string, number: unknown) {
  return typeof number === "string" && number.trim() !== "" ? `${number.trim()} (${key})` : key;
}

/**
 * What an Ask about an entry starts with in the agent's composer: its name for the agent, and its
 * title, so the person sees what they are asking about.
 */
export function kinAskRecordDraft(record: {
  readonly key: string;
  readonly title: string;
  readonly number?: unknown;
}) {
  const name = kinAskName(record.key, record.number);
  const title = record.title.trim();
  return title === "" ? `About ${name}: ` : `About ${name} (${title}): `;
}

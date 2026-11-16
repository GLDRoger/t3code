import type { KinAgentPage, KinPersonAccess } from "@t3tools/contracts";

/**
 * What a viewer may do on an agent's page. The owner and co-owners see and change all of it; a
 * project lead or a member gets the short card (name, what it does, how to reach it) and nothing
 * the owner keeps private: its model, character, access or spend. The host refuses the rest anyway.
 */
export interface KinAgentPageCan {
  readonly card: "full" | "short";
  readonly edit: boolean;
  readonly model: boolean;
  readonly character: boolean;
  readonly access: boolean;
  readonly pause: boolean;
  readonly remove: boolean;
}

const SHORT: KinAgentPageCan = {
  card: "short",
  edit: false,
  model: false,
  character: false,
  access: false,
  pause: false,
  remove: false,
};

export function kinAgentPageCan(viewer: {
  readonly access: KinPersonAccess | null;
  /** Leads a project. Leading one gives no say over agents. */
  readonly leadsAProject?: boolean;
}): KinAgentPageCan {
  if (viewer.access !== "owner" && viewer.access !== "co_owner") return SHORT;
  return {
    card: "full",
    edit: true,
    model: true,
    character: true,
    access: true,
    pause: true,
    remove: true,
  };
}

export const KIN_AGENT_PAGE = {
  model: "Model",
  modelDetail:
    "It thinks with the first for anything you or a teammate ask it directly, check-ins and decisions, and the second for quick checks. A change applies from its next reply.",
  strong: "For harder work",
  cheap: "For quick replies",
  defaults: "New agents run on",
  defaultsDetail: "Agents you add from now on start on these. You can change each one on its page.",
  character: "Character",
  characterRule:
    "A character changes how it sounds and what it cares about. It never changes what it may do or see.",
  characterEmpty: "Kin gives it a character on its next start.",
  editCharacter: "Edit",
  characterHistory: "History",
  rewrite: "Ask it to rewrite itself",
  checkIns: "Check-ins",
  checkInsNone: "It speaks when spoken to: no check-ins.",
  reach: "What it can reach",
  reachNone: "No outside accounts are connected.",
  reachDetail: "Every agent uses the same connections, only in your own chats with it.",
  playbooks: "Playbooks it follows",
  playbooksNone: "No playbooks yet.",
  activity: "In hand",
  pause: "Pause",
  resume: "Resume",
  pausedLine: (name: string) =>
    `${name} is paused. Messages to it wait until you resume it; nothing else wakes it.`,
  pauseDetail: "Pausing lets a reply under way finish. Messages wait until you resume it.",
  teamAgent: "Team agent",
  teamAgentDetail: "Everyone on the team can message it, and it answers in the company chat.",
  writeForMe: "Write one for me",
  writeForMeDetail: "After you create it, the Chief of staff drafts its character with you.",
  characterField: "Character",
  characterPlaceholder:
    "Who it is: an archetype, what it loves, what it pushes back on, how it writes.",
} as const;

/** "Sonnet 4.6, high effort" from a model's name and the effort it was saved with. */
export function kinAgentModelLine(
  name: string,
  selection: { readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }> },
): string {
  const effort = selection.options?.find((option) => option.id === "effort")?.value;
  return typeof effort === "string" && effort !== "default" ? `${name}, ${effort} effort` : name;
}

/** This month's use in a line: replies and a rounded token count, or that it hasn't run. */
export function kinAgentUsageLine(used: KinAgentPage["usedThisMonth"]): string {
  if (used.turns === 0) return "No replies yet this month.";
  const replies = `${used.turns} ${used.turns === 1 ? "reply" : "replies"} this month`;
  if (used.tokens === 0) return `${replies}.`;
  const tokens =
    used.tokens >= 1_000_000
      ? `${(used.tokens / 1_000_000).toFixed(1)}M`
      : used.tokens >= 1_000
        ? `${Math.round(used.tokens / 1_000)}k`
        : String(used.tokens);
  return `${replies}, about ${tokens} tokens.`;
}

/** When its unprompted messages wait: the company's quiet hours. */
export function kinAgentQuietLine(hours: KinAgentPage["quietHours"]): string {
  return `Quiet hours ${hours.from}–${hours.to}: anything it would send unprompted waits until they end.`;
}

/** The line put in its chat when the owner asks it to rewrite its own character. */
export function kinAgentRewriteStarter(name: string): string {
  return `${name}, rewrite your character with me. Offer a sharper one in a few lines (an archetype, what you love, what you push back on, how you write) and save it when I agree.`;
}

/** The line put in the Chief of staff's chat to draft a new agent's character. */
export function kinAgentWriteCharacterStarter(name: string, area: string): string {
  return `Write a character for ${name}, our new ${area} agent: an archetype, its biases and favourites, and how it talks. Show me a draft and save it to its character doc when I agree.`;
}

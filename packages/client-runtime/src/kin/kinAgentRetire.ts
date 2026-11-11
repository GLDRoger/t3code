import type {
  KinChatSummary,
  KinLeadProfile,
  KinMessage,
  KinOrgsListResult,
} from "@t3tools/contracts";

export const KIN_RETIRE_ACTION = "Retire agent";
export const KIN_RESTORE_ACTION = "Restore";
export const KIN_RETIRED_LABEL = "Retired";

/** The agents the host marks retired: their names still resolve, and nothing new reaches them. */
export function kinRetiredAgentIds(
  orgs: KinOrgsListResult | null,
  orgId?: string | null,
): ReadonlySet<string> {
  const retired = new Set<string>();
  for (const org of orgs?.orgs ?? []) {
    if (orgId != null && org.orgId !== orgId) continue;
    for (const agent of org.agents) if (agent.retired) retired.add(agent.agentId);
  }
  return retired;
}

/** The owner's agents as the list shows them: the ones at work, then the retired ones. */
export function kinAgentGroups(leads: ReadonlyArray<KinLeadProfile>): {
  readonly active: ReadonlyArray<KinLeadProfile>;
  readonly retired: ReadonlyArray<KinLeadProfile>;
} {
  return {
    active: leads.filter((lead) => lead.retired === undefined),
    retired: leads.filter((lead) => lead.retired !== undefined),
  };
}

/** Said in place of Retire on the owner's only active agent: the host keeps one. */
function kinRetireOnlyAgentLine(name: string): string {
  return `${name} is your only active agent, so it can't be retired. Add another agent first.`;
}

/** Whether Retire is offered on this agent, and what to say when it isn't. */
export function kinRetireOffer(
  lead: Pick<KinLeadProfile, "name">,
  activeCount: number,
): { readonly offered: true } | { readonly offered: false; readonly why: string } {
  return activeCount > 1
    ? { offered: true }
    : { offered: false, why: kinRetireOnlyAgentLine(lead.name) };
}

/** The one confirmation before an agent is retired: what stops, what is kept, and the way back. */
export function kinRetireCopy(name: string): {
  readonly title: string;
  readonly detail: string;
  readonly confirm: string;
} {
  return {
    title: `Retire ${name}?`,
    detail: `${name} stops what it's doing now, including any coding work it started, and anything it asked you to approve is cancelled. Its reminders and scheduled tasks are put on hold. Its chats, what it remembers and the tasks it has are kept, and you can restore it any time.`,
    confirm: KIN_RETIRE_ACTION,
  };
}

/** What restoring does, said beside Restore and before a restore from a list. */
export function kinRestoreCopy(name: string): {
  readonly title: string;
  readonly detail: string;
  readonly confirm: string;
} {
  return {
    title: `Restore ${name}?`,
    detail: `${name} comes back to its chats, and its reminders and scheduled tasks start again. Work that was stopped and approvals that were cancelled don't come back.`,
    confirm: KIN_RESTORE_ACTION,
  };
}

const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dayYearFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const yearFormat = new Intl.DateTimeFormat(undefined, { year: "numeric" });

/** "Retired today", "Retired 11 Nov", "Retired 11 Nov 2025". */
export function kinRetiredWhen(at: string | undefined, nowMs: number): string {
  const when = at === undefined ? Number.NaN : Date.parse(at);
  if (Number.isNaN(when)) return KIN_RETIRED_LABEL;
  if (dayYearFormat.format(when) === dayYearFormat.format(nowMs)) return "Retired today";
  const sameYear = yearFormat.format(when) === yearFormat.format(nowMs);
  return `Retired ${(sameYear ? dayFormat : dayYearFormat).format(when)}`;
}

const reasonOf = (error: unknown) =>
  typeof error === "object" && error !== null && "reason" in error ? error.reason : null;

/** Why retiring was refused, in the owner's terms. The host's own message never reaches the screen. */
export function kinRetireProblem(error: unknown, name: string): string {
  switch (reasonOf(error)) {
    // The host refuses a retire as `invalid_state` only to keep the owner one active agent.
    case "invalid_state":
      return kinRetireOnlyAgentLine(name);
    case "not_allowed":
      return "Only the person who set up this agent can retire it.";
    case "not_found":
      return "This agent is no longer here.";
    case "unavailable":
    case "disabled":
      return "Agents aren't running on this server right now. Try again in a moment.";
    default:
      return `Couldn't retire ${name}. Check your connection and try again.`;
  }
}

/** Why restoring was refused, in the owner's terms. */
export function kinRestoreProblem(error: unknown, name: string): string {
  switch (reasonOf(error)) {
    case "conflict":
      return "An active agent already uses this name. Rename one first.";
    case "not_allowed":
      return "Only the person who set up this agent can restore it.";
    case "not_found":
      return "This agent is no longer here.";
    case "unavailable":
    case "disabled":
      return "Agents aren't running on this server right now. Try again in a moment.";
    default:
      return `Couldn't restore ${name}. Check your connection and try again.`;
  }
}

/** A direct chat's agent when it is retired; null for a group or an agent still at work. */
export function kinRetiredDirectAgentId(
  chat: Pick<KinChatSummary, "kind" | "members"> | undefined,
  retired: ReadonlySet<string>,
): string | null {
  if (chat === undefined || chat.kind !== "direct" || retired.size === 0) return null;
  for (const member of chat.members) {
    if (member.leftAt !== null || member.principal._tag !== "agent") continue;
    if (retired.has(member.principal.agentId)) return member.principal.agentId;
  }
  return null;
}

/** The one line where the composer was, in a retired agent's chat. */
export function kinRetiredChatLine(name: string | null, canRestore: boolean): string {
  const who = name ?? "This agent";
  return canRestore
    ? `${who} is retired, so it won't see new messages. Restore it to pick up where you left off.`
    : `${who} has been retired, so it won't see new messages.`;
}

/** What a retired agent's chat says when nothing was ever written in it. */
export function kinRetiredEmptyChat(name: string): {
  readonly title: string;
  readonly detail: string;
} {
  return {
    title: "No messages",
    detail: `Nothing was said in this chat before ${name} was retired.`,
  };
}

/** Said in a group whose answering agent is retired: nobody answers until another is picked. */
export function kinRetiredGroupLine(name: string, canChoose: boolean): string {
  const said = `${name} is retired, so messages that name no one go unanswered.`;
  return canChoose ? `${said} Choose who answers in the group's details.` : said;
}

/** A group's answering agent by name when it is retired; null while it still answers. */
export function kinRetiredGroupAnswerer(
  group: {
    readonly chat: { readonly leadAgentId?: string | null | undefined };
    readonly members: ReadonlyArray<{
      readonly leftAt: string | null;
      readonly displayName: string;
      readonly principal:
        | { readonly _tag: "agent"; readonly agentId: string }
        | { readonly _tag: "person" };
    }>;
  } | null,
  retired: ReadonlySet<string> | undefined,
): string | null {
  const agentId = group?.chat.leadAgentId;
  if (group == null || agentId == null || retired?.has(agentId) !== true) return null;
  const member = group.members.find(
    (held) =>
      held.leftAt === null && held.principal._tag === "agent" && held.principal.agentId === agentId,
  );
  return member?.displayName ?? null;
}

/** The retired agent a message's card belongs to, by name; null while its agent is at work. */
export function kinHeldCardAgent(
  author: KinMessage["author"],
  viewer: {
    readonly agentNames: ReadonlyMap<string, string>;
    readonly retiredAgents?: ReadonlySet<string>;
  },
  /** The chat's own agent when it is a retired agent's direct chat: Kin's cards there are its. */
  directRetired: string | null,
): string | null {
  if (author._tag !== "agent") return directRetired;
  return viewer.retiredAgents?.has(author.agentId) === true
    ? (viewer.agentNames.get(author.agentId) ?? "this agent")
    : null;
}

/** Said on a reminder or scheduled task of a retired agent, in place of when it next runs. */
export function kinHeldLine(name: string): string {
  return `On hold while ${name} is retired.`;
}

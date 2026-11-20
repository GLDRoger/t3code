// @effect-diagnostics globalDate:off - Pure view helpers word due days for React render, outside an Effect runtime.
import { kinNow } from "./kinNow.ts";
import type {
  KinAgentId,
  KinChatSummary,
  KinLeadAccessResult,
  KinLeadProfile,
  KinLeadTracking,
  KinPerson,
  ModelSelection,
  ServerProviderModel,
} from "@t3tools/contracts";
import { KIN_PROVIDER_FACTS, kinCantDo, kinProviderFacts } from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";

import { formatKinDeferralTime } from "./kinDeferralPresentation.ts";
import { type KinWorkNames, kinWorkDueText, kinWorkStatusText } from "./kinWork.ts";
import { kinFailureText } from "./kinAnswers.ts";

export const KIN_LEAD_NAME_MAX = 80;
export const KIN_LEAD_CHARTER_MAX = 1_000;
export const KIN_LEAD_INTRO_MAX = 200;
const DOMAIN_MAX = 40;

/** A domain slug as people read it: `chief-of-staff` is "Chief of staff". */
export function kinDomainLabel(domain: string): string {
  const words = domain.replaceAll("-", " ").trim();
  return words === "" ? "" : `${words[0]!.toUpperCase()}${words.slice(1)}`;
}

/** What the owner typed as the host's slug; null when nothing in it can start one. */
export function kinDomainSlug(text: string): string | null {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, DOMAIN_MAX)
    .replace(/-+$/, "");
  return slug === "" ? null : slug;
}

export interface KinLeadDraft {
  readonly name: string;
  /** As typed, such as "Chief of staff". */
  readonly area: string;
  readonly charter: string;
  /** What teammates see: the only words about the lead that people it talks to can read. */
  readonly intro: string;
}

type KinLeadFields = Pick<KinLeadProfile, "name" | "domain" | "charter" | "intro">;

export function kinLeadDraftOf(profile: KinLeadFields): KinLeadDraft {
  return {
    name: profile.name,
    area: kinDomainLabel(profile.domain),
    charter: profile.charter,
    intro: profile.intro ?? "",
  };
}

export type KinLeadDraftCheck =
  | {
      readonly ok: true;
      readonly name: string;
      readonly domain: string;
      readonly charter: string;
      readonly intro: string;
    }
  | { readonly ok: false; readonly field: keyof KinLeadDraft; readonly problem: string };

/** The draft as the host takes it, or the first thing to fix. */
export function kinLeadDraftCheck(draft: KinLeadDraft): KinLeadDraftCheck {
  const name = draft.name.trim();
  if (name === "") return { ok: false, field: "name", problem: "Give the agent a name." };
  if (name.length > KIN_LEAD_NAME_MAX) {
    return {
      ok: false,
      field: "name",
      problem: `Keep the name under ${KIN_LEAD_NAME_MAX} characters.`,
    };
  }
  // A lead is usually named after what it looks after, so a blank area takes the name.
  const typedArea = draft.area.trim() !== "";
  const domain = kinDomainSlug(typedArea ? draft.area : name);
  if (domain === null) {
    return {
      ok: false,
      field: "area",
      problem: typedArea
        ? "Start the area with a letter, such as growth or hiring."
        : "Say which area it looks after, such as growth or hiring.",
    };
  }
  const charter = draft.charter.trim();
  if (charter.length > KIN_LEAD_CHARTER_MAX) {
    return {
      ok: false,
      field: "charter",
      problem: `Keep this under ${KIN_LEAD_CHARTER_MAX} characters.`,
    };
  }
  const intro = draft.intro.trim();
  if (intro.length > KIN_LEAD_INTRO_MAX) {
    return {
      ok: false,
      field: "intro",
      problem: `Keep this under ${KIN_LEAD_INTRO_MAX} characters.`,
    };
  }
  return { ok: true, name, domain, charter, intro };
}

/** Only what changed, for `kin.lead.update`; null when the draft matches the lead. */
export function kinLeadChanges(
  profile: KinLeadFields,
  checked: Extract<KinLeadDraftCheck, { readonly ok: true }>,
): {
  readonly name?: string;
  readonly domain?: string;
  readonly charter?: string;
  readonly intro?: string;
} | null {
  const changes = {
    ...(checked.name === profile.name ? undefined : { name: checked.name }),
    ...(checked.domain === profile.domain ? undefined : { domain: checked.domain }),
    ...(checked.charter === profile.charter ? undefined : { charter: checked.charter }),
    ...(checked.intro === (profile.intro ?? "") ? undefined : { intro: checked.intro }),
  };
  return Object.keys(changes).length === 0 ? null : changes;
}

const TRACKING_KINDS: Record<KinLeadTracking["kind"], string> = {
  work: "Working on it now",
  reminder: "Reminder",
  follow_up: "Follow-up",
  scheduled: "Repeats",
};

/**
 * The second line under something a lead has in hand: "Reminder, Fri 13 Nov, 9:00". A waiting task
 * says so as the Tasks list does ("Waiting on you, due tomorrow").
 */
export function kinLeadTrackingDetail(
  item: Pick<KinLeadTracking, "kind" | "dueAt" | "dueAllDay" | "state" | "waitingOn">,
  timeZone?: string,
  now: Date = kinNow(),
  names: KinWorkNames | null = null,
): string {
  const kind =
    item.kind === "work" && item.state === "waiting"
      ? kinWorkStatusText({ state: item.state, waitingOn: item.waitingOn ?? null }, names)
      : TRACKING_KINDS[item.kind];
  const due = item.dueAt === undefined ? Number.NaN : Date.parse(item.dueAt);
  if (Number.isNaN(due)) return kind;
  // A due day has no time: the day where the owner is, as Tasks says it.
  if (item.dueAllDay === true && item.dueAt !== undefined)
    return `${kind}, due ${kinWorkDueText({ dueAt: item.dueAt, dueAllDay: true }, { zone: timeZone ?? null }, now)}`;
  return `${kind}, ${formatKinDeferralTime(due, timeZone)}`;
}

/**
 * The lead's model as T3's model picker names it: the name its provider lists, else the id
 * read the way the picker reads one it has no name for.
 */
export function kinLeadModelName(model: string, providers: KinModelProviders): string {
  return kinListedModelName(model, providers) ?? formatModelSlugName(model);
}

type KinModelProviders =
  | ReadonlyArray<{
      readonly models: ReadonlyArray<Pick<ServerProviderModel, "slug" | "name" | "aliases">>;
    }>
  | null
  | undefined;

/** The name a provider lists for a model, as Settings shows it; null where none lists it. */
export function kinListedModelName(model: string, providers: KinModelProviders): string | null {
  for (const provider of providers ?? []) {
    const listed = provider.models.find(
      (candidate) => candidate.slug === model || candidate.aliases?.includes(model) === true,
    );
    if (listed !== undefined) return listed.name;
  }
  return null;
}

/** The first agent a company is offered: the front door that hands work to the rest. */
export const KIN_CHIEF_OF_STAFF: KinLeadDraft = {
  name: "Chief of staff",
  area: "Chief of staff",
  charter:
    "My front door for the whole company. Answers what it can, passes the rest to the right agent and tells me it has. Keeps track of what I've asked for and reminds me. Never spends money or sends anything outside the company on its own.",
  intro: "",
};

/** The providers an agent may run on; the one rule lives in contracts, beside the host's. */
export { kinAgentDriverAllowed } from "@t3tools/contracts";

const switched = KIN_PROVIDER_FACTS.filter((facts) => facts.behindSwitch && !facts.devOnly);

/** The host's switch for the providers behind it, shown beside the model new agents start on. */
export const KIN_OTHER_PROVIDER_AGENTS = {
  title: "Agents on other providers",
  detail: `An experiment: agents may also run on ${switched.map((facts) => facts.label).join(" and ")} models. As on Claude, in your own chats they have a shell, files and the web, each step checked by Kin, and in chats others read only their Kin tools. Set the provider up under Settings, Providers first.`,
};

/** What an agent on this provider can't do, from the providers table; null when nothing. */
export function kinProviderLimitLine(driver: string | undefined): string | null {
  const facts = kinProviderFacts(driver);
  if (facts === undefined || facts.lacks.length === 0) return null;
  return `On ${facts.label}, this agent can't ${kinCantDo(facts.lacks)}.`;
}

/** An org's first agent is where the model comes from: the host copies it to every later one. */
export const KIN_LEAD_MODELS = {
  title: "Model",
  hint: "Your agents think with this. Agents you add later use the same one.",
  none: "This server has no provider set up that agents can run on yet. Set up Claude under Settings, Providers, then come back.",
};

/** The model a first agent starts on: the strongest offered, changeable. Null when none is. */
export function kinLeadStartingModel(models: ReadonlyArray<ModelSelection>): ModelSelection | null {
  const [first] = models;
  if (first === undefined) return null;
  const named = (...names: ReadonlyArray<string>) =>
    names
      .map((name) => models.find((model) => model.model.toLowerCase().includes(name)))
      .find((model) => model !== undefined);
  return named("opus", "sonnet") ?? first;
}

const INTRO_MAX = 320;

/** The empty chat's text: what the owner made this lead for, else what any lead does. */
export function kinLeadIntroDetail(charter: string | null): string {
  const own = charter?.trim() ?? "";
  if (own === "") {
    return "Tell it what you need in plain words. It answers, remembers what you ask it to and sets reminders. When it needs a decision from you, it asks here.";
  }
  if (own.length <= INTRO_MAX) return own;
  const cut = own.slice(0, INTRO_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), INTRO_MAX - 40)).trimEnd()}…`;
}

/** Why a save was refused, in the owner's terms. The host's own message never reaches the screen. */
export function kinLeadSaveProblem(error: unknown, creating: boolean): string {
  const reason =
    typeof error === "object" && error !== null && "reason" in error ? error.reason : null;
  switch (reason) {
    case "not_allowed":
      return creating
        ? "This device isn't allowed to add agents on this server."
        : "Only the person who set up this agent can change it.";
    case "conflict":
      return "You already have an agent with this name and area.";
    case "limit":
      return "This server has as many agents as it allows.";
    case "not_found":
      return "This agent is no longer here.";
    case "no_models":
      return "Choose the model your agents think with, then create it again.";
    default:
      return kinFailureText(
        error,
        creating ? "Couldn't create the agent." : "Couldn't save your changes.",
      );
  }
}

/** The people of the org the owner could still let message a lead, by name. */
export function kinLeadAccessCandidates(
  people: ReadonlyArray<Pick<KinPerson, "personId" | "displayName">>,
  allowed: KinLeadAccessResult["people"],
  ownerPersonId: string | null,
): ReadonlyArray<Pick<KinPerson, "personId" | "displayName">> {
  const taken = new Set<string>(allowed.map((person) => person.personId));
  return people
    .filter((person) => person.personId !== ownerPersonId && !taken.has(person.personId))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** The team agent's "Who can message": everyone, so no one is added or removed there. */
export const KIN_LEAD_EVERYONE = "Everyone on the team. This is the team agent.";

/** Whether this person may message the lead, by the server's answer; null while it loads. */
export function kinLeadMessageable(
  access: KinLeadAccessResult | null,
  personId: string,
): boolean | null {
  if (access === null) return null;
  return access.everyone === true || access.people.some((one) => one.personId === personId);
}

/** A teammate's card for someone else's agent: what its owner wrote under What teammates see. */
export function kinLeadContactAbout(contact: { readonly name: string; readonly intro: string }) {
  const intro = contact.intro.trim();
  return intro === "" ? `Message ${contact.name} here like a colleague.` : intro;
}

/** Told to a teammate in their chat with a lead's details: the owner can read that chat. */
export function kinLeadOwnerSeesLine(ownerName: string | undefined): string {
  return ownerName === undefined
    ? "Whoever runs this workspace can see chats with agents."
    : `${ownerName} runs this workspace and can see chats with agents.`;
}

/**
 * Said once after the owner changes who can message a lead. `ownerLevel` is the server's word on
 * the person removed (a co-owner messages every lead); without it, nothing is claimed either way.
 */
export function kinLeadAccessChanged(
  person: string,
  lead: string,
  allowed: boolean,
  ownerLevel?: boolean,
): string {
  if (allowed) return `${person} can now message ${lead}.`;
  if (ownerLevel === undefined) return `Removed ${person}'s own access to ${lead}.`;
  return ownerLevel
    ? `${person} can still message ${lead} as a co-owner.`
    : `${person} can no longer message ${lead}.`;
}

/** Why changing who can message a lead was refused, in the owner's terms. */
export function kinLeadAccessProblem(error: unknown): string {
  const reason =
    typeof error === "object" && error !== null && "reason" in error ? error.reason : null;
  switch (reason) {
    case "not_allowed":
      return "Only the person who set up this agent can choose who messages it.";
    case "not_found":
      return "That person or this agent is no longer here.";
    default:
      return kinFailureText(error, "Couldn't change that.");
  }
}

/**
 * The viewer may read this chat and no longer write in it: the lead's owner stopped them
 * messaging it. The host refuses their sends either way.
 */
export function kinChatReadOnly(
  chat: Pick<KinChatSummary, "members"> | undefined,
  personId: string | null,
): boolean {
  if (chat === undefined || personId === null) return false;
  return chat.members.some(
    (member) =>
      member.leftAt === null &&
      member.role === "guest" &&
      member.principal._tag === "person" &&
      member.principal.personId === personId,
  );
}

/** The one line where the composer was, in a chat the viewer can only read. */
export function kinChatReadOnlyLine(leadName: string | null): string {
  return `You can read this chat, but you can no longer message ${leadName ?? "this agent"}.`;
}

/** The owner's list of agents, and what a teammate is shown of one. */
export const KIN_AGENTS_COPY = {
  accessFailed: "Couldn't load who can message it.",
  seesIntro: (intro: string) => `They see its name and this: ${intro}`,
  charterExample: "Handles billing questions and invoices.",
  charterLabel: "What it's responsible for",
  removeAccess: (person: string, agent: string, ownerLevel?: boolean) =>
    ownerLevel === undefined
      ? `This removes ${person}'s own access to ${agent}. You can add them back any time.`
      : ownerLevel
        ? `${person} is a co-owner, so they can still message ${agent}. This matters only if they stop being one.`
        : `${person} keeps their chat with ${agent} to read, but can't send it anything more. You can add them back any time.`,
  /** Under "Who can message" with nobody added: owner-level people message every agent. */
  onlyOwners: "Only the owner and co-owners.",
  nameOnly: "They see its name only. Add what teammates see when you edit this agent.",
  none: "You have no agents yet.",
  explain:
    "An agent looks after one part of the company, such as engineering or finance, and you talk to it in a chat.",
  loadFailed: "Couldn't load your agents.",
  teammateViewHint: "Optional. People you let message this agent see this and nothing above.",
} as const;

/**
 * The agents on a live run, from the chat list's live rows, whose `working` follows each run: a
 * direct chat with an agent says it is working. The leads list's own flag is only as fresh as its
 * last read, so the Agents list and an agent's page say "Working" from this instead.
 */
export function kinWorkingAgents(
  chats: ReadonlyArray<
    Pick<KinChatSummary, "working"> & {
      readonly members: ReadonlyArray<Pick<KinChatSummary["members"][number], "principal">>;
    }
  > | null,
): ReadonlySet<KinAgentId> {
  const working = new Set<KinAgentId>();
  for (const chat of chats ?? []) {
    if (chat.working !== true) continue;
    for (const member of chat.members) {
      if (member.principal._tag === "agent") working.add(member.principal.agentId);
    }
  }
  return working;
}

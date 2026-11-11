import type {
  KinChatSummary,
  KinLeadAccessResult,
  KinLeadProfile,
  KinLeadTracking,
  KinPerson,
  ServerProviderModel,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";

import { formatKinDeferralTime } from "./kinDeferralPresentation.ts";

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

/** The second line under something a lead has in hand: "Reminder, Fri 13 Nov, 9:00". */
export function kinLeadTrackingDetail(
  item: Pick<KinLeadTracking, "kind" | "dueAt">,
  timeZone?: string,
): string {
  const kind = TRACKING_KINDS[item.kind];
  const due = item.dueAt === undefined ? Number.NaN : Date.parse(item.dueAt);
  return Number.isNaN(due) ? kind : `${kind}, ${formatKinDeferralTime(due, timeZone)}`;
}

/**
 * The lead's model as T3's model picker names it: the name its provider lists, else the id
 * read the way the picker reads one it has no name for.
 */
export function kinLeadModelName(
  model: string,
  providers:
    | ReadonlyArray<{
        readonly models: ReadonlyArray<Pick<ServerProviderModel, "slug" | "name" | "aliases">>;
      }>
    | null
    | undefined,
): string {
  for (const provider of providers ?? []) {
    const listed = provider.models.find(
      (candidate) => candidate.slug === model || candidate.aliases?.includes(model) === true,
    );
    if (listed !== undefined) return listed.name;
  }
  return formatModelSlugName(model);
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
      return "No model is set up for agents on this server yet, so the first agent can't be made from here. On the computer that runs Kin, run its “kin lead create” command with --strong and --cheap to choose the models. Agents you add after that use the same ones.";
    case "unavailable":
    case "disabled":
      return "Agents aren't running on this server right now. Try again in a moment.";
    default:
      return creating
        ? "Couldn't create the agent. Check your connection and try again."
        : "Couldn't save your changes. Check your connection and try again.";
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

/** Told to a teammate in their chat with a lead's details: the owner can read that chat. */
export function kinLeadOwnerSeesLine(ownerName: string | undefined): string {
  return ownerName === undefined
    ? "Whoever runs this workspace can see chats with agents."
    : `${ownerName} runs this workspace and can see chats with agents.`;
}

/** Said once after the owner changes who can message a lead. */
export function kinLeadAccessChanged(person: string, lead: string, allowed: boolean): string {
  return allowed
    ? `${person} can now message ${lead}.`
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
      return "Couldn't change that. Check your connection and try again.";
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

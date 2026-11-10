import type { KinLeadProfile, KinLeadTracking } from "@t3tools/contracts";

import { formatKinDeferralTime } from "./kinDeferralPresentation.ts";

export const KIN_LEAD_NAME_MAX = 80;
export const KIN_LEAD_CHARTER_MAX = 1_000;
const DOMAIN_MAX = 40;

/** A domain slug as people read it: `chief-of-staff` is "Chief of staff". */
export function kinDomainLabel(domain: string): string {
  const words = domain.replaceAll("-", " ").trim();
  return words === "" ? "" : `${words[0]!.toUpperCase()}${words.slice(1)}`;
}

/** What the owner typed as the host's slug; null when nothing in it can start one. */
export function kinDomainSlug(text: string): string | null {
  const slug = text
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
}

export function kinLeadDraftOf(
  profile: Pick<KinLeadProfile, "name" | "domain" | "charter">,
): KinLeadDraft {
  return { name: profile.name, area: kinDomainLabel(profile.domain), charter: profile.charter };
}

export type KinLeadDraftCheck =
  | { readonly ok: true; readonly name: string; readonly domain: string; readonly charter: string }
  | { readonly ok: false; readonly field: keyof KinLeadDraft; readonly problem: string };

/** The draft as the host takes it, or the first thing to fix. */
export function kinLeadDraftCheck(draft: KinLeadDraft): KinLeadDraftCheck {
  const name = draft.name.trim();
  if (name === "") return { ok: false, field: "name", problem: "Give the lead a name." };
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
  return { ok: true, name, domain, charter };
}

/** Only what changed, for `kin.lead.update`; null when the draft matches the lead. */
export function kinLeadChanges(
  profile: Pick<KinLeadProfile, "name" | "domain" | "charter">,
  checked: Extract<KinLeadDraftCheck, { readonly ok: true }>,
): { readonly name?: string; readonly domain?: string; readonly charter?: string } | null {
  const changes = {
    ...(checked.name === profile.name ? undefined : { name: checked.name }),
    ...(checked.domain === profile.domain ? undefined : { domain: checked.domain }),
    ...(checked.charter === profile.charter ? undefined : { charter: checked.charter }),
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
        ? "This phone isn't allowed to add leads on this server."
        : "Only the person who set up this lead can change it.";
    case "conflict":
      return "You already have a lead with this name and area.";
    case "limit":
      return "This server has as many leads as it allows.";
    case "not_found":
      return "This lead is no longer here.";
    case "unavailable":
    case "disabled":
      return "Leads aren't running on this server right now. Try again in a moment.";
    default:
      return creating
        ? "Couldn't create the lead. Check your connection and try again."
        : "Couldn't save your changes. Check your connection and try again.";
  }
}

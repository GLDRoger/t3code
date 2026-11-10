import {
  KinChatError,
  type EnvironmentId,
  type KinLeadProfile,
  type KinLeadTracking,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

export const KIN_LEAD_NAME_MAX = 80;
export const KIN_LEAD_CHARTER_MAX = 1_000;
const KIN_LEAD_DOMAIN_MAX = 40;

/** The lead form that is open: a new lead when `lead` is null, else the one being edited. */
export interface KinLeadFormTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly lead: KinLeadProfile | null;
}

/** One form at a time, opened from the chat list, a lead's profile or the command palette. */
export const kinLeadFormAtom = Atom.make<KinLeadFormTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("kin:lead-form"),
);

/**
 * The host's domain slug for what the owner typed: "Customer support" is `customer-support`.
 * Null when nothing usable is left, such as an area written only in digits or symbols.
 */
export function kinLeadDomainSlug(area: string): string | null {
  const slug = area
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, KIN_LEAD_DOMAIN_MAX)
    .replace(/-+$/, "");
  return slug === "" ? null : slug;
}

/** A domain slug as the owner reads it: `chief-of-staff` is "Chief of staff". */
export function kinLeadDomainLabel(domain: string): string {
  const words = domain.replace(/-/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const TRACKING_LABELS: Record<KinLeadTracking["kind"], string> = {
  work: "Working on",
  reminder: "Reminder",
  follow_up: "Follow-up",
  scheduled: "Repeats",
};

/** One thing a lead has in hand: what kind, what, and when it is due if it has a time. */
export function kinLeadTrackingRow(
  item: KinLeadTracking,
  formatTime: (date: Date) => string,
): { readonly label: string; readonly title: string; readonly due: string | null } {
  return {
    label: TRACKING_LABELS[item.kind],
    title: item.title,
    due: item.dueAt === undefined ? null : formatTime(new Date(item.dueAt)),
  };
}

const isKinChatError = Schema.is(KinChatError);

/** Why the host refused a lead form, in its own words where it wrote some for the owner. */
export function kinLeadSaveFailureText(cause: unknown): string {
  if (!isKinChatError(cause)) return "Couldn't save. Check the connection and try again.";
  if (cause.reason === "not_allowed") return "Only the owner can change this lead.";
  return cause.message.trim().slice(0, 280) || "Kin couldn't save this lead. Try again.";
}

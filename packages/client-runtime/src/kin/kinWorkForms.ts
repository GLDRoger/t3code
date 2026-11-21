import {
  KIN_CAMPAIGN_SOURCE,
  KIN_CONTACT_DETAILS_MAX,
  KIN_DEFAULT_HOME_CURRENCY,
  KIN_GST_STATES,
  KIN_GSTIN_PATTERN,
  KinRecordKey,
  KinRepoName,
  kinRealDay,
  type KinContact,
  type KinContactCreateInput,
  type KinContactUpdateInput,
  type KinPartyCreateInput,
  type KinPartyDetail,
  type KinPartyUpdateInput,
  type KinProjectCreateInput,
  type KinProjectDetail,
  type KinProjectBilling,
  type KinProjectUpdateInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import { kinFailureText } from "./kinAnswers.ts";
import { isKinChatError, kinWorkFailuresOf, kinWorkRefused, type KinWorkRef } from "./kinWork.ts";
import { kinMoneyDraft, kinParseMoney } from "./kinLists.ts";
import { kinContactEmailOk, kinContactPhoneOk, KIN_PROJECTS } from "./kinWorkClients.ts";
import { KIN_WORK_OFFLINE_CHANGE } from "./kinWorkChanges.ts";
import type { KinWorkLive } from "./kinWorkStream.ts";

const NAME_MAX = 200;
const SHORT_MAX = 200;
const NOTES_MAX = 4_000;
const ADDRESS_MAX = 500;
const PLACE_MAX = 60;
export const KIN_WORK_FORM_LIMITS = { name: NAME_MAX, short: SHORT_MAX, notes: NOTES_MAX };

export const KIN_WORK_FORM_COPY = {
  save: "Save",
  cancel: "Cancel",
  openExisting: "Open it",
  party: {
    newTitle: "New client",
    editTitle: "Edit client",
    add: "Add client",
    name: "Name",
    kind: "They are a",
    kindProspect: "Prospect",
    kindClient: "Client",
    kindVendor: "Vendor",
    prospectTitle: "New prospect",
    source: "Came from",
    sourcePlaceholder: "Where you met them, or who sent them",
    tags: "Tags",
    tagsPlaceholder: "Words to find them by, separated by commas",
    memberHint: "Terms, tax details and Keep private stay with the owner and co-owners.",
    terms: "Terms",
    termsPlaceholder: "How and when they pay",
    termsHint: "Always private. Only you see the terms.",
    address: "Billing address",
    addressPlaceholder: "Street, city and postal code",
    addressHint: "Printed on their invoices.",
    gstin: "GSTIN",
    gstinHint: "Leave empty if they aren't registered for GST.",
    place: "State",
    placeNone: "Not set",
    placeAbroad: "Outside India",
    placeHint:
      "Where the supply goes. Invoices charge CGST and SGST in your own state, IGST in another.",
    country: "Country",
    notes: "Notes",
    notesPlaceholder: "Anything worth remembering about them",
    contact: "Contact",
    contactName: "Person's name",
    contactHint: "Optional. You can add more people on its page later.",
    contactNameMissing: "Add the person's name, or leave the contact empty.",
  },
  contact: {
    newTitle: "New contact",
    editTitle: "Edit contact",
    add: "Add contact",
    name: "Name",
    role: "Role",
    email: "Email",
    phone: "Phone",
    addEmail: "Add another email",
    addPhone: "Add another phone",
    removeEmail: "Remove this email",
    removePhone: "Remove this phone",
    detailsHint: "Emails and phone numbers are always private.",
    notes: "Notes",
    notesPlaceholder: "Anything worth remembering about them",
    remove: "No longer a contact",
    restore: "Make a contact again",
  },
  project: {
    newTitle: "New project",
    editTitle: "Edit project",
    add: "Add project",
    name: "Name",
    party: "Client",
    noClient: "No client",
    target: "Target date",
    repos: "Repos",
    reposPlaceholder: "owner/name, one per line",
    billing: "Billing",
    noBilling: "Not set",
    value: "Value",
    valuePlaceholder: "Amount, and its currency if it isn't yours",
    startsOn: "Starts",
    renewsOn: "Renews on",
    notes: "Notes",
    notesPlaceholder: "What done looks like",
  },
};

// What the owner types

export type KinClientDraftKind = "prospect" | "client" | "vendor";

export interface KinClientDraft {
  readonly name: string;
  readonly kind: KinClientDraftKind;
  readonly source: string;
  /** As typed: words separated by commas. */
  readonly tags: string;
  readonly terms: string;
  readonly address: string;
  readonly gstin: string;
  /** A state's name from `KIN_GST_STATES`, a country when `abroad`, or empty. */
  readonly placeOfSupply: string;
  readonly abroad: boolean;
  readonly notes: string;
  readonly private: boolean;
  /** Its first contact, on a new one only; all empty for none. */
  readonly contactName: string;
  readonly contactRole: string;
  /** Every one typed, main first; always at least one field. */
  readonly contactEmails: ReadonlyArray<string>;
  readonly contactPhones: ReadonlyArray<string>;
}

/** The states a client may be in, by name. */
export const KIN_GST_STATE_NAMES = Object.values(KIN_GST_STATES).sort((a, b) => a.localeCompare(b));
const letters = (text: string) => text.toLowerCase().replace(/[^a-z]/g, "");
/** A stored place as a state's name: by name, or by its code as the server reads one. */
function kinGstStateName(place: string): string | null {
  const code = /^\s*(\d{2})\b/.exec(place)?.[1];
  if (code !== undefined && KIN_GST_STATES[code] !== undefined) return KIN_GST_STATES[code];
  const wanted = letters(place);
  if (wanted === "") return null;
  return KIN_GST_STATE_NAMES.find((name) => letters(name) === wanted) ?? null;
}
const gstinOf = (text: string) => text.replace(/\s+/g, "").toUpperCase();
/** The state a GSTIN is registered in, from its first two digits; null for one that isn't valid. */
function kinGstinState(gstin: string): string | null {
  const value = gstinOf(gstin);
  return KIN_GSTIN_PATTERN.test(value) ? (KIN_GST_STATES[value.slice(0, 2)] ?? null) : null;
}

/**
 * Whether a client form asks for a GSTIN and a State: only for a company in India, and for one on
 * a host too old to say where it is.
 */
export const kinIndiaFields = (country: string | null | undefined) =>
  country === undefined || country === "IN";

export const kinClientDraftOf = (
  party?: Pick<
    KinPartyDetail,
    | "name"
    | "kind"
    | "prospect"
    | "source"
    | "campaign"
    | "tags"
    | "terms"
    | "address"
    | "gstin"
    | "placeOfSupply"
    | "notes"
    | "sensitive"
  >,
  /** A new one starts as this; a new client from a teammate is always a prospect. */
  start: KinClientDraftKind = "client",
): KinClientDraft => {
  const place = party?.placeOfSupply?.trim() ?? "";
  const state = kinGstStateName(place);
  return {
    name: party?.name ?? "",
    kind:
      party === undefined
        ? start
        : party.kind === "vendor"
          ? "vendor"
          : party.prospect === true
            ? "prospect"
            : "client",
    // A campaign is stored by its key; the field shows its name (`kinCameFromLabel`).
    source:
      party?.campaign === undefined
        ? (party?.source ?? "")
        : `${KIN_CAMPAIGN_SOURCE}${party.campaign.key}`,
    tags: (party?.tags ?? []).join(", "),
    terms: party?.terms ?? "",
    address: party?.address ?? "",
    gstin: party?.gstin ?? "",
    placeOfSupply: state ?? place,
    abroad: place !== "" && state === null,
    notes: party?.notes ?? "",
    private: party?.sensitive ?? false,
    contactName: "",
    contactRole: "",
    contactEmails: [""],
    contactPhones: [""],
  };
};

/** A GSTIN typed in: the state it names fills in an empty one. */
export function kinClientDraftWithGstin(draft: KinClientDraft, gstin: string): KinClientDraft {
  const state = kinGstinState(gstin);
  return state !== null && !draft.abroad && draft.placeOfSupply === ""
    ? { ...draft, gstin, placeOfSupply: state }
    : { ...draft, gstin };
}

/** What a GSTIN and the state chosen beside it say together, when they disagree. */
export function kinClientGstinNote(draft: KinClientDraft): string | null {
  const state = kinGstinState(draft.gstin);
  if (state === null) return null;
  if (draft.abroad)
    return `This GSTIN is registered in ${state}, so its invoices are taxed as supplies to ${state}, not as exports.`;
  if (draft.placeOfSupply !== "" && draft.placeOfSupply !== state)
    return `This GSTIN is registered in ${state}, not ${draft.placeOfSupply}. Its invoices use the GSTIN's state, ${state}.`;
  return null;
}

const tooLong = (text: string, max: number, what: string) =>
  text.trim().length > max ? `Keep ${what} under ${max} characters.` : null;

const SOURCE_MAX = 120;
const TAG_MAX = 60;
const TAGS_MAX = 20;

/** The tags typed, each once, in the order typed. */
const kinClientTags = (text: string): ReadonlyArray<string> => [
  ...new Set(
    text
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag !== ""),
  ),
];

const tagsCheck = (text: string): string | null => {
  const tags = kinClientTags(text);
  if (tags.length > TAGS_MAX) return `Keep it to ${TAGS_MAX} tags.`;
  return tags.some((tag) => tag.length > TAG_MAX)
    ? `Keep each tag under ${TAG_MAX} characters.`
    : null;
};

const firstContactOf = (draft: KinClientDraft): KinContactDraft | null => {
  const contact = {
    name: draft.contactName,
    role: draft.contactRole,
    emails: draft.contactEmails,
    phones: draft.contactPhones,
    notes: "",
  };
  return [contact.name, contact.role, ...contact.emails, ...contact.phones].some(
    (typed) => typed.trim() !== "",
  )
    ? contact
    : null;
};
const firstContactCheck = (draft: KinClientDraft): string | null => {
  const contact = firstContactOf(draft);
  if (contact === null) return null;
  return contact.name.trim() === ""
    ? KIN_WORK_FORM_COPY.party.contactNameMissing
    : kinContactDraftCheck(contact);
};

export const kinClientDraftCheck = (draft: KinClientDraft): string | null =>
  draft.name.trim() === ""
    ? "Give them a name."
    : (tooLong(draft.name, NAME_MAX, "the name") ??
      tooLong(draft.source, SOURCE_MAX, "where they came from") ??
      tagsCheck(draft.tags) ??
      tooLong(draft.terms, NOTES_MAX, "the terms") ??
      tooLong(draft.address, ADDRESS_MAX, "the address") ??
      (draft.gstin.trim() !== "" && !KIN_GSTIN_PATTERN.test(gstinOf(draft.gstin))
        ? "That GSTIN isn't right: it has 15 letters and digits, like 27ABCDE1234F1Z5."
        : null) ??
      tooLong(draft.placeOfSupply, PLACE_MAX, "the country") ??
      tooLong(draft.notes, NOTES_MAX, "the notes") ??
      firstContactCheck(draft));

export const kinClientCreateInput = (
  draft: KinClientDraft,
): Omit<KinPartyCreateInput, "orgId" | "clientRequestId"> => {
  const contact = firstContactOf(draft);
  return {
    ...kinPartyInput(draft),
    ...(contact === null ? {} : { contact: kinContactCreateInput(contact) }),
  };
};
const kinPartyInput = (draft: KinClientDraft) => ({
  name: draft.name.trim(),
  ...(draft.kind === "vendor" ? { kind: "vendor" as const } : {}),
  ...(draft.kind === "prospect" ? { prospect: true } : {}),
  ...(draft.source.trim() === "" ? {} : { source: draft.source.trim() }),
  ...(kinClientTags(draft.tags).length === 0 ? {} : { tags: kinClientTags(draft.tags) }),
  ...(draft.terms.trim() === "" ? {} : { terms: draft.terms.trim() }),
  ...(draft.address.trim() === "" ? {} : { address: draft.address.trim() }),
  ...(draft.gstin.trim() === "" ? {} : { gstin: gstinOf(draft.gstin) }),
  ...(draft.placeOfSupply.trim() === "" ? {} : { placeOfSupply: draft.placeOfSupply.trim() }),
  ...(draft.notes.trim() === "" ? {} : { notes: draft.notes.trim() }),
  ...(draft.private ? { sensitive: true } : {}),
});

type Changed<D> = { readonly [K in keyof D]?: D[K] };

const KIND_INPUT: Record<KinClientDraftKind, Pick<KinPartyUpdateInput, "kind" | "prospect">> = {
  vendor: { kind: "vendor" },
  client: { kind: "client", prospect: false },
  prospect: { kind: "client", prospect: true },
};

export const kinClientUpdateInput = (
  changed: Changed<KinClientDraft>,
): Omit<KinPartyUpdateInput, "orgId" | "key" | "rev"> => ({
  ...(changed.name === undefined ? {} : { name: changed.name.trim() }),
  ...(changed.kind === undefined ? {} : KIND_INPUT[changed.kind]),
  ...(changed.source === undefined ? {} : { source: changed.source.trim() || null }),
  ...(changed.tags === undefined ? {} : { tags: kinClientTags(changed.tags) }),
  ...(changed.terms === undefined ? {} : { terms: changed.terms.trim() || null }),
  ...(changed.address === undefined ? {} : { address: changed.address.trim() || null }),
  ...(changed.gstin === undefined ? {} : { gstin: gstinOf(changed.gstin) || null }),
  ...(changed.placeOfSupply === undefined
    ? {}
    : { placeOfSupply: changed.placeOfSupply.trim() || null }),
  ...(changed.notes === undefined ? {} : { notes: changed.notes.trim() }),
  ...(changed.private === undefined ? {} : { sensitive: changed.private }),
});

export interface KinContactDraft {
  readonly name: string;
  readonly role: string;
  /** Every one typed, main first; always at least one field. */
  readonly emails: ReadonlyArray<string>;
  readonly phones: ReadonlyArray<string>;
  readonly notes: string;
  /** Absent on a client's first contact, which takes none. */
  readonly tags?: ReadonlyArray<string>;
}

/** Every one a contact has, main first, from a host that sends the list or only the main one. */
const detailsOf = (all: ReadonlyArray<string> | undefined, one: string | null | undefined) =>
  all !== undefined && all.length > 0 ? all : one == null ? [""] : [one];

export const kinContactDraftOf = (contact?: KinContact): KinContactDraft => ({
  name: contact?.name ?? "",
  role: contact?.role ?? "",
  emails: detailsOf(contact?.emails, contact?.email),
  phones: detailsOf(contact?.phones, contact?.phone),
  notes: contact?.notes ?? "",
  tags: contact?.tags ?? [],
});

/** One more empty field below the last, up to what a contact takes. */
export const kinContactDetailAdd = (list: ReadonlyArray<string>): ReadonlyArray<string> =>
  list.length >= KIN_CONTACT_DETAILS_MAX ? list : [...list, ""];
export const kinContactDetailCanAdd = (list: ReadonlyArray<string>) =>
  list.length < KIN_CONTACT_DETAILS_MAX;
/** Takes one off; the first field stays, emptied, so the next one typed becomes main. */
export const kinContactDetailRemove = (
  list: ReadonlyArray<string>,
  at: number,
): ReadonlyArray<string> => (list.length <= 1 ? [""] : list.filter((_, index) => index !== at));
export const kinContactDetailSet = (
  list: ReadonlyArray<string>,
  at: number,
  text: string,
): ReadonlyArray<string> => list.map((one, index) => (index === at ? text : one));

/** What is saved: trimmed, blanks and repeats dropped (emails in any case), in the order typed. */
const kept = (list: ReadonlyArray<string>, same: (text: string) => string) => {
  const seen = new Set<string>();
  return list.flatMap((typed) => {
    const text = typed.trim();
    if (text === "" || seen.has(same(text))) return [];
    seen.add(same(text));
    return [text];
  });
};
const keptEmails = (list: ReadonlyArray<string>) => kept(list, (text) => text.toLowerCase());
const keptPhones = (list: ReadonlyArray<string>) => kept(list, (text) => text);

/** Emails and phones are checked only when retyped, so an old entry never blocks other edits. */
export const kinContactDraftCheck = (
  draft: KinContactDraft,
  saved?: KinContactDraft,
): string | null => {
  if (draft.name.trim() === "") return "Give them a name.";
  const savedEmails = new Set((saved?.emails ?? []).map((one) => one.trim()));
  if (keptEmails(draft.emails).some((one) => !savedEmails.has(one) && !kinContactEmailOk(one)))
    return "Enter an email like name@example.com.";
  const savedPhones = new Set((saved?.phones ?? []).map((one) => one.trim()));
  if (keptPhones(draft.phones).some((one) => !savedPhones.has(one) && !kinContactPhoneOk(one)))
    return "Enter a phone number with digits in it.";
  return (
    tooLong(draft.name, NAME_MAX, "the name") ??
    tooLong(draft.role, SHORT_MAX, "the role") ??
    draft.emails.reduce<string | null>(
      (problem, one) => problem ?? tooLong(one, SHORT_MAX, "the email"),
      null,
    ) ??
    draft.phones.reduce<string | null>(
      (problem, one) => problem ?? tooLong(one, SHORT_MAX, "the phone number"),
      null,
    ) ??
    tooLong(draft.notes, NOTES_MAX, "the notes")
  );
};

/** The main one as before, all an older host reads, and the whole list beside several. */
const newDetails = (emails: ReadonlyArray<string>, phones: ReadonlyArray<string>) => {
  const allEmails = keptEmails(emails);
  const allPhones = keptPhones(phones);
  return {
    ...(allEmails[0] === undefined ? {} : { email: allEmails[0] }),
    ...(allEmails.length > 1 ? { emails: allEmails } : {}),
    ...(allPhones[0] === undefined ? {} : { phone: allPhones[0] }),
    ...(allPhones.length > 1 ? { phones: allPhones } : {}),
  };
};
/** An edit sends the whole list, so taking one off is never read as keeping the rest. */
const changedDetails = (
  emails: ReadonlyArray<string> | undefined,
  phones: ReadonlyArray<string> | undefined,
) => {
  const allEmails = emails === undefined ? undefined : keptEmails(emails);
  const allPhones = phones === undefined ? undefined : keptPhones(phones);
  return {
    ...(allEmails === undefined ? {} : { email: allEmails[0] ?? null, emails: allEmails }),
    ...(allPhones === undefined ? {} : { phone: allPhones[0] ?? null, phones: allPhones }),
  };
};

export const kinContactCreateInput = (
  draft: KinContactDraft,
): Omit<KinContactCreateInput, "orgId" | "party" | "clientRequestId"> => ({
  name: draft.name.trim(),
  ...(draft.role.trim() === "" ? {} : { role: draft.role.trim() }),
  ...newDetails(draft.emails, draft.phones),
  ...(draft.tags === undefined || draft.tags.length === 0 ? {} : { tags: draft.tags }),
  ...(draft.notes.trim() === "" ? {} : { notes: draft.notes.trim() }),
});

export const kinContactUpdateInput = (
  changed: Changed<KinContactDraft>,
): Omit<KinContactUpdateInput, "orgId" | "key" | "rev"> => ({
  ...(changed.name === undefined ? {} : { name: changed.name.trim() }),
  ...(changed.role === undefined ? {} : { role: changed.role.trim() || null }),
  ...changedDetails(changed.emails, changed.phones),
  ...(changed.tags === undefined ? {} : { tags: changed.tags }),
  ...(changed.notes === undefined ? {} : { notes: changed.notes.trim() }),
});

export interface KinProjectDraft {
  readonly name: string;
  readonly party: KinWorkRef | null;
  /** A calendar day, `YYYY-MM-DD`; null for no target. */
  readonly target: string | null;
  /** `owner/name`, one per line. */
  readonly repos: string;
  readonly notes: string;
  readonly private: boolean;
  readonly billing: KinProjectBilling | null;
  /** As typed: "600000", "$12,000"; empty for none. */
  readonly value: string;
  /** What a value that names no currency is in: the company's home currency. */
  readonly currency: string;
  readonly startsOn: string | null;
  readonly renewsOn: string | null;
  readonly campaign: boolean;
  /** A campaign's audience tag; empty for none. */
  readonly audience: string;
}

export const KIN_PROJECT_BILLING_LABELS: Readonly<Record<KinProjectBilling, string>> = {
  fixed: "Fixed price",
  hourly: "Hourly",
  retainer: "Retainer",
};

export const kinProjectDraftOf = (
  project?: KinProjectDetail,
  /** Its all-day target as a day where the owner is. */
  targetDay?: string | null,
  /** The client a new project is opened from. */
  party?: KinWorkRef | null,
  /** The company's home currency, when this viewer can read it. */
  home: string = KIN_DEFAULT_HOME_CURRENCY,
): KinProjectDraft => ({
  name: project?.name ?? "",
  party:
    project === undefined
      ? (party ?? null)
      : project.party === null
        ? null
        : { key: project.party.key, title: project.party.title },
  target: targetDay ?? null,
  repos: project?.repos.join("\n") ?? "",
  notes: project?.notes ?? "",
  private: project?.sensitive ?? false,
  billing: project?.billing ?? null,
  value:
    project?.value === undefined || project.value === null
      ? ""
      : kinMoneyDraft(project.value, home),
  currency: home,
  startsOn: project?.startsOn ?? null,
  renewsOn: project?.renewsOn ?? null,
  campaign: project?.campaign === true,
  audience: project?.audience ?? "",
});
const valueOf = (text: string, currency: string) =>
  text.trim() === "" ? null : kinParseMoney(text.trim(), currency);

const isRepo = Schema.is(KinRepoName);
const reposOf = (text: string) =>
  text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

const NOT_A_DAY = "Enter a real date.";

/** What the target field says under itself; the picked day is on the field, so then nothing. */
export const kinProjectTargetHint = (target: string | null): string | null => {
  if (target === null) return `Leave it empty for ${KIN_PROJECTS.noTarget.toLowerCase()}.`;
  return kinRealDay(target) ? null : NOT_A_DAY;
};

export const kinProjectDraftCheck = (draft: KinProjectDraft): string | null => {
  if (draft.name.trim() === "") return "Give the project a name.";
  const repos = reposOf(draft.repos);
  if (!repos.every((repo) => isRepo(repo))) return "Write each repo as owner/name, one per line.";
  if (repos.length > 20) return "A project can have up to 20 repos.";
  if (draft.target !== null && !kinRealDay(draft.target)) return NOT_A_DAY;
  if (draft.startsOn !== null && !kinRealDay(draft.startsOn)) return NOT_A_DAY;
  if (draft.renewsOn !== null && !kinRealDay(draft.renewsOn)) return NOT_A_DAY;
  if (draft.value.trim() !== "" && valueOf(draft.value, draft.currency) === null)
    return "Write the value as an amount, such as 600000 or $12,000.";
  return (
    tooLong(draft.name, NAME_MAX, "the name") ??
    tooLong(draft.audience, TAG_MAX, "the audience") ??
    tooLong(draft.notes, NOTES_MAX, "the notes")
  );
};

const repoNames = (text: string) => reposOf(text).filter((repo) => isRepo(repo));

export const kinProjectCreateInput = (
  draft: KinProjectDraft,
): Omit<KinProjectCreateInput, "orgId" | "clientRequestId"> => ({
  name: draft.name.trim(),
  ...(draft.party === null ? {} : { party: draft.party.key }),
  ...(draft.target === null ? {} : { targetAt: draft.target, targetAllDay: true }),
  ...(repoNames(draft.repos).length === 0 ? {} : { repos: repoNames(draft.repos) }),
  ...(draft.notes.trim() === "" ? {} : { notes: draft.notes.trim() }),
  ...(draft.private ? { sensitive: true } : {}),
  ...(draft.billing === null ? {} : { billing: draft.billing }),
  ...(valueOf(draft.value, draft.currency) === null
    ? {}
    : { value: valueOf(draft.value, draft.currency) }),
  ...(draft.startsOn === null ? {} : { startsOn: draft.startsOn }),
  ...(draft.renewsOn === null ? {} : { renewsOn: draft.renewsOn }),
  ...(draft.campaign ? { campaign: true } : {}),
  ...(draft.campaign && draft.audience.trim() !== "" ? { audience: draft.audience.trim() } : {}),
});

export const kinProjectUpdateInput = (
  changed: Changed<KinProjectDraft>,
  currency: string,
): Omit<KinProjectUpdateInput, "orgId" | "key" | "rev"> => ({
  ...(changed.name === undefined ? {} : { name: changed.name.trim() }),
  ...(changed.party === undefined ? {} : { party: changed.party?.key ?? null }),
  ...(changed.target === undefined
    ? {}
    : changed.target === null
      ? { targetAt: null }
      : { targetAt: changed.target, targetAllDay: true }),
  ...(changed.repos === undefined ? {} : { repos: repoNames(changed.repos) }),
  ...(changed.notes === undefined ? {} : { notes: changed.notes.trim() }),
  ...(changed.private === undefined ? {} : { sensitive: changed.private }),
  ...(changed.billing === undefined ? {} : { billing: changed.billing }),
  ...(changed.value === undefined ? {} : { value: valueOf(changed.value, currency) }),
  ...(changed.startsOn === undefined ? {} : { startsOn: changed.startsOn }),
  ...(changed.renewsOn === undefined ? {} : { renewsOn: changed.renewsOn }),
  ...(changed.campaign === undefined ? {} : { campaign: changed.campaign }),
  ...(changed.audience === undefined ? {} : { audience: changed.audience.trim() || null }),
});

// Why a change didn't go through

export type KinWorkFormProblem =
  /** Something typed needs fixing before it is sent. */
  | { readonly kind: "invalid"; readonly text: string }
  /** No connection. Nothing is queued: the owner tries again when back. */
  | { readonly kind: "offline"; readonly text: string }
  /** Someone changed it meanwhile. What was typed is kept; saving again sends it. */
  | { readonly kind: "conflict"; readonly text: string }
  /** Another active one has this name; `existing` opens it. */
  | { readonly kind: "duplicate"; readonly text: string; readonly existing: KinRecordKey }
  /** Closing was refused because open work still points at it. */
  | { readonly kind: "open_work"; readonly text: string }
  | { readonly kind: "failed"; readonly text: string };

const KIN_PROJECT_DONE_GROUP = "Done";

export interface KinTaskProjectGroup {
  /** Null for the open projects, which come first without a heading. */
  readonly label: string | null;
  readonly choices: ReadonlyArray<KinWorkRef>;
}

/** A task's project menu: open projects, then done ones, so a late task can still be filed there. */
export function kinTaskProjectMenu(choices: {
  readonly projects: ReadonlyArray<KinWorkRef>;
  readonly doneProjects: ReadonlyArray<KinWorkRef>;
}): ReadonlyArray<KinTaskProjectGroup> {
  const groups = [
    { label: null, choices: choices.projects },
    { label: KIN_PROJECT_DONE_GROUP, choices: choices.doneProjects },
  ];
  return groups.filter((group) => group.choices.length > 0);
}

export const KIN_WORK_FORM_CHANGED =
  "This changed while you were editing. What you typed is still here. Check what's new, then save again.";

type Noun = "client" | "contact" | "project";

const isKey = Schema.is(KinRecordKey);
/** The host names the one already there at the end of what it says: "…named Acme: C-3." */
const existingKey = (message: string): KinRecordKey | null => {
  const found = /: (\S+)\.$/.exec(message.trim())?.[1];
  return found !== undefined && isKey(found) ? found : null;
};

const STILL_OPEN: Record<Noun, (name: string) => string> = {
  client: (name) =>
    `${name} still has open tasks or projects. Finish them or move them to another client, then close.`,
  project: (name) =>
    `${name} still has open tasks. Finish them, drop them or move them to another project first.`,
  contact: (name) => `${name} couldn't be changed. Check the details.`,
};

/** A refusal in words for the owner, with what he can do next. */
function kinWorkFormProblem(
  error: unknown,
  about: {
    readonly noun: Noun;
    /** The name being saved, or the one being closed. */
    readonly name: string;
    /** Its own key, which a duplicate never is. Null for a new one. */
    readonly own: KinRecordKey | null;
  },
): KinWorkFormProblem {
  if (isKinChatError(error) && error.reason === "conflict") {
    const existing = existingKey(error.message);
    return existing !== null && existing !== about.own
      ? {
          kind: "duplicate",
          text: `There's already a ${about.noun} called ${about.name.trim()}.`,
          existing,
        }
      : { kind: "conflict", text: KIN_WORK_FORM_CHANGED };
  }
  if (
    isKinChatError(error) &&
    error.reason === "invalid_state" &&
    /still has \d+ open/.test(error.message)
  )
    return { kind: "open_work", text: STILL_OPEN[about.noun](about.name) };
  return {
    kind: "failed",
    text: kinFailureText(error, "That didn't go through.", {
      gone: `That ${about.noun} isn't there any more.`,
      device: "This device isn't allowed to change Work.",
    }),
  };
}

type Sent<A> = Promise<AtomCommandResult<A, unknown>>;

export type KinWorkFormOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly problem: KinWorkFormProblem };

/** One change that isn't a form: closing, reopening, a label. Never sent while offline. */
export async function kinWorkSend<A>(input: {
  readonly online: () => boolean;
  readonly send: () => Sent<A>;
  readonly noun: Noun;
  readonly name: string;
  readonly own: KinRecordKey | null;
}): Promise<KinWorkFormOutcome<A>> {
  if (!input.online())
    return { ok: false, problem: { kind: "offline", text: KIN_WORK_OFFLINE_CHANGE } };
  const result = await input.send();
  return AsyncResult.isSuccess(result)
    ? { ok: true, value: result.value }
    : { ok: false, problem: kinWorkFormProblem(squashAtomCommandFailure(result), input) };
}

// A form

/** Asked once when a form that holds typed, unsaved words is closed. */
export const KIN_FORM_DISCARD = {
  title: "Discard what you typed?",
  keep: "Keep editing",
  discard: "Discard",
} as const;

const typedValue = (value: unknown): unknown =>
  typeof value === "string"
    ? value.trim()
    : Array.isArray(value)
      ? value.map(typedValue).filter((one) => one !== "")
      : value;

/**
 * Whether closing a form would throw away something: a field that now says other than it did
 * when the form opened. Spaces, and an empty "Add another" row, are nothing typed.
 */
export function kinFormTyped<D extends object>(from: D, draft: D): boolean {
  return (Object.keys(draft) as Array<keyof D>).some(
    (key) => JSON.stringify(typedValue(draft[key])) !== JSON.stringify(typedValue(from[key])),
  );
}

/** A form's fields: text, a switch, or a client picked by its key. */
type Draft = object;

const keyOf = (value: unknown) =>
  typeof value === "object" && value !== null && "key" in value ? value.key : value;
const same = (a: unknown, b: unknown) => keyOf(a) === keyOf(b);

export interface KinWorkFormState<D> {
  readonly draft: D;
  /** What it said when the owner started typing. */
  readonly from: D;
  /** What it says now, once the host has said it moved on; null until then. */
  readonly latest: D | null;
  readonly saving: boolean;
  readonly problem: KinWorkFormProblem | null;
}

/** The fields the owner retyped: what a save sends, so someone else's other changes stay. */
function kinWorkFormChanged<D extends Draft>(state: Pick<KinWorkFormState<D>, "draft" | "from">) {
  const changed: { [K in keyof D]?: D[K] } = {};
  for (const key of Object.keys(state.draft) as Array<keyof D & string>) {
    const typed = state.draft[key];
    const before = state.from[key];
    const moved =
      typeof typed === "string" && typeof before === "string"
        ? typed.trim() !== before.trim()
        : !same(typed, before);
    if (moved) changed[key] = typed;
  }
  return changed;
}

/** What someone else changed meanwhile, to show beside the owner's own words. */
export function kinWorkFormMoved<D extends Draft>(
  state: Pick<KinWorkFormState<D>, "from" | "latest">,
): { readonly [K in keyof D]?: D[K] } {
  const moved: { [K in keyof D]?: D[K] } = {};
  if (state.latest === null) return moved;
  for (const key of Object.keys(state.from) as Array<keyof D & string>) {
    if (!same(state.latest[key], state.from[key])) moved[key] = state.latest[key];
  }
  return moved;
}

/**
 * A form for a client, contact or project, new or existing. Saving sends only what was retyped,
 * against the revision last seen. A refusal keeps everything typed: a conflict reads the latest
 * and waits for the owner to save again, a duplicate name offers the one already there, and
 * nothing is sent or queued while offline.
 */
export function createKinWorkForm<D extends Draft, A>(options: {
  readonly noun: Noun;
  readonly start: D;
  /** The key and revision being edited; null for a new one. */
  readonly editing: { readonly key: KinRecordKey; readonly rev: number } | null;
  readonly nameOf: (draft: D) => string;
  /** `from` is what it said when opened, so a check can pass over fields nobody retyped. */
  readonly check: (draft: D, from: D) => string | null;
  /** Sends a new one whole, or the retyped fields of an existing one at `rev`. */
  readonly send: (
    change:
      | { readonly type: "create"; readonly draft: D }
      | {
          readonly type: "update";
          readonly key: KinRecordKey;
          readonly changed: { [K in keyof D]?: D[K] };
          readonly rev: number;
          readonly draft: D;
        },
  ) => Sent<A>;
  readonly online: () => boolean;
  /** Reads it again after the host said it had moved on. */
  readonly reread: () => void;
  readonly onChange: (state: KinWorkFormState<D>) => void;
}) {
  let state: KinWorkFormState<D> = {
    draft: options.start,
    from: options.start,
    latest: null,
    saving: false,
    problem: null,
  };
  let rev = options.editing?.rev ?? 0;
  const set = (patch: Partial<KinWorkFormState<D>>) => {
    state = { ...state, ...patch };
    options.onChange(state);
  };
  return {
    getState: () => state,
    edit: (patch: Partial<D>) => set({ draft: { ...state.draft, ...patch }, problem: null }),
    /**
     * Takes in a newer read of what is being edited. Nothing typed changes; the next save goes
     * against this revision, and the form can show what moved.
     */
    latest: (values: D, latestRev: number) => {
      if (latestRev <= rev) return;
      rev = latestRev;
      set({ latest: values });
    },
    /** Resolves with what the host saved, or null when it didn't; `unchanged` needed no send. */
    save: async (): Promise<
      { readonly saved: true; readonly value: A | null } | { readonly saved: false }
    > => {
      if (state.saving) return { saved: false };
      const invalid = options.check(state.draft, state.from);
      if (invalid !== null) {
        set({ problem: { kind: "invalid", text: invalid } });
        return { saved: false };
      }
      const changed = kinWorkFormChanged(state);
      if (options.editing !== null && Object.keys(changed).length === 0)
        return { saved: true, value: null };
      set({ saving: true, problem: null });
      const { draft } = state;
      const { editing } = options;
      const outcome = await kinWorkSend({
        online: options.online,
        send: () =>
          options.send(
            editing === null
              ? { type: "create", draft }
              : { type: "update", key: editing.key, changed, rev, draft },
          ),
        noun: options.noun,
        name: options.nameOf(draft),
        own: options.editing?.key ?? null,
      });
      if (outcome.ok) {
        set({ saving: false });
        return { saved: true, value: outcome.value };
      }
      if (outcome.problem.kind === "conflict") options.reread();
      set({ saving: false, problem: outcome.problem });
      return { saved: false };
    },
  };
}

// Reading one client or project

export type KinWorkReadState<A> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "gone" }
  | { readonly _tag: "refused" }
  /** `cause` says whether to offer Retry (`kinFailure`). */
  | { readonly _tag: "failed"; readonly cause: unknown }
  | {
      readonly _tag: "ready";
      readonly value: A;
      /** The last read failed, so what is shown may be behind. */
      readonly stale: boolean;
    };

export function kinWorkReadState<A>(
  result: AsyncResult.AsyncResult<A, unknown>,
): KinWorkReadState<A> {
  const failures = AsyncResult.isFailure(result) ? kinWorkFailuresOf(result.cause) : [];
  if (failures.some(kinWorkRefused)) return { _tag: "refused" };
  if (failures.some((error) => isKinChatError(error) && error.reason === "not_found"))
    return { _tag: "gone" };
  const value = Option.getOrNull(AsyncResult.value(result));
  if (value !== null) return { _tag: "ready", value, stale: AsyncResult.isFailure(result) };
  return AsyncResult.isFailure(result)
    ? { _tag: "failed", cause: result.cause }
    : { _tag: "loading" };
}

/** The letters a key starts with, which every entry of one kind shares: `C` of `C-12`. */
const kindOf = (key: string) => key.slice(0, key.indexOf("-"));

/** Whether a named change means an open client or project page is behind. */
function kinWorkPageAffected(
  key: string,
  page: { readonly own: string; readonly held: ReadonlySet<string> },
): "yes" | "no" | "ask" {
  if (key === page.own || page.held.has(key)) return "yes";
  // A campaign's counts read every client, contact and deal: `kinProjectPageKeys` holds `C-*`.
  if (page.held.has(`${kindOf(key)}-*`)) return "yes";
  // Another client never shows on a client's page, nor another project on a project's.
  if (kindOf(key) === kindOf(page.own)) return "no";
  // A task, contact or project the page doesn't hold might have just been pointed at it.
  return "ask";
}

/**
 * Decides when an open client or project page is read again: for a change naming something it
 * shows, never for one it covers or another client's. A change naming anything else might have
 * just become this page's, so `newest` asks for the page's latest change number first.
 */
export function createKinWorkPageWatch(options: {
  readonly own: KinRecordKey;
  readonly reread: () => void;
  /** The latest change number in this client's or project's history; null if it couldn't be read, which reads the page. */
  readonly newest: () => Promise<number | null>;
}) {
  /** The highest change number already acted on, so one change never reads twice. */
  let handled = 0;
  let asking = false;
  return {
    /** Call with each state of Work and the page as held; `page` is null while it is first read. */
    changed: (
      live: Pick<KinWorkLive, "changed" | "unnamed">,
      page: { readonly seq: number; readonly held: ReadonlySet<string> } | null,
    ) => {
      if (page === null) return;
      const floor = Math.max(page.seq, handled);
      const news = Object.entries(live.changed).filter(([, seq]) => seq > floor);
      const top = Math.max(live.unnamed, ...news.map(([, seq]) => seq));
      if (top <= floor) return;
      const verdicts = news.map(([key]) =>
        kinWorkPageAffected(key, { own: options.own, held: page.held }),
      );
      if (live.unnamed > floor || verdicts.includes("yes")) {
        handled = top;
        return options.reread();
      }
      if (!verdicts.includes("ask")) {
        handled = top;
        return;
      }
      // One question at a time; what arrives meanwhile is asked about when the page next changes.
      if (asking) return;
      asking = true;
      handled = top;
      void options.newest().then((newest) => {
        asking = false;
        // A teammate can't read the history (it is the owner's), so the page itself is read again.
        if (newest === null || newest > page.seq) options.reread();
      });
    },
  };
}

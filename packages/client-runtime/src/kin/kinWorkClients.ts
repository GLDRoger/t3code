// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import { KIN_CHECK_CONNECTION } from "./kinAnswers.ts";
import { kinOwnerLevel, formatKinWhen } from "@t3tools/contracts";
import type {
  KinAccessMeResult,
  KinClientTouch,
  KinContact,
  KinOrgId,
  KinPartiesInput,
  KinPerson,
  KinPersonId,
  KinPartyPage,
  KinPartyRow,
  KinProjectHealth,
  KinProjectPage,
  KinProjectRow,
  KinProjectState,
  KinProjectsInput,
  KinRecordKey,
  KinTouchLogInput,
  KinWorkHistoryItem,
  KinWorkPrincipal,
} from "@t3tools/contracts";

import { kinLinkToOpen } from "./kinChatFeed.ts";
import { kinMoneyText } from "./kinLists.ts";
import { formatKinTime, type KinAvatarView } from "./kinScreenState.ts";
import { KIN_SCOPE_ALL, kinNothingShown, type KinViewerScope } from "./kinViewerScope.ts";
import {
  kinWorkAllDay,
  kinWorkAvatar,
  kinWorkPrincipalKey,
  kinWorkChangeText,
  kinWorkDueText,
  kinWorkName,
  kinWorkPrivacy,
  kinWorkRow,
  type KinWorkNames,
  type KinWorkPrivacy,
  type KinWorkRef,
  type KinWorkRowView,
} from "./kinWork.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export const KIN_PROJECT_LEAD = {
  title: "Project lead",
  change: "Change",
  choose: "Choose the project lead",
  detail:
    "The lead and their agent run this project without asking: its tasks, milestones, docs, the client's contacts, and draft quotes and invoices. Issuing, payments and anything sent out stay with the owner and co-owners.",
  save: "Make lead",
  failed: "The lead didn't change.",
} as const;

/** Who is on a project: they see its tasks, milestones and docs. */
export const KIN_PROJECT_PEOPLE = {
  add: "Add people",
  choose: "Who's on this project",
  detail:
    "People on a project see its tasks, milestones and docs, and are told they were added. Taken off, its tasks leave their list at once.",
  agents: "Agents",
  people: "People",
  nobodyLeft: "Everyone is already on it.",
  save: "Add",
  remove: (name: string) => `Take ${name} off`,
  failed: "Who's on it didn't change.",
  none: "Nobody else is on it yet.",
} as const;

/**
 * Who could still be put on a project: teammates and agents at work, not already on it, by name.
 * The lead is on it by leading it.
 */
export function kinProjectPeopleChoices(input: {
  readonly people: ReadonlyArray<KinPerson> | null;
  readonly names: Pick<KinWorkNames, "agents" | "retired">;
  /** The project's People rows; someone listed only for a task they hold isn't on it. */
  readonly on: ReadonlyArray<{ readonly who: KinWorkPrincipal; readonly onIt: boolean }>;
}): ReadonlyArray<{
  readonly who: KinWorkPrincipal;
  readonly key: string;
  readonly name: string;
  readonly agent: boolean;
}> {
  const taken = new Set(
    input.on.filter((row) => row.onIt).map((row) => kinWorkPrincipalKey(row.who)),
  );
  const people = (input.people ?? []).map((person) => ({
    who: { _tag: "person", personId: person.personId } as const,
    name: person.displayName,
  }));
  const agents = [...input.names.agents]
    .filter(([agentId]) => input.names.retired?.has(agentId) !== true)
    .map(([agentId, name]) => ({ who: { _tag: "agent", agentId } as KinWorkPrincipal, name }));
  return [...people, ...agents]
    .map((one) => ({ ...one, key: kinWorkPrincipalKey(one.who), agent: one.who._tag === "agent" }))
    .filter((one) => !taken.has(one.key))
    .sort((a, b) => Number(a.agent) - Number(b.agent) || a.name.localeCompare(b.name));
}

/** A teammate's projects on their sheet, and the ones they could be put on. */
export const KIN_TEAMMATE_PROJECTS = {
  title: "Projects",
  none: "Not on any project yet. They see its tasks once they're on one.",
  lead: "Lead",
  on: "On it",
  add: "Add to a project",
  leadHint: "A project's lead is set on its page.",
  remove: (project: string) => `Take them off ${project}`,
} as const;

export function kinTeammateProjects(
  personId: KinPersonId,
  theirs: ReadonlyArray<KinProjectRow>,
  open: ReadonlyArray<KinProjectRow>,
) {
  const on = new Set(theirs.map((row) => row.key));
  return {
    rows: theirs.map((row) => {
      const leads = row.owner._tag === "person" && row.owner.personId === personId;
      return {
        key: row.key,
        title: row.name,
        line: leads ? KIN_TEAMMATE_PROJECTS.lead : KIN_TEAMMATE_PROJECTS.on,
        /** On it by name: the lead stays on it by leading it. */
        removable: !leads,
      };
    }),
    addable: open
      .filter((row) => !on.has(row.key))
      .map((row) => ({ key: row.key, title: row.name })),
  };
}

/** Everyone who can lead a project, by name. */
export const kinProjectLeadChoices = (people: ReadonlyArray<KinPerson> | null) =>
  (people ?? [])
    .map((person) => ({ personId: person.personId, name: person.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name));

export const KIN_CLIENTS = {
  title: "Clients",
  tax: "Tax details",
  noTax: "No GSTIN or state yet. Invoices need one to work out GST.",
  all: "All clients",
  search: "Search clients",
  add: "New client",
  loadFailed: "Couldn't load your clients",
  weOwe: "To do for them",
  theyOwe: "Waiting on them",
  addWeOwe: "Add a task for them",
  addTheyOwe: "Add something we're waiting on",
  nothingOwed: "Nothing to do for them right now.",
  nothingOwing: "Nothing waiting on them right now.",
  contacts: "Contacts",
  addContact: "Add contact",
  noContacts: "No one yet. Add who you deal with there.",
  /** For someone who can't add contacts. */
  noContactsYet: "No contacts yet.",
  projects: "Projects",
  noProjects: "No projects for them yet.",
  terms: "Terms",
  noTerms: "No terms noted.",
  termsPrivate: "Always private. Only you see the terms.",
  detailsPrivate: "Only teammates with Clients see emails and phone numbers. Others see names.",
  notes: "Notes",
  noNotes: "No notes.",
  recentContact: "Recent contact",
  logContact: "Log contact",
  noneLogged: "None logged",
  noTouches: "Nothing logged yet. Log a call, meeting or email here, or tell an agent about it.",
  touchNote: "What happened",
  touchNotePlaceholder: "Spoke to Asha, they want the revised quote by Friday",
  touchWhen: "When",
  touchKind: "How",
  touchSave: "Log it",
  touchRemove: "Remove",
  touchRemoveTitle: "Remove this logged contact?",
  details: "Details",
  detailsSummary: "Address, tax, terms and notes",
  touchFailed: "Couldn't log that.",
  history: "History",
  noHistory: "Nothing has happened yet.",
  earlier: "Show earlier",
  edit: "Edit",
  close: "Close client",
  reopen: "Reopen",
  active: "Active",
  closed: "Closed",
  privateLabel: "Keep private",
  privateOn: "Private. Only you see this client, its projects and what's owed.",
  privateOff: "Your team will be able to see this client. Terms and contact details stay private.",
  kindProspect: "Prospect",
  kindClient: "Client",
  kindVendor: "Vendor",
  addProspect: "Add a prospect",
  show: "Show",
  lookedAfterBy: "Looked after by",
  lookedAfterMe: "Looked after by me",
  anyone: "Anyone",
  me: "Me",
  someone: "Someone…",
  order: "Within each: late first, then no next step, then by name.",
  nextStep: "Next step",
  noNextStep: "No next step",
  addNextStep: "Add one",
  nextStepTitle: "Next step",
  nextStepPlaceholder: "What happens next, if anything",
  nextStepWhen: "By",
  cameFrom: "Came from",
  tags: "Tags",
  makeClient: "Make it a client",
  makeProspect: "Make it a prospect again",
};

export const KIN_CLIENTS_SHOW = [
  { id: "open", label: "Everyone open" },
  { id: "prospects", label: "Prospects" },
  { id: "clients", label: "Clients" },
  { id: "vendors", label: "Vendors" },
  { id: "closed", label: "Closed" },
] as const;
export type KinClientsShow = (typeof KIN_CLIENTS_SHOW)[number]["id"];

export const KIN_CLIENT_GONE = {
  title: "This client isn't here any more",
  detail: "Open Clients to see who there is now.",
};
/** The host keeps this client from the viewer: a refusal, never a connection problem. */
export const KIN_CLIENT_REFUSED = {
  title: "This client isn't yours to see",
  detail: "The owner or a co-owner decides who sees Clients.",
};

export const KIN_CLIENT_FAILED = {
  title: "Couldn't load this client",
  detail: KIN_CHECK_CONNECTION,
};

export const KIN_PROJECTS = {
  title: "Projects",
  all: "All projects",
  search: "Search projects",
  add: "New project",
  loadFailed: "Couldn't load your projects",
  blocked: "Blocked",
  nextDue: "Next due",
  pullRequests: "Open pull requests",
  changed: "This week",
  nothingChanged: "Nothing changed this week.",
  tasks: "Tasks",
  addTask: "Add task",
  repos: "Repos",
  notes: "Notes",
  edit: "Edit",
  done: "Mark done",
  drop: "Drop project",
  reopen: "Reopen",
  noTarget: "No target date",
  privateLabel: "Keep private",
  privateOn: "Private. Only you see this project and its tasks.",
  privateOff: "Your team will be able to see this project.",
  milestones: "Milestones",
  addMilestone: "Add milestone",
  /** Only to someone who can add one: the owner, a co-owner, the project's lead. */
  noMilestonesAdd: "No milestones yet. Ask an agent to plan it from the PRD, or add one.",
  noMilestones: "No milestones yet.",
  people: "People",
  meetings: "Meetings",
  specChanged: "Spec changed",
  money: "Money",
  seeAllMoney: "See all in Money",
  details: "Details",
  count: (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`,
};

export const KIN_PROJECT_GONE = {
  title: "This project isn't here any more",
  detail: "Open Projects to see what there is now.",
};
export const KIN_PROJECT_REFUSED = {
  title: "This project isn't yours to see",
  detail: "Projects show for the people on them, and for the owner and co-owners.",
};

export const KIN_PROJECT_FAILED = {
  title: "Couldn't load this project",
  detail: KIN_CHECK_CONNECTION,
};

/** What a server from before clients and projects is told, instead of an error. */
export const KIN_CLIENTS_OLDER_HOST = {
  title: "Your server needs an update",
  detail: "Clients and projects come with the next version. Tasks work as before.",
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

// Contact

export const KIN_TOUCH_KINDS = [
  { id: "call", label: "Call" },
  { id: "meeting", label: "Meeting" },
  { id: "email", label: "Email" },
  { id: "message", label: "Message" },
  { id: "other", label: "Other" },
] as const;

const TOUCH_TITLES: Record<KinClientTouch["kind"], string> = {
  call: "Call",
  meeting: "Meeting",
  email: "Email",
  message: "Message",
  other: "Contact",
  invoice: "Invoice issued",
  quote: "Quote sent",
  payment: "Payment received",
};

const daysBetween = (at: string, now: Date) =>
  Math.max(0, Math.floor((now.getTime() - new Date(at).getTime()) / DAY_MS));

/**
 * A client page's one line on contact, counted as the pulse counts it: the last one, when and what
 * it was ("Last contact 1 Oct, 46 days ago: Invoice: INV-3"), or none since they were added. Null
 * from a host before contact logs.
 */
export function kinClientContactLine(
  party: Pick<KinPartyPage["party"], "lastContactAt" | "createdAt">,
  latest: KinTouchView | undefined,
  now: Date,
): string | null {
  const at = party.lastContactAt;
  if (at === undefined) return null;
  const days = daysBetween(at ?? party.createdAt, now);
  const ago = days === 0 ? "" : `, ${plural(days, "day")} ago`;
  if (at === null)
    return `No contact logged since they were added ${formatKinTime(new Date(party.createdAt), now)}${ago}`;
  return `Last contact ${formatKinTime(new Date(at), now)}${ago}${latest === undefined ? "" : `: ${latest.title}`}`;
}

/**
 * "Last contact 3 days ago", or "No logged contact for 52 days" once a week has passed. Null
 * from a host before contact logs. Only what was logged counts, so it never says "no contact".
 */
export function kinLastContactLine(lastAt: string | null | undefined, now: Date): string | null {
  if (lastAt === undefined) return null;
  if (lastAt === null) return "No logged contact yet";
  const days = daysBetween(lastAt, now);
  if (days >= 7) return `No logged contact for ${days} days`;
  return days === 0
    ? "Last contact today"
    : days === 1
      ? "Last contact yesterday"
      : `Last contact ${days} days ago`;
}

/** The device's own day, as a date field holds it. */
export const kinLocalDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** When a touch logged for `day` happened: now for today, else midday that day, never ahead. */
export function kinTouchAt(day: string, now: Date): string | undefined {
  if (day === "" || day >= kinLocalDay(now)) return undefined;
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year!, month! - 1, date!, 12).toISOString();
}

const NEXT_STEP_MAX = 280;

/**
 * The follow-up Log contact leaves, as the host takes it: a task we owe them, due all day on the
 * day picked. Nothing for an empty title; a day alone leaves none.
 */
export function kinTouchNext(
  title: string,
  day: string,
): KinTouchLogInput["next"] | { readonly problem: string } | undefined {
  const text = title.trim();
  if (text === "") return undefined;
  if (text.length > NEXT_STEP_MAX)
    return { problem: `Keep the next step under ${NEXT_STEP_MAX} characters.` };
  return { title: text, ...(day === "" ? {} : { dueAt: day, dueAllDay: true }) };
}

export interface KinTouchView {
  readonly id: string;
  /** "Call · Asha" (who on our side), "Invoice issued: INV-3". */
  readonly title: string;
  readonly note: string | null;
  readonly when: string;
  /** Logged by a person or an agent; what Kin read from its own records can't be removed. */
  readonly removable: boolean;
}

function kinTouchView(touch: KinClientTouch, now: Date): KinTouchView {
  const base = TOUCH_TITLES[touch.kind];
  const note = touch.note.trim();
  return {
    id: touch.id,
    title: touch.logged
      ? `${base}${touch.who === null ? "" : ` · ${touch.who}`}`
      : `${base}${touch.record === null ? "" : `: ${touch.record.key}`}`,
    note: touch.logged ? (note === "" ? null : note) : (touch.record?.title ?? null),
    when: formatKinTime(new Date(touch.at), now),
    removable: touch.logged,
  };
}

// Clients

/** What the clients list shows: which of them, who looks after them, optionally matching words. */
export interface KinClientsFilter {
  readonly show: KinClientsShow;
  readonly lookedAfter: "anyone" | KinWorkPrincipal;
  readonly text: string;
}

export const KIN_CLIENTS_DEFAULT_FILTER: KinClientsFilter = {
  show: "open",
  lookedAfter: "anyone",
  text: "",
};

/** Who sees every client's row: the owner level, and a teammate with the Clients switch on. */
export const kinSeesClients = (
  me: Pick<KinAccessMeResult, "access" | "places"> | null | undefined,
): boolean => me != null && (kinOwnerLevel(me.access) || me.places?.clients === true);

/** A teammate with Clients on starts on their own; the owner level starts on everyone's. */
export function kinClientsStartFilter(
  me: Pick<KinAccessMeResult, "access" | "places" | "personId"> | null | undefined,
): KinClientsFilter {
  if (me == null || kinOwnerLevel(me.access) || me.places?.clients !== true)
    return KIN_CLIENTS_DEFAULT_FILTER;
  return {
    ...KIN_CLIENTS_DEFAULT_FILTER,
    lookedAfter: { _tag: "person", personId: me.personId },
  };
}

const lookedAfterKey = (who: KinClientsFilter["lookedAfter"]) =>
  who === "anyone" ? who : kinWorkPrincipalKey(who);

export const kinClientsSameFilter = (a: KinClientsFilter, b: KinClientsFilter) =>
  a.show === b.show &&
  lookedAfterKey(a.lookedAfter) === lookedAfterKey(b.lookedAfter) &&
  a.text.trim() === b.text.trim();

const SHOW_QUERY: Record<KinClientsShow, Partial<KinPartiesInput>> = {
  open: {},
  prospects: { prospect: true },
  clients: { kind: "client" },
  vendors: { kind: "vendor" },
  closed: { active: false },
};

export function kinClientsQuery(
  orgId: KinOrgId,
  filter: KinClientsFilter,
): Omit<KinPartiesInput, "cursor" | "limit"> {
  const text = filter.text.trim().slice(0, 200);
  return {
    orgId,
    ...SHOW_QUERY[filter.show],
    ...(filter.lookedAfter === "anyone" ? {} : { owner: filter.lookedAfter }),
    ...(text === "" ? {} : { text }),
  };
}

/** "Me", "Anyone", or whoever else was picked, as the filter's chip names it. */
export function kinClientsLookedAfterLabel(
  who: KinClientsFilter["lookedAfter"],
  names: KinWorkNames,
): string {
  if (who === "anyone") return KIN_CLIENTS.anyone;
  return kinWorkName(who, names, KIN_CLIENTS.me);
}

/** Everyone else who could look after a client, people before agents, each by name. */
export function kinClientsLookedAfterChoices(
  names: Pick<KinWorkNames, "people" | "agents" | "retired" | "me">,
): ReadonlyArray<{ readonly who: KinWorkPrincipal; readonly key: string; readonly name: string }> {
  const people = [...names.people]
    .filter(([personId]) => personId !== names.me)
    .map(([personId, name]) => ({ who: { _tag: "person", personId } as KinWorkPrincipal, name }));
  const agents = [...names.agents]
    .filter(([agentId]) => names.retired?.has(agentId) !== true)
    .map(([agentId, name]) => ({ who: { _tag: "agent", agentId } as KinWorkPrincipal, name }));
  const byName = (a: { readonly name: string }, b: { readonly name: string }) =>
    a.name.localeCompare(b.name);
  return [...people.sort(byName), ...agents.sort(byName)].map((one) => ({
    ...one,
    key: kinWorkPrincipalKey(one.who),
  }));
}

type Owed = Pick<KinPartyRow, "weOwe" | "theyOwe" | "late" | "overdue">;

/** "2 to do (1 late) · Waiting on 1 (1 overdue)", or "Nothing open". */
function kinOwedLine(owed: Owed): string {
  const parts = [
    owed.weOwe > 0 ? `${owed.weOwe} to do${owed.late > 0 ? ` (${owed.late} late)` : ""}` : null,
    owed.theyOwe > 0
      ? `Waiting on ${owed.theyOwe}${owed.overdue > 0 ? ` (${owed.overdue} overdue)` : ""}`
      : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Nothing open" : parts.join(" · ");
}

export interface KinClientRowView {
  readonly key: KinRecordKey;
  readonly name: string;
  /** "Prospect" ahead of the line, in the accent colour; null for a client or a vendor. */
  readonly mark: string | null;
  /** "Vendor · 2 to do (1 late) · Waiting on 1", or a prospect's "Zoya" after its mark. */
  readonly line: string;
  /** "Next: Monthly report, Fri 14 Nov", or "No next step"; null for a vendor with nothing owed. */
  readonly next: string | null;
  /** `next` says there is no next step: shown in amber. */
  readonly noNext: boolean;
  /** Something either side owes is past its date. */
  readonly late: boolean;
  readonly private: boolean;
  readonly closed: boolean;
  readonly accessibilityLabel: string;
}

export function kinClientRow(row: KinPartyRow, names: KinWorkNames, now: Date): KinClientRowView {
  const prospect = row.prospect === true;
  const who = kinWorkName(row.owner, names);
  // A teammate's row comes without counts (and without a contact day): it names, it doesn't count.
  const counted = row.lastContactAt !== undefined;
  const line = [
    row.kind === "vendor" ? KIN_CLIENTS.kindVendor : null,
    prospect && who !== "You" ? who : null,
    !row.active ? KIN_CLIENTS.closed : prospect || !counted ? null : kinOwedLine(row),
    row.active && row.kind === "client" && !prospect
      ? kinLastContactLine(row.lastContactAt, now)
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const day = row.next === null ? null : kinWorkDueText(row.next, names, now);
  const noNext = row.next === null && row.active && row.kind === "client" && counted;
  const source = prospect ? (row.source?.trim() ?? "") : "";
  const next =
    row.next !== null
      ? `${row.next.late ? "Late" : "Next"}: ${row.next.title}${day === null ? "" : `, ${row.next.late ? "was due " : ""}${day}`}`
      : noNext
        ? `${KIN_CLIENTS.noNextStep}${source === "" ? "" : ` · from ${source}`}`
        : null;
  const late = row.late > 0 || row.overdue > 0;
  const mark = prospect ? KIN_CLIENTS.kindProspect : null;
  return {
    key: row.key,
    name: row.name,
    mark,
    line,
    next,
    noNext,
    late,
    private: row.sensitive,
    closed: !row.active,
    accessibilityLabel: [row.name, mark, line, next, row.sensitive ? "Private" : null]
      .filter((part) => part !== null && part !== "")
      .join(". "),
  };
}

/** Why the clients list shows nothing, and whether to offer a new client. */
export function kinClientsNothing(
  filter: KinClientsFilter,
  scope: KinViewerScope = KIN_SCOPE_ALL,
  me: KinPersonId | null = null,
): {
  readonly title: string;
  readonly detail: string;
  readonly offerNew: boolean;
} {
  const text = filter.text.trim();
  if (text !== "")
    return { title: `Nothing matches “${text}”`, detail: "Try another name.", offerNew: false };
  if (filter.show === "closed")
    return {
      title: "No closed clients",
      detail: "A client you close shows up here, with its history.",
      offerNew: false,
    };
  const narrowed = SHOW_NOTHING[filter.show];
  if (narrowed !== null) return { ...narrowed, offerNew: filter.show === "prospects" };
  if (filter.lookedAfter !== "anyone")
    return filter.lookedAfter._tag === "person" && filter.lookedAfter.personId === me
      ? {
          title: "You don't look after any yet",
          detail: "Add a prospect, or show Anyone to see the rest.",
          offerNew: true,
        }
      : {
          title: "They don't look after any yet",
          detail: "Show Anyone to see every client and prospect.",
          offerNew: false,
        };
  const shown = kinNothingShown("clients", scope);
  // A teammate with Clients on may still add a prospect; the button shows only to whoever can.
  if (shown !== null) return { ...shown, offerNew: true };
  return {
    title: "No clients or prospects yet",
    detail:
      "Add the companies you sell to or work for. A prospect becomes a client when you make it one. Or paste a contract into a chat with an agent and ask it to set the client up.",
    offerNew: true,
  };
}

const SHOW_NOTHING: Record<
  Exclude<KinClientsShow, "closed">,
  { readonly title: string; readonly detail: string } | null
> = {
  open: null,
  prospects: { title: "No prospects", detail: "Companies you haven't sold to yet show here." },
  clients: { title: "No clients", detail: "A prospect you make a client shows here." },
  vendors: { title: "No vendors", detail: "Companies you buy from show here." },
};

export interface KinContactView {
  readonly key: KinRecordKey;
  readonly rev: number;
  readonly name: string;
  readonly role: string | null;
  /** What to show and what a tap opens; `href` is null when it doesn't look like one. */
  readonly email: { readonly text: string; readonly href: string | null } | null;
  readonly phone: { readonly text: string; readonly href: string | null } | null;
  readonly notes: string | null;
  /** No longer someone to reach there. */
  readonly closed: boolean;
  readonly accessibilityLabel: string;
}

/** The bar a contact's email must clear before a row offers to mail it; forms check the same. */
export const kinContactEmailOk = (email: string) => /^[^\s@]+@[^\s@]+$/.test(email);
/** Anything with a digit can be dialled: short internal lines and extensions included. */
export const kinContactPhoneOk = (phone: string) => /\d/.test(phone);

const emailHref = (email: string) => (kinContactEmailOk(email) ? `mailto:${email}` : null);
const phoneHref = (phone: string) => {
  const [line = "", extension] = phone.split(/\s*(?:ext\.?|x|#)\s*/i);
  const number = line.replace(/[^\d+]/g, "");
  if (!/\d/.test(number)) return null;
  const ext = extension?.replace(/\D/g, "") ?? "";
  return `tel:${number}${ext === "" ? "" : `;ext=${ext}`}`;
};

function kinContactView(contact: KinContact): KinContactView {
  const notes = contact.notes.trim();
  return {
    key: contact.key,
    rev: contact.rev,
    name: contact.name,
    role: contact.role,
    email: contact.email === null ? null : { text: contact.email, href: emailHref(contact.email) },
    phone: contact.phone === null ? null : { text: contact.phone, href: phoneHref(contact.phone) },
    notes: notes === "" ? null : notes,
    closed: !contact.active,
    accessibilityLabel: [contact.name, contact.role, contact.active ? null : "No longer a contact"]
      .filter((part) => part !== null)
      .join(". "),
  };
}

/** One side of what is owed: the rows read, and how many more the host has. */
export interface KinOwedView {
  readonly rows: ReadonlyArray<KinWorkRowView>;
  readonly total: number;
  /** "See all 62"; null when everything is shown. */
  readonly more: string | null;
}

/** The soonest open thing we owe a client or prospect: the first thing its page shows. */
export interface KinClientNextView {
  readonly key: KinRecordKey;
  readonly title: string;
  /** "Today · Zoya · W-44", "Was due Wed 18 Nov · You · W-38". */
  readonly line: string;
  readonly late: boolean;
}

/** What this reader may do on a client's page; the host checks each change again. */
export type KinClientCan = NonNullable<KinPartyPage["can"]>;

const CAN_ALL: KinClientCan = { edit: true, log: true, owner: true };
const CAN_NONE: KinClientCan = { edit: false, log: false, owner: false };

export interface KinClientPageView {
  readonly key: KinRecordKey;
  readonly rev: number;
  readonly ref: KinWorkRef;
  readonly name: string;
  readonly vendor: boolean;
  readonly prospect: boolean;
  /** "Prospect · from Harbour trade fair", "Vendor · Closed". */
  readonly line: string;
  readonly lookedAfter: { readonly name: string; readonly avatar: KinAvatarView };
  /** Null for a vendor, which has no Next step row; `next: null` inside says there is none. */
  readonly nextStep: { readonly next: KinClientNextView | null } | null;
  readonly source: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly can: KinClientCan;
  readonly closed: boolean;
  readonly privacy: KinWorkPrivacy;
  readonly weOwe: KinOwedView;
  readonly theyOwe: KinOwedView;
  readonly projects: ReadonlyArray<KinProjectRowView>;
  readonly contacts: ReadonlyArray<KinContactView>;
  readonly terms: string | null;
  readonly address: string | null;
  /** "GSTIN 27ABCDE1234F1Z5 · Maharashtra"; null when neither is set. */
  readonly tax: string | null;
  readonly notes: string | null;
  /** Newest first; null from a host before contact logs. */
  readonly touches: ReadonlyArray<KinTouchView> | null;
  readonly lastContact: string | null;
}

export function kinClientPageView(
  page: KinPartyPage,
  names: KinWorkNames,
  now: Date,
  /** A host before prospects sends no `can`: there only the owner level changes a client. */
  ownerLevel: boolean,
): KinClientPageView {
  const { party } = page;
  const ref = { key: party.key, title: party.name };
  const weOwe = page.weOwe.records.map((record) =>
    kinWorkRow(record, names, now, { party: ref, project: null, sided: true }),
  );
  const owed = (side: KinPartyPage["weOwe"], rows: ReadonlyArray<KinWorkRowView>): KinOwedView => ({
    rows,
    total: side.total,
    more: side.total > side.records.length ? `See all ${side.total}` : null,
  });
  const theyOwe = page.theyOwe.records.map((record) =>
    kinWorkRow(record, names, now, { party: ref, project: null, sided: true }),
  );
  const prospect = party.prospect === true;
  const vendor = party.kind === "vendor";
  const source = party.source?.trim() || null;
  const notes = party.notes.trim();
  const terms = party.terms?.trim() ?? "";
  const touches =
    page.touches === undefined ? null : page.touches.map((touch) => kinTouchView(touch, now));
  return {
    key: party.key,
    rev: party.rev,
    ref,
    name: party.name,
    vendor,
    prospect,
    line: [
      vendor
        ? KIN_CLIENTS.kindVendor
        : prospect
          ? KIN_CLIENTS.kindProspect
          : KIN_CLIENTS.kindClient,
      party.active ? null : KIN_CLIENTS.closed,
      source === null ? null : `from ${source}`,
    ]
      .filter((part) => part !== null)
      .join(" · "),
    lookedAfter: { name: kinWorkName(party.owner, names), avatar: kinWorkAvatar(party.owner) },
    nextStep: vendor ? null : { next: kinClientNext(party, weOwe, names, now) },
    source,
    tags: party.tags ?? [],
    can: page.can ?? (ownerLevel ? CAN_ALL : CAN_NONE),
    closed: !party.active,
    privacy: {
      private: party.sensitive,
      inherited: false,
      note: party.sensitive ? KIN_CLIENTS.privateOn : KIN_CLIENTS.privateOff,
    },
    weOwe: owed(page.weOwe, weOwe),
    theyOwe: owed(page.theyOwe, theyOwe),
    projects: page.projects.map((row) => kinProjectRow(row, names, now, ref)),
    contacts: page.contacts.map(kinContactView),
    terms: terms === "" ? null : terms,
    address: party.address?.trim() || null,
    tax:
      [party.gstin === null ? null : `GSTIN ${party.gstin}`, party.placeOfSupply?.trim() || null]
        .filter((part) => part !== null)
        .join(" · ") || null,
    notes: notes === "" ? null : notes,
    touches,
    lastContact:
      (party.kind === "client" ? kinClientContactLine(party, touches?.[0], now) : null) ??
      (touches?.length === 0 ? KIN_CLIENTS.noneLogged : null),
  };
}

function kinClientNext(
  party: KinPartyPage["party"],
  weOwe: ReadonlyArray<KinWorkRowView>,
  names: KinWorkNames,
  now: Date,
): KinClientNextView | null {
  const next = party.next;
  if (next === null) return null;
  const day = kinWorkDueText(next, names, now);
  const row = weOwe.find((held) => held.key === next.key);
  const when =
    day === null ? null : next.late ? `Was due ${day}` : day.charAt(0).toUpperCase() + day.slice(1);
  return {
    key: next.key,
    title: next.title,
    line: [when, row?.holder ?? null, next.key].filter((part) => part !== null).join(" · "),
    late: next.late,
  };
}

/** Every key a client page shows something of: a change naming one means the page is behind. */
export const kinClientPageKeys = (page: KinPartyPage): ReadonlySet<string> =>
  new Set([
    page.party.key,
    ...page.contacts.map((contact) => contact.key),
    ...page.projects.map((project) => project.key),
    ...page.weOwe.records.map((record) => record.key),
    ...page.theyOwe.records.map((record) => record.key),
  ]);

// Projects

export interface KinProjectsFilter {
  readonly view: KinProjectState;
  readonly text: string;
}

export const KIN_PROJECTS_DEFAULT_FILTER: KinProjectsFilter = { view: "open", text: "" };

export const KIN_PROJECT_VIEWS: ReadonlyArray<{
  readonly id: KinProjectState;
  readonly label: string;
}> = [
  { id: "open", label: "Under way" },
  { id: "done", label: "Done" },
  { id: "dropped", label: "Dropped" },
];

export const kinProjectsSameFilter = (a: KinProjectsFilter, b: KinProjectsFilter) =>
  a.view === b.view && a.text.trim() === b.text.trim();

export function kinProjectsQuery(
  orgId: KinOrgId,
  filter: KinProjectsFilter,
): Omit<KinProjectsInput, "cursor" | "limit"> {
  const text = filter.text.trim().slice(0, 200);
  return { orgId, state: filter.view, ...(text === "" ? {} : { text }) };
}

/** How a project is going, as the host worked it out. Shown, never typed. */
export interface KinHealthView {
  readonly id: KinProjectHealth;
  readonly label: string;
  readonly tone: "good" | "warning" | "bad";
}

const HEALTH: Record<KinProjectHealth, KinHealthView> = {
  on_track: { id: "on_track", label: "On track", tone: "good" },
  at_risk: { id: "at_risk", label: "At risk", tone: "warning" },
  late: { id: "late", label: "Late", tone: "bad" },
};

const PROJECT_CLOSED: Record<KinProjectState, string | null> = {
  open: null,
  done: "Done",
  dropped: "Dropped",
};

export interface KinProjectRowView {
  readonly key: KinRecordKey;
  readonly name: string;
  /** Null once the project is done or dropped. */
  readonly health: KinHealthView | null;
  /** "Acme · Meera · 5 open · 1 late · target Fri 14 Nov": client, lead, counts, target. */
  readonly line: string;
  readonly private: boolean;
  readonly accessibilityLabel: string;
}

function kinProjectRow(
  row: KinProjectRow,
  names: KinWorkNames,
  now: Date,
  /** The client whose page the row is on, which it needn't repeat. */
  within?: KinWorkRef,
): KinProjectRowView {
  const target = kinWorkDueText({ dueAt: row.targetAt, dueAllDay: row.targetAllDay }, names, now);
  const health = row.health === null ? null : HEALTH[row.health];
  const line = [
    row.party === null || row.party.key === within?.key ? null : row.party.title,
    kinWorkName(row.owner, names),
    PROJECT_CLOSED[row.state],
    row.state === "open" ? `${row.open} open` : null,
    row.late > 0 ? `${row.late} late` : null,
    target === null || row.state !== "open" ? null : `target ${target}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const isPrivate = row.sensitive || row.sensitiveInherited;
  return {
    key: row.key,
    name: row.name,
    health,
    line,
    private: isPrivate,
    accessibilityLabel: [row.name, health?.label ?? null, line, isPrivate ? "Private" : null]
      .filter((part) => part !== null)
      .join(". "),
  };
}

/** Why the projects list shows nothing, and whether to offer a new project. */
export function kinProjectsNothing(
  filter: KinProjectsFilter,
  scope: KinViewerScope = KIN_SCOPE_ALL,
): {
  readonly title: string;
  readonly detail: string;
  readonly offerNew: boolean;
} {
  const text = filter.text.trim();
  if (text !== "")
    return { title: `Nothing matches “${text}”`, detail: "Try another name.", offerNew: false };
  if (filter.view === "done")
    return {
      title: "Nothing finished yet",
      detail: "Projects you mark done show up here.",
      offerNew: false,
    };
  if (filter.view === "dropped")
    return { title: "Nothing dropped", detail: "Projects you drop show up here.", offerNew: false };
  const shown = kinNothingShown("projects", scope);
  if (shown !== null) return { ...shown, offerNew: false };
  return {
    title: "No projects yet",
    detail:
      "Add a project to see at a glance how it's going, what's blocked and what's due next. Or ask an agent to break a piece of work into tasks.",
    offerNew: true,
  };
}

/** The Clients place's views: who the company works with, what it hopes to win, and the work. */
export type KinClientsTab = "clients" | "deals" | "projects";

const KIN_CLIENTS_TABS: ReadonlyArray<{
  readonly id: KinClientsTab;
  readonly label: string;
}> = [
  { id: "clients", label: KIN_CLIENTS.title },
  { id: "deals", label: "Deals" },
  { id: "projects", label: KIN_PROJECTS.title },
];

/** The views this person has: Deals only at the owner level or with Clients on. */
export const kinClientsTabs = (seesClients: boolean) =>
  seesClients ? KIN_CLIENTS_TABS : KIN_CLIENTS_TABS.filter((held) => held.id !== "deals");

/** The view to show for an asked one: a view they lack, such as Deals, shows Clients. */
export const kinClientsTabShown = (tab: KinClientsTab, seesClients: boolean): KinClientsTab =>
  kinClientsTabs(seesClients).some((held) => held.id === tab) ? tab : "clients";

const KIN_PROJECTS_NO_CLIENT = "Not for a client";

export interface KinProjectsGroupView {
  readonly id: string;
  readonly title: string;
  /** The client the heading opens; null for projects with no client. */
  readonly party: KinRecordKey | null;
  readonly rows: ReadonlyArray<KinProjectRowView>;
}

/** The Projects tab: projects under their client by name, then those that are not for a client. */
export function kinProjectsByClient(
  rows: ReadonlyArray<KinProjectRow>,
  names: KinWorkNames,
  now: Date,
): ReadonlyArray<KinProjectsGroupView> {
  const groups = new Map<
    string,
    { title: string; party: KinRecordKey | null; rows: KinProjectRowView[] }
  >();
  for (const row of rows) {
    const id = row.party === null ? "none" : `client:${row.party.key}`;
    const group = groups.get(id) ?? {
      title: row.party?.title ?? KIN_PROJECTS_NO_CLIENT,
      party: row.party?.key ?? null,
      rows: [],
    };
    // Under its client's heading, the row needn't name the client again.
    group.rows.push(kinProjectRow(row, names, now, row.party ?? undefined));
    groups.set(id, group);
  }
  return [...groups.entries()]
    .map(([id, group]) => ({ id, ...group }))
    .sort((a, b) =>
      a.party === null ? 1 : b.party === null ? -1 : a.title.localeCompare(b.title),
    );
}

export interface KinWorkTimelineLine {
  readonly key: string;
  /** "9:41" today, "7 Nov" otherwise. */
  readonly when: string;
  readonly text: string;
  /** What it happened to, when that isn't the page's own client or project. */
  readonly about: string | null;
  /** The task it happened to, to open it; null for anything else. */
  readonly task: KinRecordKey | null;
}

/** A client's or project's history as lines: who did what, and to which task or contact. */
export function kinWorkTimeline(
  items: ReadonlyArray<KinWorkHistoryItem>,
  names: KinWorkNames,
  now: Date,
  own: KinRecordKey,
): ReadonlyArray<KinWorkTimelineLine> {
  return items.map((item) => ({
    key: String(item.seq),
    when: formatKinTime(new Date(item.at), now),
    text: kinWorkChangeText(
      item,
      names,
      now,
      item.record.list === "milestones" || item.record.list === "goals" ? "work" : item.record.list,
    ),
    about: item.record.key === own ? null : item.record.title,
    task: item.record.list === "work" || item.record.list === "milestones" ? item.record.key : null,
  }));
}

/** "today", "1 day", "9 days": how long something has waited. */
function waited(since: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(since).getTime()) / DAY_MS);
  return !Number.isFinite(days) || days < 1 ? "since today" : `for ${plural(days, "day")}`;
}

export interface KinProjectPageView {
  readonly key: KinRecordKey;
  readonly rev: number;
  readonly ref: KinWorkRef;
  readonly name: string;
  readonly party: KinWorkRef | null;
  readonly state: KinProjectState;
  /** "Done" or "Dropped"; null while it is under way. */
  readonly closed: string | null;
  readonly health: KinHealthView | null;
  /** Why the health is what it is, a sentence each. */
  readonly why: ReadonlyArray<string>;
  /** "Target Fri 14 Nov", or "No target date". */
  readonly target: string;
  /** Its all-day target as `YYYY-MM-DD`, for the form. */
  readonly targetDay: string | null;
  /** "Led by Tech lead"; null when the owner leads it. */
  readonly ledBy: string | null;
  /** Who leads it, by name ("You" for the viewer), and their person when a person does. */
  readonly lead: { readonly name: string; readonly personId: KinPersonId | null };
  readonly privacy: KinWorkPrivacy;
  /** "3 not started · 2 in progress · 1 waiting · 5 done". */
  readonly counts: string;
  readonly blocked: ReadonlyArray<{
    readonly key: KinRecordKey;
    readonly title: string;
    /** "Waiting on Mira for 9 days". */
    readonly line: string;
  }>;
  readonly nextDue: KinWorkRowView | null;
  readonly pullRequests: ReadonlyArray<{
    readonly key: string;
    /** The pull request as people say it, by its number. */
    readonly label: string;
    readonly title: string;
    readonly href: string | null;
    readonly task: KinRecordKey;
  }>;
  readonly changed: ReadonlyArray<KinWorkTimelineLine>;
  /** "and 12 more"; null when the week is shown whole. */
  readonly changedMore: string | null;
  readonly repos: ReadonlyArray<string>;
  readonly notes: string | null;
  /** "Fixed price · ₹6,00,000 · 18 Nov to 1 Mar"; null when none of it is set. */
  readonly terms: string | null;
  readonly milestones: ReadonlyArray<KinMilestoneView>;
  readonly people: ReadonlyArray<{
    readonly key: string;
    readonly who: KinWorkPrincipal;
    readonly name: string;
    readonly avatar: KinAvatarView;
    /** "Lead · 3 open, 1 late". */
    readonly line: string;
    /** On it by name, not by leading it or holding a task in it: theirs to take off. */
    readonly member: boolean;
    /** On it by name or by leading it, so not offered under Add people. */
    readonly onIt: boolean;
  }>;
  /** This reader may put people on it and take them off (the host's `can`). */
  readonly changesPeople: boolean;
  readonly meetings: ReadonlyArray<KinWorkRowView>;
  readonly specChanged: ReadonlyArray<{
    readonly key: KinRecordKey;
    readonly title: string;
    /** "Lumen spec · checkout section changed", or "… was removed". */
    readonly line: string;
    readonly doc: KinRecordKey;
  }>;
  /** Quoted, invoiced, received, unpaid, each per currency; empty when nothing is filed here. */
  readonly money: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}

export interface KinMilestoneView {
  readonly key: KinRecordKey;
  readonly title: string;
  /** "3 of 8 done · due Fri 20 Nov". */
  readonly line: string;
  /** Done share, 0 to 1. */
  readonly progress: number;
  readonly tone: "late" | "at_risk" | "done" | null;
  /** "Late", "At risk" or "Done". */
  readonly badge: string | null;
}

const BILLING: Record<string, string> = {
  fixed: "Fixed price",
  hourly: "Hourly",
  retainer: "Retainer",
};
/** "1 Dec" for a `YYYY-MM-DD` day, read as that calendar day wherever the viewer is. */
const dayText = (day: string) =>
  formatKinWhen(new Date(`${day}T12:00:00Z`), "date", { zone: "UTC" });

function projectTerms(project: KinProjectPage["project"], target: string | null): string | null {
  const parts = [
    project.billing === undefined || project.billing === null ? null : BILLING[project.billing],
    project.value === undefined || project.value === null
      ? null
      : `${kinMoneyText(project.value)}${project.billing === "retainer" ? " a period" : ""}`,
    project.startsOn === undefined || project.startsOn === null
      ? null
      : target === null
        ? `From ${dayText(project.startsOn)}`
        : `${dayText(project.startsOn)} to ${target}`,
    project.renewsOn === undefined || project.renewsOn === null
      ? null
      : `Renews ${dayText(project.renewsOn)}`,
  ].filter((part) => part !== null && part !== undefined);
  return parts.length === 0 ? null : parts.join(" · ");
}

function kinMilestoneView(
  milestone: NonNullable<KinProjectPage["milestones"]>[number],
  names: KinWorkNames,
  now: Date,
): KinMilestoneView {
  const due = kinWorkDueText(milestone, names, now);
  const tone =
    milestone.state === "done"
      ? "done"
      : milestone.late
        ? "late"
        : milestone.atRisk
          ? "at_risk"
          : null;
  return {
    key: milestone.key,
    title: milestone.title,
    line: [
      milestone.total === 0 ? "No tasks yet" : `${milestone.done} of ${milestone.total} done`,
      due === null ? null : `due ${due}`,
      milestone.state === "dropped" ? "dropped" : null,
    ]
      .filter((part) => part !== null)
      .join(" · "),
    progress: milestone.total === 0 ? 0 : milestone.done / milestone.total,
    tone,
    badge:
      tone === "done" ? "Done" : tone === "late" ? "Late" : tone === "at_risk" ? "At risk" : null,
  };
}

export function kinProjectPageView(
  page: KinProjectPage,
  names: KinWorkNames,
  now: Date,
): KinProjectPageView {
  const { project, counts } = page;
  const ref = { key: project.key, title: project.name };
  const because = project.healthBecause;
  const why =
    project.health === null
      ? []
      : [
          because.targetPassed ? "The target date has passed." : null,
          because.late > 0
            ? `${plural(because.late, "task")} ${because.late === 1 ? "is" : "are"} late.`
            : null,
          because.waitingOverAWeek > 0
            ? `${plural(because.waitingOverAWeek, "task")} ${because.waitingOverAWeek === 1 ? "has" : "have"} waited more than a week.`
            : null,
        ].filter((part) => part !== null);
  const target = kinWorkDueText(
    { dueAt: project.targetAt, dueAllDay: project.targetAllDay },
    names,
    now,
  );
  const ledBy = kinWorkName(project.owner, names);
  const notes = project.notes.trim();
  const more = page.changedThisWeek.total - page.changedThisWeek.items.length;
  return {
    key: project.key,
    rev: project.rev,
    ref,
    name: project.name,
    party: project.party === null ? null : { key: project.party.key, title: project.party.title },
    state: project.state,
    closed: PROJECT_CLOSED[project.state],
    health: project.health === null ? null : HEALTH[project.health],
    why: why.length === 0 && project.health !== null ? ["Nothing is late or stuck."] : why,
    target: target === null ? KIN_PROJECTS.noTarget : `Target ${target}`,
    targetDay: kinWorkAllDay(project.targetAt, project.targetAllDay, names),
    ledBy: ledBy === "You" ? null : `Led by ${ledBy}`,
    lead: {
      name: ledBy,
      personId: project.owner._tag === "person" ? project.owner.personId : null,
    },
    privacy: project.sensitiveInherited
      ? kinWorkPrivacy({
          sensitive: project.sensitive,
          inherited: true,
          because: project.party?.title ?? "its client",
        })
      : {
          private: project.sensitive,
          inherited: false,
          note: project.sensitive ? KIN_PROJECTS.privateOn : KIN_PROJECTS.privateOff,
        },
    counts: [
      `${counts.open} not started`,
      `${counts.doing} in progress`,
      `${counts.waiting} waiting`,
      `${counts.done} done`,
      counts.dropped > 0 ? `${counts.dropped} dropped` : null,
    ]
      .filter((part) => part !== null)
      .join(" · "),
    blocked: page.blocked.map((row) => ({
      key: row.record.key,
      title: row.record.title,
      line: [
        row.on === null
          ? "Waiting"
          : `Waiting on ${row.on._tag === "party" ? row.on.title : kinWorkName(row.on, names, "you")}`,
        waited(row.since, now),
      ].join(" "),
    })),
    nextDue:
      page.nextDue === null
        ? null
        : kinWorkRow(page.nextDue, names, now, { party: null, project: ref }),
    pullRequests: page.pullRequests.map((pull) => ({
      key: pull.url,
      label: `PR #${pull.number}`,
      title: pull.record.title,
      href: kinLinkToOpen(pull.url),
      task: pull.record.key,
    })),
    changed: kinWorkTimeline(page.changedThisWeek.items, names, now, project.key),
    changedMore: more > 0 ? `and ${more} more` : null,
    repos: project.repos,
    notes: notes === "" ? null : notes,
    terms: projectTerms(project, target),
    milestones: (page.milestones ?? []).map((one) => kinMilestoneView(one, names, now)),
    changesPeople: page.can?.people === true,
    people: (page.people ?? []).map((one) => ({
      key: kinWorkPrincipalKey(one.who),
      who: one.who,
      name: kinWorkName(one.who, names),
      avatar: kinWorkAvatar(one.who),
      member: one.member && !one.lead,
      onIt: one.member || one.lead,
      line: [
        one.lead ? "Lead" : one.member ? "Member" : null,
        one.open === 0
          ? "nothing open"
          : `${one.open} open${one.late > 0 ? `, ${one.late} late` : ""}`,
      ]
        .filter((part) => part !== null)
        .join(" · "),
    })),
    meetings: (page.meetings ?? []).map((one) =>
      kinWorkRow(one, names, now, { party: null, project: ref }),
    ),
    specChanged: (page.specChanged ?? []).map((one) => ({
      key: one.record.key,
      title: one.record.title,
      line: `${one.doc.title} · ${one.section} section ${one.gone ? "was removed" : "changed"}`,
      doc: one.doc.key,
    })),
    money:
      page.money === undefined
        ? []
        : (
            [
              ["Quoted", page.money.quoted],
              ["Invoiced", page.money.invoiced],
              ["Received", page.money.received],
              ["Unpaid", page.money.unpaid],
            ] as const
          ).flatMap(([label, sums]) =>
            sums.length === 0
              ? []
              : [{ label, value: sums.map((money) => kinMoneyText(money)).join(" + ") }],
          ),
  };
}

/** Every key a project page shows something of. Its other tasks are asked about, not held. */
export const kinProjectPageKeys = (page: KinProjectPage): ReadonlySet<string> =>
  new Set([
    page.project.key,
    ...(page.project.party === null ? [] : [page.project.party.key]),
    ...page.blocked.map((row) => row.record.key),
    ...(page.nextDue === null ? [] : [page.nextDue.key]),
    ...page.pullRequests.map((pull) => pull.record.key),
    ...page.changedThisWeek.items.map((item) => item.record.key),
    ...(page.milestones ?? []).map((one) => one.key),
    ...(page.meetings ?? []).map((one) => one.key),
    ...(page.specChanged ?? []).map((one) => one.record.key),
  ]);

/**
 * What a new task may be put under for this viewer, as the host's `teamRule` takes it: anything
 * for the owner level; for a teammate the projects they lead, and the clients they see once their
 * Clients switch is on. Before the host has said (`me` null), or a host that sends no `leads`,
 * offers all and lets the host refuse.
 */
export function kinNewTaskChoices<C, P extends { readonly key: KinRecordKey }>(
  choices: { readonly clients: ReadonlyArray<C>; readonly projects: ReadonlyArray<P> },
  me: Pick<KinAccessMeResult, "access" | "leads" | "places"> | null,
): { readonly clients: ReadonlyArray<C>; readonly projects: ReadonlyArray<P> } {
  if (me === null || kinOwnerLevel(me.access) || me.leads === undefined) return choices;
  const led = new Set(me.leads.map((project) => project.key));
  return {
    // With Clients on, a teammate sets any client they see on their own task.
    clients: me.places?.clients === true ? choices.clients : [],
    projects: choices.projects.filter((project) => led.has(project.key)),
  };
}

/** A client or project as a filter, a form or a picker holds it. */
export const kinWorkRefOf = (row: {
  readonly key: KinRecordKey;
  readonly name: string;
}): KinWorkRef => ({ key: row.key, title: row.name });

/** Each project's client by project key, for "Client stays" on a moved task (`kinWorkClientStays`). */
export const kinProjectClients = (
  rows: ReadonlyArray<Pick<KinProjectRow, "key" | "party">>,
): ReadonlyMap<string, string | null> =>
  new Map(rows.map((row) => [row.key, row.party?.key ?? null]));

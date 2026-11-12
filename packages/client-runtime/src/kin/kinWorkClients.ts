// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import type {
  KinContact,
  KinOrgId,
  KinPartiesInput,
  KinPartyPage,
  KinPartyRow,
  KinProjectHealth,
  KinProjectPage,
  KinProjectRow,
  KinProjectState,
  KinProjectsInput,
  KinRecordKey,
  KinWorkHistoryItem,
} from "@t3tools/contracts";

import { kinLinkToOpen } from "./kinChatFeed.ts";
import { formatKinTime } from "./kinScreenState.ts";
import {
  kinWorkAllDay,
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

export const KIN_CLIENTS = {
  title: "Clients",
  all: "All clients",
  search: "Search clients",
  add: "New client",
  loadFailed: "Couldn't load your clients",
  weOwe: "We owe them",
  theyOwe: "They owe us",
  addWeOwe: "Add what we owe",
  addTheyOwe: "Add what they owe",
  nothingOwed: "Nothing owed to them right now.",
  nothingOwing: "They owe nothing right now.",
  contacts: "Contacts",
  addContact: "Add contact",
  noContacts: "No one yet. Add who you deal with there.",
  projects: "Projects",
  noProjects: "No projects for them yet.",
  terms: "Terms",
  noTerms: "No terms noted.",
  termsPrivate: "Always private. Only you see the terms.",
  detailsPrivate: "Emails and phone numbers are always private.",
  notes: "Notes",
  noNotes: "No notes.",
  history: "History",
  noHistory: "Nothing has happened yet.",
  earlier: "Show earlier",
  edit: "Edit",
  close: "Close client",
  reopen: "Reopen",
  closed: "Closed",
  privateLabel: "Keep private",
  privateOn: "Private. Only you see this client, its projects and what's owed.",
  privateOff: "Your team will be able to see this client. Terms and contact details stay private.",
};

export const KIN_CLIENT_GONE = {
  title: "This client isn't here any more",
  detail: "Open Clients to see who there is now.",
};
export const KIN_CLIENT_FAILED = {
  title: "Couldn't load this client",
  detail: "Check your connection to the server and try again.",
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
};

export const KIN_PROJECT_GONE = {
  title: "This project isn't here any more",
  detail: "Open Projects to see what there is now.",
};
export const KIN_PROJECT_FAILED = {
  title: "Couldn't load this project",
  detail: "Check your connection to the server and try again.",
};

/** What a server from before clients and projects is told, instead of an error. */
export const KIN_CLIENTS_OLDER_HOST = {
  title: "Your server needs an update",
  detail: "Clients and projects come with the next version. Tasks work as before.",
};

// The parts of Work

export type KinWorkArea = "tasks" | "clients" | "projects" | "docs" | "money" | "lists";

export const KIN_WORK_AREAS: ReadonlyArray<{ readonly id: KinWorkArea; readonly label: string }> = [
  { id: "tasks", label: "Tasks" },
  { id: "clients", label: KIN_CLIENTS.title },
  { id: "projects", label: KIN_PROJECTS.title },
  { id: "docs", label: "Docs" },
  { id: "money", label: "Money" },
  { id: "lists", label: "Lists" },
];

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

// Clients

/** What the clients list shows: who is active, or who was closed, optionally matching words. */
export interface KinClientsFilter {
  readonly closed: boolean;
  readonly text: string;
}

export const KIN_CLIENTS_DEFAULT_FILTER: KinClientsFilter = { closed: false, text: "" };

export const kinClientsSameFilter = (a: KinClientsFilter, b: KinClientsFilter) =>
  a.closed === b.closed && a.text.trim() === b.text.trim();

export function kinClientsQuery(
  orgId: KinOrgId,
  filter: KinClientsFilter,
): Omit<KinPartiesInput, "cursor" | "limit"> {
  const text = filter.text.trim().slice(0, 200);
  return {
    orgId,
    ...(filter.closed ? { active: false } : {}),
    ...(text === "" ? {} : { text }),
  };
}

type Owed = Pick<KinPartyRow, "weOwe" | "theyOwe" | "late" | "overdue">;

/** "We owe 2 (1 late) · They owe 1 (1 overdue)", or "Nothing open". */
function kinOwedLine(owed: Owed): string {
  const parts = [
    owed.weOwe > 0 ? `We owe ${owed.weOwe}${owed.late > 0 ? ` (${owed.late} late)` : ""}` : null,
    owed.theyOwe > 0
      ? `They owe ${owed.theyOwe}${owed.overdue > 0 ? ` (${owed.overdue} overdue)` : ""}`
      : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Nothing open" : parts.join(" · ");
}

export interface KinClientRowView {
  readonly key: KinRecordKey;
  readonly name: string;
  /** "Vendor · We owe 2 (1 late) · They owe 1". */
  readonly line: string;
  /** "Next: Monthly report, Fri 14 Nov"; null with nothing owed to them. */
  readonly next: string | null;
  /** Something either side owes is past its date. */
  readonly late: boolean;
  readonly private: boolean;
  readonly closed: boolean;
  readonly accessibilityLabel: string;
}

export function kinClientRow(row: KinPartyRow, names: KinWorkNames, now: Date): KinClientRowView {
  const line = [row.kind === "vendor" ? "Vendor" : null, row.active ? kinOwedLine(row) : "Closed"]
    .filter((part) => part !== null)
    .join(" · ");
  const day = row.next === null ? null : kinWorkDueText(row.next, names, now);
  const next =
    row.next === null
      ? null
      : `${row.next.late ? "Late" : "Next"}: ${row.next.title}${day === null ? "" : `, ${row.next.late ? "was due " : ""}${day}`}`;
  const late = row.late > 0 || row.overdue > 0;
  return {
    key: row.key,
    name: row.name,
    line,
    next,
    late,
    private: row.sensitive,
    closed: !row.active,
    accessibilityLabel: [row.name, line, next, row.sensitive ? "Private" : null]
      .filter((part) => part !== null)
      .join(". "),
  };
}

/** Why the clients list shows nothing, and whether to offer a new client. */
export function kinClientsNothing(filter: KinClientsFilter): {
  readonly title: string;
  readonly detail: string;
  readonly offerNew: boolean;
} {
  const text = filter.text.trim();
  if (text !== "")
    return { title: `Nothing matches “${text}”`, detail: "Try another name.", offerNew: false };
  if (filter.closed)
    return {
      title: "No closed clients",
      detail: "A client you close shows up here, with its history.",
      offerNew: false,
    };
  return {
    title: "No clients yet",
    detail:
      "Add a client or vendor to keep track of what you owe them and what they owe you. Or paste a contract into a chat with an agent and ask it to set the client up.",
    offerNew: true,
  };
}

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

export interface KinClientPageView {
  readonly key: KinRecordKey;
  readonly rev: number;
  readonly ref: KinWorkRef;
  readonly name: string;
  readonly vendor: boolean;
  /** "Client", "Vendor · Closed", "Client · Looked after by Tech lead". */
  readonly line: string;
  readonly closed: boolean;
  readonly privacy: KinWorkPrivacy;
  readonly weOwe: KinOwedView;
  readonly theyOwe: KinOwedView;
  readonly projects: ReadonlyArray<KinProjectRowView>;
  readonly contacts: ReadonlyArray<KinContactView>;
  readonly terms: string | null;
  readonly address: string | null;
  readonly notes: string | null;
}

export function kinClientPageView(
  page: KinPartyPage,
  names: KinWorkNames,
  now: Date,
): KinClientPageView {
  const { party } = page;
  const ref = { key: party.key, title: party.name };
  const owed = (side: KinPartyPage["weOwe"]): KinOwedView => ({
    rows: side.records.map((record) =>
      kinWorkRow(record, names, now, { party: ref, project: null, sided: true }),
    ),
    total: side.total,
    more: side.total > side.records.length ? `See all ${side.total}` : null,
  });
  const lookedAfter = kinWorkName(party.owner, names);
  const notes = party.notes.trim();
  const terms = party.terms?.trim() ?? "";
  return {
    key: party.key,
    rev: party.rev,
    ref,
    name: party.name,
    vendor: party.kind === "vendor",
    line: [
      party.kind === "vendor" ? "Vendor" : "Client",
      party.active ? null : KIN_CLIENTS.closed,
      lookedAfter === "You" ? null : `Looked after by ${lookedAfter}`,
    ]
      .filter((part) => part !== null)
      .join(" · "),
    closed: !party.active,
    privacy: {
      private: party.sensitive,
      inherited: false,
      note: party.sensitive ? KIN_CLIENTS.privateOn : KIN_CLIENTS.privateOff,
    },
    weOwe: owed(page.weOwe),
    theyOwe: owed(page.theyOwe),
    projects: page.projects.map((row) => kinProjectRow(row, names, now, ref)),
    contacts: page.contacts.map(kinContactView),
    terms: terms === "" ? null : terms,
    address: party.address?.trim() || null,
    notes: notes === "" ? null : notes,
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
  /** "Acme · 5 open · 1 late · Target Fri 14 Nov". */
  readonly line: string;
  readonly private: boolean;
  readonly accessibilityLabel: string;
}

export function kinProjectRow(
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
    PROJECT_CLOSED[row.state],
    row.state === "open" ? `${row.open} open` : null,
    row.late > 0 ? `${row.late} late` : null,
    target === null || row.state !== "open" ? null : `Target ${target}`,
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
export function kinProjectsNothing(filter: KinProjectsFilter): {
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
  return {
    title: "No projects yet",
    detail:
      "Add a project to see at a glance how it's going, what's blocked and what's due next. Or ask an agent to break a piece of work into tasks.",
    offerNew: true,
  };
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
    text: kinWorkChangeText(item, names, now, item.record.list),
    about: item.record.key === own ? null : item.record.title,
    task: item.record.list === "work" ? item.record.key : null,
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
  ]);

/** A client or project as a filter, a form or a picker holds it. */
export const kinWorkRefOf = (row: {
  readonly key: KinRecordKey;
  readonly name: string;
}): KinWorkRef => ({ key: row.key, title: row.name });

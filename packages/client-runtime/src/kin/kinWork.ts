// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import {
  EnvironmentAuthorizationError,
  KinChatError,
  type EnvironmentId,
  type KinChatId,
  type KinOrgId,
  type KinOrgsListResult,
  type KinPerson,
  type KinPersonId,
  type KinRecord,
  type KinRecordChange,
  type KinRecordDetail,
  type KinRecordKey,
  type KinRecordLink,
  type KinRecordSide,
  type KinRecordState,
  type KinWorkActor,
  type KinWorkAssignInput,
  type KinWorkCreateInput,
  type KinWorkListInput,
  type KinWorkPrincipal,
  type KinWorkSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import { kinRetiredAgentIds } from "./kinAgentRetire.ts";
import { kinLinkToOpen } from "./kinChatFeed.ts";
import { formatKinTime, kinAgentAvatar, type KinAvatarView } from "./kinScreenState.ts";
import { kinPickablePeople } from "./kinTeam.ts";
import type { KinWorkLive } from "./kinWorkStream.ts";

export const KIN_WORK_TITLE = "Work";
export const KIN_WORK_NEW = "New task";
export const KIN_WORK_SEARCH_PLACEHOLDER = "Search tasks";
export const KIN_WORK_LOAD_FAILED = "Couldn't load Work";
export const KIN_WORK_STALE = "Offline. Showing the last update.";
export const KIN_WORK_REFRESH_FAILED = "Couldn't refresh. Showing the last update.";
export const KIN_WORK_ONLY_OWNER = {
  title: "Only the owner can open this",
  detail: "Work is shown to the person who runs this workspace for now.",
};
export const KIN_WORK_OFFLINE = {
  title: "You're offline",
  detail: "Work comes back when the connection does.",
};
export const KIN_WORK_GONE = {
  title: "This task isn't here any more",
  detail: "Open Work to see what there is now.",
};
export const KIN_WORK_ITEM_FAILED = {
  title: "Couldn't load this task",
  detail: "Check your connection to the server and try again.",
};
export const KIN_WORK_TITLE_MAX = 280;
export const KIN_WORK_NOTES_MAX = 4_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Who is who

/** Names for the people and leads Work mentions, and which person is looking. */
export interface KinWorkNames {
  readonly people: ReadonlyMap<string, string>;
  readonly agents: ReadonlyMap<string, string>;
  /** Agents the host marks retired: named as before, with nothing running. Absent reads as none. */
  readonly retired?: ReadonlySet<string>;
  readonly me: KinPersonId | null;
  /** The owner's time zone, where an all-day due date is a calendar day. Null until read. */
  readonly zone: string | null;
}

export function kinWorkNames(input: {
  readonly orgs: KinOrgsListResult | null;
  readonly orgId: KinOrgId;
  readonly people: ReadonlyArray<KinPerson> | null;
  readonly zone: string | null;
}): KinWorkNames {
  const org = input.orgs?.orgs.find((held) => held.orgId === input.orgId);
  return {
    people: new Map((input.people ?? []).map((person) => [person.personId, person.displayName])),
    agents: new Map((org?.agents ?? []).map((agent) => [agent.agentId, agent.displayName])),
    retired: kinRetiredAgentIds(input.orgs, input.orgId),
    me: input.orgs?.me.find((me) => me.orgId === input.orgId)?.personId ?? null,
    zone: input.zone,
  };
}

export const kinWorkPrincipalKey = (who: KinWorkPrincipal): string =>
  who._tag === "person" ? `person:${who.personId}` : `agent:${who.agentId}`;

export const kinWorkSamePrincipal = (a: KinWorkPrincipal | null, b: KinWorkPrincipal | null) =>
  a !== null && b !== null && kinWorkPrincipalKey(a) === kinWorkPrincipalKey(b);

const isMe = (who: KinWorkPrincipal, names: KinWorkNames) =>
  who._tag === "person" && who.personId === names.me;

/** "You", a name, or a plain stand-in for someone the directory no longer lists. */
export function kinWorkName(who: KinWorkPrincipal, names: KinWorkNames, you = "You"): string {
  if (who._tag === "agent") return names.agents.get(who.agentId) ?? "An agent";
  return isMe(who, names) ? you : (names.people.get(who.personId) ?? "A teammate");
}

/** The task's holder is an agent its owner retired, so nobody is doing it. */
const kinWorkRetired = (who: KinWorkPrincipal, names: KinWorkNames): boolean =>
  who._tag === "agent" && names.retired?.has(who.agentId) === true;

const kinWorkAvatar = (who: KinWorkPrincipal): KinAvatarView =>
  who._tag === "agent"
    ? kinAgentAvatar(who.agentId)
    : { kind: "person", seed: `person:${who.personId}` };

// Filters

export type KinWorkViewId = "open" | "doing" | "waiting" | "late" | "week" | "closed";

/** A client or project by its handle and its name, as a filter or a form holds it. */
export interface KinWorkRef {
  readonly key: KinRecordKey;
  readonly title: string;
}

/**
 * What the list shows: one view, optionally one person's or lead's, one client's or one
 * project's, optionally matching words.
 */
export interface KinWorkFilter {
  readonly view: KinWorkViewId;
  readonly owner: KinWorkPrincipal | null;
  readonly text: string;
  readonly party: KinWorkRef | null;
  readonly project: KinWorkRef | null;
}

export const KIN_WORK_DEFAULT_FILTER: KinWorkFilter = {
  view: "open",
  owner: null,
  text: "",
  party: null,
  project: null,
};

const VIEWS: ReadonlyArray<{ readonly id: KinWorkViewId; readonly label: string }> = [
  { id: "open", label: "Open" },
  { id: "doing", label: "In progress" },
  { id: "waiting", label: "Waiting" },
  { id: "late", label: "Late" },
  { id: "week", label: "Due this week" },
  { id: "closed", label: "Closed" },
];

export const kinWorkSameFilter = (a: KinWorkFilter, b: KinWorkFilter) =>
  a.view === b.view &&
  a.text.trim() === b.text.trim() &&
  (a.party?.key ?? null) === (b.party?.key ?? null) &&
  (a.project?.key ?? null) === (b.project?.key ?? null) &&
  (a.owner === null ? b.owner === null : kinWorkSamePrincipal(a.owner, b.owner));

/**
 * This host takes the owner's changes and the newer filters. An older one sends no closed count,
 * so the screens show it what it can do and nothing else.
 */
export const kinWorkHostEdits = (summary: KinWorkSummary | null): boolean =>
  summary?.closed !== undefined;

/** This host keeps clients and projects. An older one sends neither, so nothing offers them. */
export const kinWorkHostClients = (summary: KinWorkSummary | null): boolean =>
  summary?.parties !== undefined;

/**
 * The host's query for a filter. "Due this week" is asked as of `nowMs`, like the host's count;
 * a host with the newer filters leaves out what is already late, so pages come back whole.
 */
export function kinWorkListQuery(
  orgId: KinOrgId,
  filter: KinWorkFilter,
  nowMs: number,
  hostFilters: boolean,
): Omit<KinWorkListInput, "cursor" | "limit"> {
  const text = filter.text.trim().slice(0, 200);
  const view: Omit<KinWorkListInput, "orgId"> =
    filter.view === "doing"
      ? { states: ["doing"] }
      : filter.view === "waiting"
        ? { states: ["waiting"] }
        : filter.view === "late"
          ? { late: true }
          : filter.view === "week"
            ? {
                open: true,
                dueBy: new Date(nowMs + WEEK_MS).toISOString(),
                ...(hostFilters ? { late: false } : {}),
              }
            : { open: filter.view === "open" };
  return {
    orgId,
    ...view,
    ...(filter.owner === null ? {} : { owner: filter.owner }),
    ...(filter.party === null ? {} : { party: filter.party.key }),
    ...(filter.project === null ? {} : { project: filter.project.key }),
    ...(text === "" ? {} : { text }),
  };
}

/**
 * The rows a view shows of what the host returned. An older host's "due by" also returns what is
 * already late, which "Due this week" doesn't count, so those are left to the Late view.
 */
export const kinWorkShown = (
  filter: KinWorkFilter,
  records: ReadonlyArray<KinRecord>,
  hostFilters: boolean,
): ReadonlyArray<KinRecord> =>
  filter.view === "week" && !hostFilters ? records.filter((record) => !record.late) : records;

// The overview: counts by view and by owner

export interface KinWorkChip {
  readonly id: KinWorkViewId;
  readonly label: string;
  /** Null where the host sends no count: closed work on an older host, or one owner's. */
  readonly count: number | null;
  readonly selected: boolean;
  readonly accessibilityLabel: string;
}

export interface KinWorkOwnerView {
  readonly key: string;
  readonly owner: KinWorkPrincipal;
  readonly name: string;
  readonly avatar: KinAvatarView;
  readonly open: number;
  /** "5 open · 1 late · 2 waiting". */
  readonly line: string;
  readonly selected: boolean;
}

export interface KinWorkOverview {
  readonly chips: ReadonlyArray<KinWorkChip>;
  /** Everyone with open work, most first. */
  readonly owners: ReadonlyArray<KinWorkOwnerView>;
}

type Counts = Pick<
  KinWorkSummary,
  "open" | "doing" | "waiting" | "late" | "dueThisWeek" | "closed"
>;
const NO_COUNTS: Counts = { open: 0, doing: 0, waiting: 0, late: 0, dueThisWeek: 0 };

const countFor = (counts: Counts, view: KinWorkViewId): number | null =>
  view === "open"
    ? counts.open
    : view === "doing"
      ? counts.doing
      : view === "waiting"
        ? counts.waiting
        : view === "late"
          ? counts.late
          : view === "week"
            ? counts.dueThisWeek
            : (counts.closed ?? null);

const ownerLine = (counts: Counts) =>
  [
    `${counts.open} open`,
    counts.late > 0 ? `${counts.late} late` : null,
    counts.waiting > 0 ? `${counts.waiting} waiting` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

export function kinWorkOverview(
  summary: KinWorkSummary | null,
  filter: KinWorkFilter,
  names: KinWorkNames,
): KinWorkOverview {
  const { owner } = filter;
  // The host counts by owner, not by client or project, so a narrowed list shows no counts.
  const counts: Counts | null =
    summary === null || filter.party !== null || filter.project !== null
      ? null
      : owner === null
        ? summary
        : (summary.owners.find((row) => kinWorkSamePrincipal(row.owner, owner)) ?? NO_COUNTS);
  return {
    chips: VIEWS.map((view) => {
      const count = counts === null ? null : countFor(counts, view.id);
      return {
        id: view.id,
        label: view.label,
        count,
        selected: filter.view === view.id,
        accessibilityLabel: count === null ? view.label : `${view.label}, ${count}`,
      };
    }),
    owners: (summary?.owners ?? []).map((row) => ({
      key: kinWorkPrincipalKey(row.owner),
      owner: row.owner,
      name: kinWorkName(row.owner, names),
      avatar: kinWorkAvatar(row.owner),
      open: row.open,
      line: ownerLine(row),
      selected: kinWorkSamePrincipal(row.owner, owner),
    })),
  };
}

/** The second line of the way in: what most needs a look. */
export function kinWorkEntrySummary(summary: KinWorkSummary | null): string {
  if (summary === null) return "What you and your agents are working on";
  if (summary.open === 0) return "Nothing open";
  const parts = [
    summary.late > 0 ? `${summary.late} late` : null,
    summary.waiting > 0 ? `${summary.waiting} waiting` : null,
    summary.dueThisWeek > 0 ? `${summary.dueThisWeek} due this week` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? `${summary.open} open` : parts.join(" · ");
}

// What a screen reading Work shows

export type KinWorkScreenState =
  | { readonly _tag: "refused" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "offline" }
  | { readonly _tag: "failed" }
  | {
      readonly _tag: "ready";
      readonly live: KinWorkLive;
      /** What is shown may be behind: the connection is down or the last read failed. */
      readonly stale: boolean;
    };

export const isKinChatError = Schema.is(KinChatError);
export const isKinWorkAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isAuthorizationError = isKinWorkAuthorizationError;

/** The host said this viewer may not read Work. */
export const kinWorkRefused = (error: unknown): boolean =>
  isAuthorizationError(error) || (isKinChatError(error) && error.reason === "not_allowed");

export const kinWorkFailuresOf = (cause: Cause.Cause<unknown>) =>
  cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);

export function kinWorkScreenState(input: {
  /** This session holds the scope to read Work at all. */
  readonly allowed: boolean;
  readonly connected: boolean;
  readonly live: AsyncResult.AsyncResult<KinWorkLive, unknown>;
}): KinWorkScreenState {
  if (!input.allowed) return { _tag: "refused" };
  const { live } = input;
  if (AsyncResult.isFailure(live) && kinWorkFailuresOf(live.cause).some(kinWorkRefused))
    return { _tag: "refused" };
  const held = Option.getOrNull(AsyncResult.value(live));
  if (held === null || held.summary === null) {
    if (AsyncResult.isFailure(live) || held?.failed === true) return { _tag: "failed" };
    return input.connected ? { _tag: "loading" } : { _tag: "offline" };
  }
  return {
    _tag: "ready",
    live: held,
    stale: !input.connected || held.failed || AsyncResult.isFailure(live),
  };
}

// Rows

const STATE_LABEL: Record<KinRecordState, string> = {
  open: "Not started",
  doing: "In progress",
  waiting: "Waiting",
  done: "Done",
  dropped: "Dropped",
};

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const dayYearFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "today", "tomorrow", "yesterday", "Fri 14 Nov", or "14 Nov 2027" for another year. */
function kinWorkDay(date: Date, now: Date): string {
  const days = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return date.getFullYear() === now.getFullYear()
    ? dayFormat.format(date)
    : dayYearFormat.format(date);
}

const zoneDays = new Map<string, Intl.DateTimeFormat | null>();

/** The calendar day `date` falls on in `zone`, as that same day on this device. */
function dayInZone(date: Date, zone: string | null): Date {
  if (zone === null) return date;
  let format = zoneDays.get(zone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      format = null;
    }
    zoneDays.set(zone, format);
  }
  if (format === null) return date;
  const parts = format.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((held) => held.type === type)?.value);
  return new Date(part("year"), part("month") - 1, part("day"));
}

export const kinWorkDueText = (
  record: Pick<KinRecord, "dueAt" | "dueAllDay">,
  names: KinWorkNames,
  now: Date,
): string | null => {
  if (record.dueAt === null) return null;
  const due = new Date(record.dueAt);
  if (Number.isNaN(due.getTime())) return null;
  // An all-day date is a day where the owner is; a viewer elsewhere must not see the day after.
  if (record.dueAllDay) return kinWorkDay(dayInZone(due, names.zone), now);
  return `${kinWorkDay(due, now)}, ${clockFormat.format(due)}`;
};

const statusText = (record: KinRecord, names: KinWorkNames): string =>
  record.state === "waiting" && record.waitingOn !== null
    ? `Waiting on ${kinWorkName(record.waitingOn, names, "you")}`
    : STATE_LABEL[record.state];

export interface KinWorkRowView {
  readonly key: KinRecordKey;
  readonly title: string;
  readonly state: KinRecordState;
  /** "In progress", "Waiting on Priya", "Done". */
  readonly status: string;
  readonly owner: string;
  readonly ownerAvatar: KinAvatarView;
  /** "Due Fri 14 Nov"; null with no date or once it is closed. */
  readonly due: string | null;
  readonly late: boolean;
  /** A lead picked it up on its own and nobody has confirmed it. */
  readonly suggested: boolean;
  /**
   * What one tap on the row's mark does, where a tap changes nothing but the task: finish one a
   * person has, or reopen one. A lead's task is finished from the task itself, which says the
   * lead is told to stop.
   */
  readonly tick: "done" | "reopen" | null;
  /** A lead has something running on it right now. */
  readonly working: boolean;
  /** Its holder is a retired agent: the name still shows, with a quiet mark. */
  readonly ownerRetired: boolean;
  /** The client it is for, or its project with no client; null in a list of only theirs. */
  readonly about: string | null;
  /** "W-12 · Acme · Tech lead · In progress · Due Fri 14 Nov". */
  readonly line: string;
  readonly accessibilityLabel: string;
}

export const kinWorkClosed = (state: KinRecordState) => state === "done" || state === "dropped";

export function kinWorkRow(
  record: KinRecord,
  names: KinWorkNames,
  now: Date,
  /** What the list around the row already says, which the row needn't repeat. */
  within?: Pick<KinWorkFilter, "party" | "project"> & { readonly sided?: true },
): KinWorkRowView {
  const owner = kinWorkName(record.owner, names);
  // Inside a project the page already names its client, so its rows don't.
  const inProject = within?.project != null && record.project?.key === within.project.key;
  const about = inProject
    ? null
    : record.party !== undefined && record.party.key !== within?.party?.key
      ? record.party.title
      : record.project !== undefined &&
          record.project.key !== within?.project?.key &&
          record.party === undefined
        ? record.project.title
        : null;
  const status = record.working ? "Working on it now" : statusText(record, names);
  const day = kinWorkClosed(record.state) ? null : kinWorkDueText(record, names, now);
  const due = day === null ? null : `Due ${day}`;
  const ownerRetired = kinWorkRetired(record.owner, names);
  const parts = [
    record.key,
    about,
    ownerRetired ? `${owner} (retired)` : owner,
    record.side === "theirs" && !kinWorkClosed(record.state) && within?.sided !== true
      ? "They owe this"
      : null,
    status,
    due,
    record.pullRequest === null ? null : `PR #${record.pullRequest.number}`,
    record.confirmed || kinWorkClosed(record.state) ? null : "Suggested",
  ].filter((part) => part !== null);
  return {
    key: record.key,
    title: record.title,
    state: record.state,
    status,
    owner,
    ownerAvatar: kinWorkAvatar(record.owner),
    due,
    late: record.late,
    suggested: !record.confirmed && !kinWorkClosed(record.state),
    tick:
      record.owner._tag === "agent" || !record.confirmed
        ? null
        : kinWorkClosed(record.state)
          ? "reopen"
          : "done",
    working: record.working,
    ownerRetired,
    about,
    line: parts.join(" · "),
    accessibilityLabel: [record.title, ...parts.slice(1), record.late ? "Late" : null]
      .filter((part) => part !== null)
      .join(". "),
  };
}

/** "Showing 50 of 132", once there is more than one page. */
export function kinWorkListFooter(
  filter: KinWorkFilter,
  shown: number,
  total: number | null,
  more: boolean,
  hostFilters: boolean,
): string | null {
  if (!more) return null;
  // An older host's total for "due this week" also counts what is late, which this view hides.
  return total === null || (filter.view === "week" && !hostFilters)
    ? `Showing the first ${shown}`
    : `Showing ${shown} of ${total}`;
}

/** Why a filter shows nothing, in the filter's own words, and whether to offer a new task. */
export function kinWorkNothing(
  filter: KinWorkFilter,
  names: KinWorkNames,
): {
  readonly title: string;
  readonly detail: string;
  readonly offerNew: boolean;
} {
  const text = filter.text.trim();
  if (text !== "")
    return { title: `Nothing matches “${text}”`, detail: "Try another word.", offerNew: false };
  const person = filter.owner === null ? null : kinWorkName(filter.owner, names, "you");
  const scope = filter.project?.title ?? filter.party?.title ?? null;
  const who = person === null ? scope : scope === null ? person : `${person} on ${scope}`;
  // "Nothing is late" for everyone; "Nothing is late for Priya", "for Acme", "for Priya on Acme".
  const title = (words: string) => (who === null ? words : `${words} for ${who}`);
  switch (filter.view) {
    case "open":
      return {
        title: title("Nothing open"),
        detail:
          who === null
            ? "Add a task, or ask an agent in chat to keep track of something. Give one to an agent and it gets on with it."
            : person === null
              ? `Add a task for ${who}, or ask an agent to.`
              : `Tasks given to ${person} show up here.`,
        offerNew: true,
      };
    case "doing":
      return {
        title: title("Nothing in progress"),
        detail: who === null ? "Nobody has started on anything." : "Nothing has been started.",
        offerNew: false,
      };
    case "waiting":
      return {
        title: title("Nothing is waiting"),
        detail: "No one is blocked on anyone.",
        offerNew: false,
      };
    case "late":
      return {
        title: title("Nothing is late"),
        detail: "Everything with a date is on time.",
        offerNew: false,
      };
    case "week":
      return {
        title: title("Nothing due this week"),
        detail: "The next seven days are clear.",
        offerNew: false,
      };
    case "closed":
      return {
        title: title("Nothing closed yet"),
        detail: "Finished work shows up here.",
        offerNew: false,
      };
  }
}

// One task

export interface KinWorkLinkView {
  readonly key: string;
  readonly kind: "pull_request" | "worker" | "message" | "task" | "note" | "link";
  readonly label: string;
  readonly detail: string | null;
  /**
   * What a tap opens: a web page, the chat it came from, or another task. Null when it only names
   * something.
   */
  readonly open:
    | { readonly type: "url"; readonly href: string }
    | { readonly type: "chat"; readonly chatId: KinChatId }
    | { readonly type: "task"; readonly key: KinRecordKey }
    | null;
  /** The thread a lead's work ran in, where this device can open it the way a task card does. */
  readonly thread: { readonly environmentId: EnvironmentId; readonly threadId: string } | null;
}

/** Where the task is read from, to say which threads this device can open. */
export interface KinWorkPlace {
  /** The environment hosting Kin. */
  readonly environmentId: EnvironmentId;
  readonly isKnownEnvironment: (environmentId: EnvironmentId) => boolean;
}

export interface KinWorkHistoryLine {
  readonly key: string;
  /** "9:41" today, "7 Nov" otherwise. */
  readonly when: string;
  readonly text: string;
}

export interface KinWorkItemView {
  readonly key: KinRecordKey;
  readonly rev: number;
  /** "W-12", or "W-12 · Issue". */
  readonly heading: string;
  readonly title: string;
  readonly state: KinRecordState;
  readonly status: string;
  readonly late: boolean;
  readonly owner: {
    readonly principal: KinWorkPrincipal;
    readonly name: string;
    readonly avatar: KinAvatarView;
    readonly lead: boolean;
    /** A retired agent has it: said quietly beside the name. */
    readonly retired: boolean;
  };
  /** "Fri 14 Nov"; null with no date. */
  readonly due: string | null;
  /** "You gave this to Tech lead · Nov 7". */
  readonly given: string | null;
  /** Things worth a line of their own: unconfirmed, private, owed by the other side. */
  readonly remarks: ReadonlyArray<string>;
  readonly notes: string | null;
  readonly links: ReadonlyArray<KinWorkLinkView>;
  readonly history: ReadonlyArray<KinWorkHistoryLine>;
  /** Shown under the history when the host cut it short. */
  readonly historyNote: string | null;
  /** Null once the task is done or dropped: there is nothing left to hand on. */
  readonly assignLabel: string | null;
  /** The host takes changes to this task. False on an older host, which only reads and assigns. */
  readonly editable: boolean;
  readonly closed: boolean;
  /** "Tech lead suggested this task."; null once someone has kept it. */
  readonly suggestion: string | null;
  /** Someone else has it and it is open, so the owner can take it back. */
  readonly takeBack: boolean;
  /** What changing it does to the lead that has it, said beside the buttons that do it. */
  readonly leadNote: string | null;
  /** Its all-day due date as `YYYY-MM-DD`; null with no date or a timed one. */
  readonly dueDay: string | null;
  readonly waitingOn: KinWorkPrincipal | null;
  /** The client or vendor it is for, and its project; null with none. */
  readonly party: KinWorkRef | null;
  readonly project: KinWorkRef | null;
  /** Who has to do it. Only worth showing with a client. */
  readonly side: KinRecordSide;
  /** Whether it is kept to the owner, and whether that is its own label to change. */
  readonly privacy: KinWorkPrivacy;
}

/** How private something is, and what to say about it beside the label. */
export interface KinWorkPrivacy {
  readonly private: boolean;
  /** Its client or project makes it private, so its own label changes nothing. */
  readonly inherited: boolean;
  readonly note: string;
}

export const KIN_WORK_PRIVATE = "Private";

export function kinWorkPrivacy(input: {
  readonly sensitive: boolean;
  readonly inherited: boolean;
  /** What makes it private when it is not its own label: "its client", "Acme". */
  readonly because: string;
}): KinWorkPrivacy {
  return {
    private: input.sensitive || input.inherited,
    inherited: input.inherited,
    note: input.inherited
      ? `Private because ${input.because} is.`
      : input.sensitive
        ? "Only you see this."
        : "Your team will be able to see this.",
  };
}

const CATEGORY_LABEL = { task: null, issue: "Issue", obligation: "Commitment" } as const;

const kinWorkActorName = (actor: KinWorkActor, names: KinWorkNames) =>
  actor._tag === "system" ? "Kin" : kinWorkName(actor, names);

const principalFromText = (text: string | null): KinWorkPrincipal | null => {
  if (text === null) return null;
  const split = text.indexOf(":");
  const id = text.slice(split + 1);
  if (split < 0 || id === "") return null;
  const kind = text.slice(0, split);
  // Ids arrive as the host wrote them into the history; they are only looked up by name here.
  return kind === "person"
    ? ({ _tag: "person", personId: id } as KinWorkPrincipal)
    : kind === "agent"
      ? ({ _tag: "agent", agentId: id } as KinWorkPrincipal)
      : null;
};

/** A due time from the history, as the day it is where the owner is, like the due date itself. */
const dayFromText = (text: string | null, now: Date, zone: string | null) => {
  if (text === null) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : kinWorkDay(dayInZone(date, zone), now);
};

const ADDED = {
  work: "added this",
  clients: "added this client",
  contacts: "added this contact",
  projects: "started this project",
} as const;

/**
 * One change in words. `list` says what changed: a task, or a client, contact or project, whose
 * closing and dates read differently.
 */
export function kinWorkChangeText(
  change: KinRecordChange,
  names: KinWorkNames,
  now: Date,
  list: keyof typeof ADDED = "work",
): string {
  const who = kinWorkActorName(change.by, names);
  const field = (name: string) => change.fields.find((held) => held.field === name);
  if (change.kind === "created") {
    return change.via === "import"
      ? "Brought over from your agents' notes"
      : `${who} ${ADDED[list]}`;
  }
  if (change.kind === "linked") {
    const link = change.fields[0];
    if (link?.field === "worker") return `${who} started work on it`;
    if (link?.field === "pull_request") return `${who} linked ${link.to ?? "a pull request"}`;
    return `${who} added a link`;
  }
  const clauses: Array<string> = [];
  const owner = field("owner");
  const to = principalFromText(owner?.to ?? null);
  if (to !== null) {
    clauses.push(
      change.by._tag !== "system" && kinWorkSamePrincipal(change.by, to)
        ? "took it on"
        : `gave it to ${kinWorkName(to, names, "you")}`,
    );
  }
  const state = field("state")?.to;
  const waitingOn = principalFromText(field("waitingOn")?.to ?? null);
  const reopened =
    (field("state")?.from === "done" || field("state")?.from === "dropped") &&
    state !== "done" &&
    state !== "dropped";
  if (reopened) clauses.push("reopened it");
  else if (state === "doing") clauses.push("started on it");
  // A client or a contact has no work to finish: it is closed.
  else if ((state === "done" || state === "dropped") && (list === "clients" || list === "contacts"))
    clauses.push("closed it");
  else if (state === "done") clauses.push("finished it");
  else if (state === "dropped") clauses.push("dropped it");
  else if (state === "open") clauses.push("put it back to not started");
  else if (state === "waiting" || waitingOn !== null)
    clauses.push(
      waitingOn === null
        ? "marked it waiting"
        : `marked it waiting on ${kinWorkName(waitingOn, names, "you")}`,
    );
  const due = field("due");
  if (due !== undefined) {
    const day = dayFromText(due.to, now, names.zone);
    clauses.push(
      day === null
        ? "took the date off"
        : list === "projects"
          ? `set the target to ${day}`
          : `set it due ${day}`,
    );
  }
  if (field("title") !== undefined) clauses.push("renamed it");
  if (field("notes") !== undefined) clauses.push("changed the notes");
  if (field("confirmed")?.to === "true") clauses.push("kept it");
  if (field("terms") !== undefined) clauses.push("changed the terms");
  if (["role", "email", "phone"].some((name) => field(name) !== undefined))
    clauses.push("changed their details");
  if (field("repos") !== undefined) clauses.push("changed its repos");
  const side = field("side")?.to;
  if (side === "theirs") clauses.push("marked it as theirs to do");
  else if (side === "ours") clauses.push("marked it as ours to do");
  const party = field("party");
  if (party !== undefined)
    clauses.push(party.to === null ? "took it off its client" : "put it under a client");
  const project = field("project");
  if (project !== undefined)
    clauses.push(project.to === null ? "took it out of its project" : "put it in a project");
  const sensitive = field("sensitive")?.to;
  if (sensitive === "true") clauses.push("made it private");
  else if (sensitive === "false") clauses.push("made it not private");
  // Clients keep their kind in the category field.
  const kind = list === "clients" ? field("category")?.to : undefined;
  if (kind === "vendor") clauses.push("marked them a vendor");
  else if (kind === "client") clauses.push("marked them a client");
  return `${who} ${clauses.length === 0 ? "updated it" : clauses.join(", ")}`;
}

function linkView(
  link: KinRecordLink,
  working: boolean,
  place: KinWorkPlace,
): KinWorkLinkView | null {
  const key = `${link.kind}:${link.target}`;
  switch (link.kind) {
    case "pull_request": {
      const href = kinLinkToOpen(link.target);
      return {
        key,
        kind: "pull_request",
        label: link.label ?? "Pull request",
        detail: null,
        open: href === null ? null : { type: "url", href },
        thread: null,
      };
    }
    case "worker": {
      const run = link.worker;
      const href = run?.pullRequest == null ? null : kinLinkToOpen(run.pullRequest.url);
      // A thread opens only where a task card would open it: on the host, or an environment known here.
      const environmentId = run?.remoteEnvironmentId ?? place.environmentId;
      const thread =
        run == null || run.threadId === null || !place.isKnownEnvironment(environmentId)
          ? null
          : { environmentId, threadId: run.threadId };
      return {
        key,
        kind: "worker",
        label: link.label ?? "Work an agent started",
        detail:
          (run?.running ?? working)
            ? "Running now"
            : run?.pullRequest == null
              ? null
              : `PR #${run.pullRequest.number}`,
        open: href === null ? null : { type: "url", href },
        thread,
      };
    }
    case "message":
      return link.chatId === null
        ? null
        : {
            key,
            kind: "message",
            label: "Where this came from",
            detail: "Open the chat",
            open: { type: "chat", chatId: link.chatId },
            thread: null,
          };
    case "record": {
      const other = link.record;
      return {
        key,
        kind: "task",
        label: other === undefined ? (link.label ?? "A related task") : other.title,
        detail:
          [other?.key ?? null, link.relation === "blocks" ? "Blocks this" : null]
            .filter((part) => part !== null)
            .join(" · ") || null,
        open: other === undefined ? null : { type: "task", key: other.key },
        thread: null,
      };
    }
    case "memory":
      return {
        key,
        kind: "note",
        label: "From what your agents remember",
        detail: null,
        open: null,
        thread: null,
      };
    case "url": {
      const href = kinLinkToOpen(link.target);
      return href === null
        ? null
        : {
            key,
            kind: "link",
            label: link.label ?? href,
            detail: null,
            open: { type: "url", href },
            thread: null,
          };
    }
  }
}

export function kinWorkItemView(
  item: KinRecordDetail,
  names: KinWorkNames,
  now: Date,
  changesCap: number,
  place: KinWorkPlace,
): KinWorkItemView {
  const row = kinWorkRow(item, names, now);
  const category = item.category === null ? null : CATEGORY_LABEL[item.category];
  const ownerName = kinWorkName(item.owner, names);
  const giver = item.assignedBy;
  const given =
    giver === null || kinWorkSamePrincipal(giver, item.owner)
      ? null
      : [
          `${kinWorkName(giver, names)} gave this to ${kinWorkName(item.owner, names, "you")}`,
          item.assignedAt === null ? null : formatKinTime(new Date(item.assignedAt), now),
        ]
          .filter((part) => part !== null)
          .join(" · ");
  // The latest link to one target says the most: "PR #12 merged" over "PR #12".
  const links = new Map<string, KinWorkLinkView>();
  for (const link of item.links) {
    const view = linkView(link, item.working, place);
    if (view !== null) links.set(view.key, view);
  }
  const notes = item.notes.trim();
  // Only a host that takes changes sends a task's own change number.
  const editable = item.seq !== undefined;
  const isClosed = kinWorkClosed(item.state);
  const suggested = !item.confirmed && !isClosed;
  const lead = item.owner._tag === "agent";
  return {
    key: item.key,
    rev: item.rev,
    heading: category === null ? item.key : `${item.key} · ${category}`,
    title: item.title,
    state: item.state,
    status: row.status,
    late: item.late,
    owner: {
      principal: item.owner,
      name: ownerName,
      avatar: row.ownerAvatar,
      lead: item.owner._tag === "agent",
      retired: row.ownerRetired,
    },
    due: kinWorkDueText(item, names, now),
    given,
    remarks: [
      // A host that can't take the answer here still takes it in chat.
      suggested && !editable
        ? "An agent picked this up on its own. Tell it in chat whether to keep it."
        : null,
      item.side === "theirs"
        ? `${item.party?.title ?? "The other side"} owes this. Whoever has it chases it.`
        : null,
    ].filter((part) => part !== null),
    notes: notes === "" ? null : notes,
    links: [...links.values()],
    history: item.changes.map((change) => ({
      key: String(change.seq),
      when: formatKinTime(new Date(change.at), now),
      text: kinWorkChangeText(change, names, now),
    })),
    historyNote: item.changes.length >= changesCap ? "Earlier history isn't shown." : null,
    assignLabel: isClosed ? null : "Give to someone else",
    editable,
    closed: isClosed,
    suggestion: suggested
      ? `${item.createdBy._tag === "agent" ? kinWorkActorName(item.createdBy, names) : "An agent"} suggested this task.`
      : null,
    takeBack: !isClosed && !isMe(item.owner, names),
    leadNote: !lead
      ? null
      : row.ownerRetired
        ? isClosed
          ? `${ownerName} is retired, so reopening leaves this with nobody working on it. Give it to someone else, or restore ${ownerName}.`
          : `${ownerName} is retired, so nobody is working on this. Give it to someone else, or restore ${ownerName}.`
        : isClosed
          ? `Reopening gives it back to ${ownerName} to do.`
          : `${ownerName} ${item.working ? "is working on this now" : "has this"}. Marking it done, dropping it or taking it back tells ${ownerName} to stop.`,
    dueDay: kinWorkAllDay(item.dueAt, item.dueAllDay, names),
    waitingOn: item.state === "waiting" ? item.waitingOn : null,
    party: item.party === undefined ? null : { key: item.party.key, title: item.party.title },
    project:
      item.project === undefined ? null : { key: item.project.key, title: item.project.title },
    side: item.side,
    privacy: kinWorkPrivacy({
      sensitive: item.sensitive,
      inherited: item.sensitiveInherited === true,
      because: "its client or project",
    }),
  };
}

/** An all-day date as `YYYY-MM-DD` where the owner is; null with no date or a timed one. */
export function kinWorkAllDay(at: string | null, allDay: boolean, names: KinWorkNames) {
  const date = at === null ? null : new Date(at);
  return date === null || !allDay || Number.isNaN(date.getTime())
    ? null
    : kinWorkDayOf(dayInZone(date, names.zone));
}

/** What a screen showing one task shows. */
export type KinWorkItemState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "gone" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly item: KinRecordDetail };

/**
 * `given` is the host's answer to the owner's last hand-over, shown until a read catches up
 * with it, so the new owner is on screen the moment the host says so.
 */
export function kinWorkItemState(
  result: AsyncResult.AsyncResult<KinRecordDetail, unknown>,
  given: KinRecordDetail | null,
): KinWorkItemState {
  const read = Option.getOrNull(AsyncResult.value(result));
  const item = given !== null && (read === null || given.rev >= read.rev) ? given : read;
  if (
    AsyncResult.isFailure(result) &&
    kinWorkFailuresOf(result.cause).some(
      (error) => isKinChatError(error) && error.reason === "not_found",
    )
  )
    return { _tag: "gone" };
  if (item !== null) return { _tag: "ready", item };
  return AsyncResult.isFailure(result) ? { _tag: "failed" } : { _tag: "loading" };
}

// Giving a task to someone

export interface KinWorkAssignee {
  readonly key: string;
  readonly principal: KinWorkPrincipal;
  readonly name: string;
  readonly avatar: KinAvatarView;
  /** It is theirs already. */
  readonly current: boolean;
  /** Re-invited and hasn't opened the new link: shown, not offered. */
  readonly invited?: true;
}

export const KIN_WORK_ASSIGN = {
  title: "Give this to",
  leads: "Agents",
  leadsHint: "An agent starts on it right away and tells you in your chat with it when it's done.",
  people: "People",
  /** A re-invited teammate who hasn't opened the new link yet. */
  invited: "Invited, hasn't joined yet",
};

/** Who a task can go to: the org's leads, then its people with the viewer first. */
export function kinWorkAssignees(input: {
  readonly orgs: KinOrgsListResult | null;
  readonly orgId: KinOrgId;
  readonly people: ReadonlyArray<KinPerson> | null;
  readonly names: KinWorkNames;
  readonly current: KinWorkPrincipal | null;
  /** People whose device still opens Kin; when given, others are offered only if they hold it now. */
  readonly joined?: ReadonlyArray<KinPersonId> | null;
  /** People re-invited who haven't opened the new link yet; listed as invited. */
  readonly invited?: ReadonlyArray<KinPersonId> | null;
}): {
  readonly leads: ReadonlyArray<KinWorkAssignee>;
  readonly people: ReadonlyArray<KinWorkAssignee>;
} {
  const { names, current } = input;
  const view = (principal: KinWorkPrincipal): KinWorkAssignee => ({
    key: kinWorkPrincipalKey(principal),
    principal,
    name: kinWorkName(principal, names),
    avatar: kinWorkAvatar(principal),
    current: kinWorkSamePrincipal(principal, current),
  });
  const org = input.orgs?.orgs.find((held) => held.orgId === input.orgId);
  const me = input.orgs?.me.find((held) => held.orgId === input.orgId)?.personId;
  const listed = (input.people ?? []).filter((person) => person.personId !== me);
  const isCurrent = (personId: KinPersonId) =>
    kinWorkSamePrincipal({ _tag: "person", personId }, current);
  const others =
    input.joined == null
      ? listed.map((person) => view({ _tag: "person", personId: person.personId }))
      : kinPickablePeople(
          listed,
          [
            ...input.joined,
            ...listed.flatMap((person) => (isCurrent(person.personId) ? [person.personId] : [])),
          ],
          input.invited ?? [],
        ).map(({ person, invited }) => {
          const shown = view({ _tag: "person", personId: person.personId });
          return invited ? { ...shown, invited: true as const } : shown;
        });
  return {
    leads: (org?.agents ?? [])
      .filter((agent) => !agent.retired)
      .map((agent) => view({ _tag: "agent", agentId: agent.agentId })),
    people: me === undefined ? others : [view({ _tag: "person", personId: me }), ...others],
  };
}

// Adding a task

export interface KinWorkDraft {
  readonly title: string;
  /** Null keeps it with the owner. */
  readonly owner: KinWorkPrincipal | null;
  /** A calendar day, `YYYY-MM-DD`; null for no date. */
  readonly due: string | null;
  readonly notes: string;
  readonly party: KinWorkRef | null;
  readonly project: KinWorkRef | null;
  /** `theirs` when the client owes it and the owner is whoever chases. */
  readonly side: KinRecordSide;
}

export const KIN_WORK_NO_DRAFT: KinWorkDraft = {
  title: "",
  owner: null,
  due: null,
  notes: "",
  party: null,
  project: null,
  side: "ours",
};

/** A form opened from a client or a project starts out about it. */
export const kinWorkDraftFor = (
  about: Partial<Pick<KinWorkDraft, "party" | "project" | "side">>,
): KinWorkDraft => ({ ...KIN_WORK_NO_DRAFT, ...about });

/** The form's name and its first field, which say whose move it is when a client is set. */
export function kinWorkDraftWords(draft: Pick<KinWorkDraft, "party" | "side">): {
  readonly title: string;
  readonly titleLabel: string;
  readonly titlePlaceholder: string;
} {
  if (draft.party === null)
    return {
      title: KIN_WORK_NEW,
      titleLabel: KIN_WORK_NEW_COPY.titleLabel,
      titlePlaceholder: KIN_WORK_NEW_COPY.titlePlaceholder,
    };
  return draft.side === "theirs"
    ? {
        title: `What ${draft.party.title} owes you`,
        titleLabel: "What they owe",
        titlePlaceholder: "Send the signed contract",
      }
    : {
        title: `What you owe ${draft.party.title}`,
        titleLabel: "What you owe them",
        titlePlaceholder: "Send the monthly report",
      };
}

export const KIN_WORK_NEW_COPY = {
  title: KIN_WORK_NEW,
  titleLabel: "What needs doing",
  titlePlaceholder: "Send Acme the revised quote",
  ownerLabel: "Give it to",
  dueLabel: "Due",
  noDue: "No date",
  notesLabel: "Notes",
  notesPlaceholder: "Anything they need to know. Long briefs are better said in chat.",
  submit: "Add task",
  clientLabel: "Client",
  projectLabel: "Project",
  none: "None",
  sideLabel: "Who owes it",
  sideOurs: "We owe it",
  sideTheirs: "They owe it",
};

/** What happens next, said before the owner commits to it. */
export function kinWorkDraftHint(draft: KinWorkDraft, names: KinWorkNames): string | null {
  return draft.owner?._tag === "agent"
    ? `${kinWorkName(draft.owner, names)} starts on it right away and tells you in your chat when it's done.`
    : null;
}

const pad = (value: number) => String(value).padStart(2, "0");
/** A local calendar day as the host takes it for an all-day date. */
export const kinWorkDayOf = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

/** A picked day read back for display: "Fri 14 Nov". */
export function kinWorkDueLabel(day: string, now: Date): string {
  const [year, month, date] = day.split("-").map((part) => Number.parseInt(part, 10));
  const label = kinWorkDay(new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1), now);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** The days people actually pick, for a phone where a calendar is a lot of taps. */
export function kinWorkDueChoices(
  now: Date,
): ReadonlyArray<{ readonly label: string; readonly day: string }> {
  const at = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const weekday = now.getDay();
  const toFriday = 5 - weekday;
  const toMonday = ((8 - weekday) % 7) + (weekday === 1 ? 7 : 0);
  return [
    { label: "Today", day: kinWorkDayOf(at(0)) },
    { label: "Tomorrow", day: kinWorkDayOf(at(1)) },
    ...(toFriday > 1 ? [{ label: "Friday", day: kinWorkDayOf(at(toFriday)) }] : []),
    ...(toMonday > 1 ? [{ label: "Next Monday", day: kinWorkDayOf(at(toMonday)) }] : []),
    { label: "In two weeks", day: kinWorkDayOf(at(14)) },
  ];
}

export type KinWorkDraftCheck =
  | {
      readonly ok: true;
      readonly input: Omit<KinWorkCreateInput, "orgId" | "clientRequestId">;
    }
  | { readonly ok: false; readonly problem: string };

export function kinWorkDraftCheck(draft: KinWorkDraft): KinWorkDraftCheck {
  const title = draft.title.trim();
  if (title === "") return { ok: false, problem: "Say what needs doing." };
  if (title.length > KIN_WORK_TITLE_MAX)
    return { ok: false, problem: `Keep it under ${KIN_WORK_TITLE_MAX} characters.` };
  const notes = draft.notes.trim();
  if (notes.length > KIN_WORK_NOTES_MAX)
    return { ok: false, problem: "Those notes are too long. Say the rest in chat." };
  if (draft.due !== null && !dayPattern.test(draft.due))
    return { ok: false, problem: "That date doesn't look right." };
  return {
    ok: true,
    input: {
      title,
      ...(draft.owner === null ? {} : { owner: draft.owner }),
      ...(draft.due === null ? {} : { dueAt: draft.due, dueAllDay: true }),
      ...(notes === "" ? {} : { notes }),
      ...(draft.party === null ? {} : { party: draft.party.key }),
      ...(draft.project === null ? {} : { project: draft.project.key }),
      // Whose move it is only means something between us and a client.
      ...(draft.side === "theirs" && draft.party !== null ? { side: "theirs" as const } : {}),
    },
  };
}

// The owner's changes

export const KIN_WORK_CHANGED =
  "This changed while you were looking at it. Here is the latest, so check it and try again.";
const KIN_WORK_NOT_SENT = "That didn't go through. Check your connection and try again.";
const KIN_WORK_CLOSED_GIVE = "This task is closed. Reopen it before giving it to someone.";

/** What the owner was doing when the host refused, where that changes what to say. */
type Refused = "give" | "decline" | null;

/** Why a change didn't go through, in words for the owner. */
function problemOf(error: unknown, doing: Refused): string {
  if (isAuthorizationError(error)) return "This device isn't allowed to change Work.";
  if (!isKinChatError(error)) return KIN_WORK_NOT_SENT;
  switch (error.reason) {
    case "conflict":
      return KIN_WORK_CHANGED;
    case "not_found":
      return "That isn't there any more. Someone may have left, or the task was removed.";
    case "not_allowed":
      return "Only the owner can change Work for now.";
    case "unavailable":
    case "disabled":
      return "Kin isn't answering right now. Try again in a moment.";
    case "invalid_state":
      if (doing === "give") return KIN_WORK_CLOSED_GIVE;
      if (doing === "decline") return "This is already one of your tasks. Drop it instead.";
      return "That didn't go through. Check the details and try again.";
    default:
      return "That didn't go through. Check the details and try again.";
  }
}

type Sent<A> = Promise<AtomCommandResult<A, unknown>>;

export type KinWorkChangeResult =
  | { readonly ok: true; readonly item: KinRecordDetail }
  | {
      readonly ok: false;
      readonly problem: string;
      /** The task moved on since it was read: show the latest before trying again. */
      readonly changed: boolean;
    };

/** The host's answer to a change, as the task or a reason in words. */
export function kinWorkSettled(
  result: AtomCommandResult<KinRecordDetail, unknown>,
  doing: Refused = null,
): KinWorkChangeResult {
  if (AsyncResult.isSuccess(result)) return { ok: true, item: result.value };
  const error = squashAtomCommandFailure(result);
  return {
    ok: false,
    problem: problemOf(error, doing),
    changed: isKinChatError(error) && error.reason === "conflict",
  };
}

/** Adding a task and giving one to someone, each answered with the task or a reason in words. */
/**
 * The host's latest answers to the owner's changes, per task, shared by every screen on one host
 * and org, so a screen whose own read is behind still sends the revision the host is at.
 */
export interface KinWorkAnswers {
  readonly get: (key: KinRecordKey) => KinRecordDetail | undefined;
  readonly put: (item: KinRecordDetail) => void;
}

/** A task as held, or the host's newer answer to a change made to it from any screen. */
export function kinWorkNewest<R extends KinRecord>(record: R, answers?: KinWorkAnswers): R {
  const answer = answers?.get(record.key);
  return answer !== undefined && answer.rev > record.rev ? { ...record, ...answer } : record;
}

export function createKinWorkActions(options: {
  readonly orgId: KinOrgId;
  readonly answers?: KinWorkAnswers;
  readonly create: (input: KinWorkCreateInput) => Sent<KinRecordDetail>;
  readonly assign: (input: KinWorkAssignInput) => Sent<KinRecordDetail>;
  /** Reads a task again after the host refused a change to it. */
  readonly reread: (key: KinRecordKey) => void;
}) {
  const { orgId } = options;
  return {
    /** `requestId` stays the same across retries of one form, so a retry never adds a second. */
    add: async (
      input: Omit<KinWorkCreateInput, "orgId" | "clientRequestId">,
      requestId: string,
    ): Promise<KinWorkChangeResult> =>
      kinWorkSettled(await options.create({ orgId, ...input, clientRequestId: requestId })),
    /** Hands it over as the owner saw it; the host refuses if it changed since. */
    give: async (
      item: { readonly key: KinRecordKey; readonly rev: number },
      to: KinWorkPrincipal,
    ): Promise<KinWorkChangeResult> => {
      const rev = Math.max(item.rev, options.answers?.get(item.key)?.rev ?? 0);
      const outcome = kinWorkSettled(
        await options.assign({ orgId, key: item.key, to, rev }),
        "give",
      );
      if (outcome.ok) options.answers?.put(outcome.item);
      else options.reread(item.key);
      return outcome;
    },
  };
}

export type KinWorkActions = ReturnType<typeof createKinWorkActions>;

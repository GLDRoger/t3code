// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import {
  EnvironmentAuthorizationError,
  KinAgentId,
  KinChatError,
  type EnvironmentId,
  type KinChatId,
  type KinOrgId,
  type KinOrgsListResult,
  type KinPerson,
  KinPersonId,
  type KinRecord,
  type KinRecordChange,
  type KinRecordCan,
  type KinRepeatRule,
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
  type KinWorkStep,
  type KinWorkStepCount,
  type KinWorkSummary,
  KIN_LEFT_FIELD,
  KIN_WORK_STEP_MAX,
  KIN_WORK_STEPS_MAX,
  KIN_DISMISSED_FIELD,
  KIN_TAKEN_DEFAULT_FIELD,
  kinWhenFormat,
  kinWhenParts,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import { KIN_CHECK_CONNECTION, kinFailureText } from "./kinAnswers.ts";
import type { KinPermission } from "./kinAccess.ts";
import { kinRetiredAgentIds } from "./kinAgentRetire.ts";
import type { KinLink } from "./kinHost.ts";
import { KIN_SCOPE_ALL, kinScopeNote, type KinViewerScope } from "./kinViewerScope.ts";
import { kinLinkToOpen } from "./kinChatFeed.ts";
import { kinLinkLabel } from "./kinLinks.ts";
import {
  formatKinTime,
  kinAgentAvatar,
  kinLastUpdated,
  type KinAvatarView,
} from "./kinScreenState.ts";
import { kinPickablePeople } from "./kinTeam.ts";
import type { KinWorkLive } from "./kinWorkStream.ts";

export const KIN_WORK_TITLE = "Tasks";
export const KIN_WORK_NEW = "New task";
export const KIN_WORK_SEARCH_PLACEHOLDER = "Search tasks";
export const KIN_WORK_LOAD_FAILED = "Couldn't load tasks";
export const KIN_WORK_STALE = "Offline. Showing the last update.";
export const KIN_WORK_REFRESH_FAILED = "Couldn't refresh. Showing the last update.";

/**
 * The line over rows older than the host's: offline only when the link is down; a read that failed
 * on a live link says so and offers a retry; nothing while the first attempt is still under way.
 */
export function kinWorkStaleNotice(
  link: KinLink,
  /** When the rows shown were last read, as the chat's offline line says it; null unknown. */
  readAt: number | null = null,
  formatTime: (date: Date) => string = formatKinTime,
): { readonly message: string; readonly retry: boolean } | null {
  if (link === "connecting") return null;
  if (link !== "offline") return { message: KIN_WORK_REFRESH_FAILED, retry: true };
  return {
    message: readAt === null ? KIN_WORK_STALE : `Offline. ${kinLastUpdated(readAt, formatTime)}`,
    retry: false,
  };
}
/** Kin's work pages, each reached from the sidebar. */
export type KinWorkPageName = "tasks" | "money" | "clients" | "docs";

const PLACE_NOUN: Record<KinWorkPageName, { readonly name: string; readonly plural: boolean }> = {
  tasks: { name: "Tasks", plural: true },
  money: { name: "Money", plural: false },
  clients: { name: "Clients", plural: true },
  docs: { name: "Docs", plural: true },
};

/** Clients refused a teammate: their switch is off, the same words as on a client's page. */
const KIN_CLIENTS_OFF = {
  title: "Clients isn't on for you",
  detail: "The owner or a co-owner decides who sees Clients.",
};

/** The refusal on a work page, naming that page. */
export const kinWorkOnlyOwner = (place: KinWorkPageName) => {
  if (place === "clients") return KIN_CLIENTS_OFF;
  const { name, plural } = PLACE_NOUN[place];
  return {
    title: "Only the owner can open this",
    detail: `${name} ${plural ? "are" : "is"} shown to the person who runs this workspace for now.`,
  };
};

/** A work page with nothing held, once a connection failed or was lost, naming that page. */
export const kinWorkOffline = (place: KinWorkPageName) => {
  const { name, plural } = PLACE_NOUN[place];
  return {
    title: "You're offline",
    detail: `${name} ${plural ? "come" : "comes"} back when the connection does.`,
  };
};
export const KIN_WORK_GONE = {
  title: "This task isn't here any more",
  detail: "Open Tasks to see what there is now.",
};
export const KIN_WORK_ITEM_FAILED = {
  title: "Couldn't load this task",
  detail: KIN_CHECK_CONNECTION,
};
export const KIN_WORK_TITLE_MAX = 280;
/** Where a title's counter shows: nothing typed is ever cut, so the limit is said before Save. */
const KIN_WORK_TITLE_COUNT_FROM = 240;
export const KIN_WORK_TITLE_TOO_LONG = `Keep the title under ${KIN_WORK_TITLE_MAX} characters.`;

/** "254 of 280" once a title nears the limit; null before then. */
export const kinWorkTitleCount = (title: string): string | null => {
  const length = title.trim().length;
  return length < KIN_WORK_TITLE_COUNT_FROM ? null : `${length} of ${KIN_WORK_TITLE_MAX}`;
};
export const kinWorkTitleTooLong = (title: string) => title.trim().length > KIN_WORK_TITLE_MAX;
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
  /** The company's owner; absent from a host older than kinds, where the reader reads as owner. */
  readonly owner?: KinPersonId | null;
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
    // Every agent by name, the ones this person may not message too: who holds a task is no secret.
    agents: new Map(
      [...(org?.agents ?? []), ...(org?.otherAgents ?? [])].map((agent) => [
        agent.agentId,
        agent.displayName,
      ]),
    ),
    retired: new Set([
      ...kinRetiredAgentIds(input.orgs, input.orgId),
      ...(org?.otherAgents ?? []).flatMap((agent) => (agent.retired ? [agent.agentId] : [])),
    ]),
    me: input.orgs?.me.find((me) => me.orgId === input.orgId)?.personId ?? null,
    owner: input.people?.find((person) => person.access === "owner")?.personId ?? null,
    zone: input.zone,
  };
}

export const kinWorkPrincipalKey = (who: KinWorkPrincipal): string =>
  who._tag === "person" ? `person:${who.personId}` : `agent:${who.agentId}`;

export const kinWorkSamePrincipal = (a: KinWorkPrincipal | null, b: KinWorkPrincipal | null) =>
  a !== null && b !== null && kinWorkPrincipalKey(a) === kinWorkPrincipalKey(b);

const isMe = (who: KinWorkPrincipal, names: KinWorkNames) =>
  who._tag === "person" && who.personId === names.me;

/** The names `kinWorkName` reads; a screen holding one map for everyone passes it as both. */
export type KinWhoNames = Pick<KinWorkNames, "people"> &
  Partial<Pick<KinWorkNames, "agents" | "me">>;

/**
 * The one way a screen names who holds or changed something: "You", a person's or agent's
 * display name, or a plain stand-in for one the directory no longer lists. Never an id.
 */
export function kinWorkName(who: KinWorkPrincipal, names: KinWhoNames, you = "You"): string {
  if (who._tag === "agent") return names.agents?.get(who.agentId) ?? "An agent";
  return who.personId === names.me ? you : (names.people.get(who.personId) ?? "A teammate");
}

/** A stored `person:<id>` or `agent:<id>` by `kinWorkName`; null for text that names nobody. */
export function kinWorkNameOfText(text: string, names: KinWhoNames, you = "You"): string | null {
  const shown = /^(person|agent):(.+)$/.exec(text);
  if (shown === null) return null;
  const id = shown[2]!;
  return kinWorkName(
    shown[1] === "agent"
      ? { _tag: "agent", agentId: KinAgentId.make(id) }
      : { _tag: "person", personId: KinPersonId.make(id) },
    names,
    you,
  );
}

/** "you" to the owner; to anyone else the owner by name, so "you" never means someone else. */
const ownerWord = (names: Pick<KinWorkNames, "me" | "owner" | "people">) =>
  names.owner == null || names.owner === names.me
    ? null
    : kinMidSentence(kinWorkName({ _tag: "person", personId: names.owner }, names));

/** A name inside a sentence: the stand-ins "An agent" and "A teammate" lose their capital. */
export const kinMidSentence = (name: string) =>
  name === "An agent" || name === "A teammate" ? name.toLowerCase() : name;

/** The task's holder is an agent its owner retired, so nobody is doing it. */
const kinWorkRetired = (who: KinWorkPrincipal, names: KinWorkNames): boolean =>
  who._tag === "agent" && names.retired?.has(who.agentId) === true;

export const kinWorkAvatar = (who: KinWorkPrincipal): KinAvatarView =>
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
/** How the phone's Tasks groups: by whose move it is (`me`), or by one of the task's own fields. */
export type KinTaskGroupBy = "me" | "project" | "person" | "due" | "status";

export interface KinWorkFilter {
  readonly view: KinWorkViewId;
  readonly owner: KinWorkPrincipal | null;
  readonly text: string;
  readonly party: KinWorkRef | null;
  readonly project: KinWorkRef | null;
  /** Set only where the list groups (the phone's Tasks); absent reads plainly. */
  readonly groupBy?: KinTaskGroupBy;
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
  // Its status is Waiting; Tasks' "Waiting on others" is every task in someone else's hands.
  { id: "waiting", label: "Marked waiting" },
  { id: "late", label: "Late" },
  { id: "week", label: "Due this week" },
  { id: "closed", label: "Closed" },
];

export const kinWorkSameFilter = (a: KinWorkFilter, b: KinWorkFilter) =>
  a.view === b.view &&
  a.text.trim() === b.text.trim() &&
  (a.party?.key ?? null) === (b.party?.key ?? null) &&
  (a.project?.key ?? null) === (b.project?.key ?? null) &&
  (a.owner === null ? b.owner === null : kinWorkSamePrincipal(a.owner, b.owner)) &&
  (a.groupBy ?? null) === (b.groupBy ?? null);

/** Read by whose move it is (`byMove`): grouped Me first, and only the plain open list. */
export const kinWorkByMove = (filter: KinWorkFilter) =>
  filter.groupBy === "me" &&
  filter.view === "open" &&
  filter.owner === null &&
  filter.party === null &&
  filter.project === null &&
  filter.text.trim() === "";

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
    ...(kinWorkByMove(filter) ? { byMove: true as const } : {}),
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
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/** The host said this viewer may not read Work. */
export const kinWorkRefused = (error: unknown): boolean =>
  isAuthorizationError(error) || (isKinChatError(error) && error.reason === "not_allowed");

export const kinWorkFailuresOf = (cause: Cause.Cause<unknown>) =>
  cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);

export function kinWorkScreenState(input: {
  /** Whether this session may read Work at all, once its scopes and kind are known. */
  readonly allowed: KinPermission;
  readonly link: KinLink;
  readonly live: AsyncResult.AsyncResult<KinWorkLive, unknown>;
}): KinWorkScreenState {
  if (input.allowed === "refused") return { _tag: "refused" };
  if (input.allowed === "failed")
    return input.link === "offline" ? { _tag: "offline" } : { _tag: "failed" };
  const { live } = input;
  if (AsyncResult.isFailure(live) && kinWorkFailuresOf(live.cause).some(kinWorkRefused))
    return { _tag: "refused" };
  const held = Option.getOrNull(AsyncResult.value(live));
  if (held === null || held.summary === null) {
    if (AsyncResult.isFailure(live) || held?.failed === true) return { _tag: "failed" };
    return input.link === "offline" ? { _tag: "offline" } : { _tag: "loading" };
  }
  return {
    _tag: "ready",
    live: held,
    stale: input.link === "offline" || held.failed || AsyncResult.isFailure(live),
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

// A calendar day is held as that day's UTC midnight and written in UTC, so no device zone moves it.
const dayFormat = kinWhenFormat("day", { zone: "UTC" });
const dayYearFormat = kinWhenFormat("dateYear", { zone: "UTC" });
const clockFormat = kinWhenFormat("time");
/** "12:16 AM" as the clock reads in `zone`, the company's, else this device's. */
export const kinWorkClock = (date: Date, zone: string | null) => {
  try {
    return zone === null ? clockFormat.format(date) : kinWhenFormat("time", { zone }).format(date);
  } catch {
    return clockFormat.format(date);
  }
};

const civilDay = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day));
const civilDayOf = (day: Date) => day.toISOString().slice(0, 10);
const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS);

/** "today", "tomorrow", "yesterday", "Fri 14 Nov", or "14 Nov 2027" for another year. */
function kinWorkDay(day: Date, today: Date): string {
  const days = daysBetween(today, day);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return day.getUTCFullYear() === today.getUTCFullYear()
    ? dayFormat.format(day)
    : dayYearFormat.format(day);
}

/** The calendar day `date` falls on in `zone`, the company's, else on this device. */
function dayInZone(date: Date, zone: string | null): Date {
  const local = civilDay(date.getFullYear(), date.getMonth() + 1, date.getDate());
  if (zone === null) return local;
  try {
    const part = kinWhenParts(date, zone);
    return civilDay(part.year, part.month, part.day);
  } catch {
    return local;
  }
}

export const kinWorkDueText = (
  record: Pick<KinRecord, "dueAt" | "dueAllDay">,
  names: Pick<KinWorkNames, "zone">,
  now: Date,
): string | null => {
  if (record.dueAt === null) return null;
  const due = new Date(record.dueAt);
  if (Number.isNaN(due.getTime())) return null;
  // Due days and times are the owner's, and so is the today they are counted from.
  const day = kinWorkDay(dayInZone(due, names.zone), dayInZone(now, names.zone));
  return record.dueAllDay ? day : `${day}, ${kinWorkClock(due, names.zone)}`;
};

/** Days from today to the due day (0 today, negative past), counted as `kinWorkDueText` says it. */
export const kinWorkDueDays = (
  record: Pick<KinRecord, "dueAt" | "dueAllDay">,
  names: Pick<KinWorkNames, "zone">,
  now: Date,
): number | null => {
  if (record.dueAt === null) return null;
  const due = new Date(record.dueAt);
  if (Number.isNaN(due.getTime())) return null;
  return daysBetween(dayInZone(now, names.zone), dayInZone(due, names.zone));
};

/** Sentences joined for a label, never doubling the stop a title already ends with. */
const kinSentences = (parts: ReadonlyArray<string>): string =>
  parts.reduce(
    (said, part) =>
      said === "" ? part : `${said}${/[.!?…]["”’)]?$/.test(said) ? "" : "."} ${part}`,
    "",
  );

/** A task's state as the Tasks list says it: "Waiting on Priya"; "Waiting" with no names to hand. */
export const kinWorkStatusText = (
  record: Pick<KinRecord, "state" | "waitingOn">,
  names: KinWorkNames | null,
): string =>
  record.state === "waiting" && record.waitingOn !== null && names !== null
    ? `Waiting on ${kinWorkName(record.waitingOn, names, "you")}`
    : STATE_LABEL[record.state];
const statusText = (record: KinRecord, names: KinWorkNames): string =>
  kinWorkStatusText(record, names);

/** What a task waiting on its own reader says in place of "Waiting on you". */
export const KIN_WORK_YOURS_TO_DO = "Yours to do";

/** A task's checklist: lines under it, never tasks of their own. */
export const KIN_WORK_STEPS = {
  title: "Steps",
  /** "2 of 4", on the row and above the checklist. */
  count: (count: KinWorkStepCount) => `${count.done} of ${count.of}`,
  /** The count read out: "2 of 4 steps done". */
  spoken: (count: KinWorkStepCount) =>
    `${count.done} of ${count.of} ${count.of === 1 ? "step" : "steps"} done`,
  add: "Add a step",
  placeholder: "Add a step",
  remove: "Remove step",
  tick: (title: string) => `Tick: ${title}`,
  untick: (title: string) => `Untick: ${title}`,
  /** Said once every step is ticked: the task itself stays open until someone says done. */
  allDone: "Every step is ticked. Mark the task done when it's finished.",
  tooLong: `Keep a step under ${KIN_WORK_STEP_MAX} characters.`,
  tooMany: `A task holds up to ${KIN_WORK_STEPS_MAX} steps.`,
} as const;

/** A task someone marked urgent: first within its day, with a flag on its row and its page. */
export const KIN_WORK_URGENT = {
  label: "Urgent",
  mark: "Mark urgent",
  unmark: "Not urgent",
} as const;

/** A task's steps as its page shows them, with what this reader may do to them. */
export interface KinWorkStepsView {
  /** "2 of 4"; null with no steps yet. */
  readonly count: string | null;
  readonly items: ReadonlyArray<{
    readonly index: number;
    readonly title: string;
    readonly done: boolean;
    /** What a tap on its box does, read out. */
    readonly label: string;
  }>;
  /** The reader may tick, add and remove steps: whoever may change the task (`can.edit`). */
  readonly editable: boolean;
  /** Every step ticked while the task is still open: `KIN_WORK_STEPS.allDone`. */
  readonly allDone: string | null;
}

/** The page's Steps: null where the host keeps none for it, or has none and lets nobody add. */
function kinWorkSteps(
  item: Pick<KinRecordDetail, "checklist" | "can" | "state">,
): KinWorkStepsView | null {
  // An older host sends no checklist: it would drop steps sent to it.
  if (item.checklist === undefined) return null;
  const steps: ReadonlyArray<KinWorkStep> = item.checklist;
  const editable = item.can?.edit === true;
  if (steps.length === 0 && !editable) return null;
  const done = steps.filter((step) => step.done).length;
  return {
    count: steps.length === 0 ? null : KIN_WORK_STEPS.count({ done, of: steps.length }),
    items: steps.map((step, index) => ({
      index,
      title: step.title,
      done: step.done,
      label: step.done ? KIN_WORK_STEPS.untick(step.title) : KIN_WORK_STEPS.tick(step.title),
    })),
    editable,
    allDone:
      steps.length > 0 && done === steps.length && !kinWorkClosed(item.state)
        ? KIN_WORK_STEPS.allDone
        : null,
  };
}

/** Why a typed step can't be added, or null when it can. */
export const kinWorkStepProblem = (title: string, steps: number): string | null =>
  title.trim().length > KIN_WORK_STEP_MAX
    ? KIN_WORK_STEPS.tooLong
    : steps >= KIN_WORK_STEPS_MAX
      ? KIN_WORK_STEPS.tooMany
      : null;

/**
 * Waiting on the reader themself: not paused for them but theirs to move, so drawn and said as
 * a to-do from their seat. The stored state stays `waiting`.
 */
export const kinWorkWaitsOnMe = (
  record: Pick<KinRecord, "state" | "waitingOn">,
  names: Pick<KinWorkNames, "me">,
): boolean =>
  record.state === "waiting" &&
  record.waitingOn?._tag === "person" &&
  record.waitingOn.personId === names.me;

export interface KinWorkRowView {
  readonly key: KinRecordKey;
  readonly title: string;
  /** Where it stands from the reader's seat, for its mark: open when it waits on them. */
  readonly state: KinRecordState;
  /** "In progress", "Waiting on Priya", "Done". */
  readonly status: string;
  readonly owner: string;
  readonly ownerAvatar: KinAvatarView;
  /** "Due Fri 14 Nov"; null with no date or once it is closed. */
  readonly due: string | null;
  readonly late: boolean;
  /** A lead picked it up on its own, nobody has confirmed it, and this reader may. */
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
  /** Who has it, as the row always shows it: "Priya", "You", "Tech lead (retired)". */
  readonly holder: string;
  /** The rest after who has it: "Due Fri 14 Nov · In progress · Acme". */
  readonly detail: string;
  /** `holder` and `detail` on one line: "Priya · Due Fri 14 Nov · In progress · Acme". */
  readonly line: string;
  readonly accessibilityLabel: string;
  /** The mark beside the row: "Late" or "Handed back" anywhere, and on your own tasks "Due today" or "Stuck". */
  readonly mark: KinWorkMark | null;
  /** The mark's words: "Late", "Handed back by Zoya". */
  readonly markText: string | null;
  /** "2 of 4" of its steps ticked; null with none. */
  readonly steps: string | null;
  /** Someone marked it urgent: its flag. */
  readonly urgent: boolean;
}

/** Why one of your own tasks leads "On me": shown on the task, not as a second list. */
export type KinWorkMark = "late" | "today" | "stuck" | "handed_back";

const KIN_WORK_MARKS: Record<KinWorkMark, string> = {
  late: "Late",
  today: "Due today",
  stuck: "Stuck",
  handed_back: "Handed back",
};

/**
 * The row with its "On me" mark, which its label also says. A row's own mark (Late, Handed back
 * by Zoya) stays: "Due today" and "Stuck" are already in its detail.
 */
export function kinWorkRowMarked(row: KinWorkRowView, mark: KinWorkMark | null): KinWorkRowView {
  if (mark === null || row.mark !== null) return row;
  return {
    ...row,
    mark,
    markText: KIN_WORK_MARKS[mark],
    accessibilityLabel: `${row.accessibilityLabel}. ${KIN_WORK_MARKS[mark]}`,
  };
}

/** "Every month", "Every week", "Every 10 days". */
export const kinRepeatText = (rule: KinRepeatRule): string =>
  rule.every === "days"
    ? rule.days === 1
      ? "Every day"
      : rule.days === 7
        ? "Every week"
        : `Every ${rule.days} days`
    : `Every ${rule.every}`;

/** A task's Repeats row: what it says, and the rules offered (any other an agent set still shows). */
export const KIN_WORK_REPEAT = {
  label: "Repeats",
  never: "Doesn't repeat",
  /** Its menu item, on one line: "Make it repeat", or how it repeats now. */
  menu: (text: string | null) =>
    text === null ? "Make it repeat" : `Repeats ${text.toLowerCase()}`,
  stop: "Stop repeating",
  needsDue: "Give it a due date first: the next one is made from it.",
  /** Said once, beside the row: a repeat makes the next task, never the money in it. */
  note: "When it's closed, the next one is made from its due date.",
  choices: [
    { label: "Every week", rule: { every: "days", days: 7 } },
    { label: "Every 2 weeks", rule: { every: "days", days: 14 } },
    { label: "Every month", rule: { every: "month" } },
    { label: "Every quarter", rule: { every: "quarter" } },
    { label: "Every year", rule: { every: "year" } },
  ] satisfies ReadonlyArray<{ readonly label: string; readonly rule: KinRepeatRule }>,
};

/** Whether two rules are the same, for marking the one a task has. */
export const kinSameRepeat = (a: KinRepeatRule | null, b: KinRepeatRule | null): boolean =>
  a === null || b === null
    ? a === b
    : a.every === b.every && (a.every !== "days" || (b.every === "days" && a.days === b.days));

export const kinWorkClosed = (state: KinRecordState) => state === "done" || state === "dropped";

export function kinWorkRow(
  record: KinRecord,
  names: KinWorkNames,
  now: Date,
  /** What the list around the row already says, which the row needn't repeat. */
  within?: Pick<KinWorkFilter, "party" | "project"> & { readonly sided?: true },
): KinWorkRowView {
  const owner = kinWorkName(record.owner, names);
  // The project, for everyone who is sent it; its client only when there is none. Inside a
  // project the page already names its client, so its rows don't.
  const inProject = within?.project != null && record.project?.key === within.project.key;
  const about = inProject
    ? null
    : record.project !== undefined
      ? record.project.title
      : record.party !== undefined && record.party.key !== within?.party?.key
        ? record.party.title
        : null;
  const onMe = kinWorkWaitsOnMe(record, names);
  const status = record.working
    ? "Working on it now"
    : onMe
      ? KIN_WORK_YOURS_TO_DO
      : statusText(record, names);
  const day = kinWorkClosed(record.state) ? null : kinWorkDueText(record, names, now);
  const due = day === null ? null : `Due ${day}`;
  const ownerRetired = kinWorkRetired(record.owner, names);
  const holder = ownerRetired ? `${owner} (retired)` : owner;
  const handedBy =
    record.handedBack === undefined || kinWorkClosed(record.state)
      ? null
      : { principal: record.handedBack.by, name: kinWorkName(record.handedBack.by, names, "you") };
  const handedBack = handedBy === null ? null : `Handed back by ${handedBy.name}`;
  // The row's mark keeps a person to their first name, so a phone-width title isn't squeezed.
  const handedBackMark =
    handedBy === null
      ? null
      : handedBy.principal._tag === "person"
        ? `Handed back by ${handedBy.name.split(/\s+/)[0]}`
        : handedBack;
  // What a narrow row keeps when it cuts the end off: who has it always (the row sets it apart),
  // then when it is due and where it stands, then its client or project. "Not started" is what
  // the empty circle already says.
  const steps = record.steps === undefined ? null : KIN_WORK_STEPS.count(record.steps);
  const urgent = record.urgent === true && !kinWorkClosed(record.state);
  const detail = [
    due,
    steps,
    record.repeat === undefined || kinWorkClosed(record.state)
      ? null
      : kinRepeatText(record.repeat),
    (record.state === "open" || onMe) && !record.working ? null : status,
    about,
    record.side === "theirs" && !kinWorkClosed(record.state) && within?.sided !== true
      ? "They owe this"
      : null,
    record.pullRequest === null ? null : `PR #${record.pullRequest.number}`,
    record.confirmed || kinWorkClosed(record.state) ? null : "Suggested",
  ].filter((part) => part !== null);
  const parts = [holder, ...detail];
  return {
    key: record.key,
    title: record.title,
    state: onMe ? "open" : record.state,
    status,
    owner,
    ownerAvatar: kinWorkAvatar(record.owner),
    due,
    late: record.late,
    // Keep and decline only where the host takes them, on hosts that say (`can`).
    suggested: !record.confirmed && !kinWorkClosed(record.state) && (record.can?.confirm ?? true),
    tick:
      record.owner._tag === "agent" || !record.confirmed
        ? null
        : kinWorkClosed(record.state)
          ? (record.can?.states.includes("open") ?? true)
            ? "reopen"
            : null
          : (record.can?.states.includes("done") ?? true)
            ? "done"
            : null,
    working: record.working,
    ownerRetired,
    about,
    holder,
    detail: detail.join(" · "),
    line: parts.join(" · "),
    accessibilityLabel: kinSentences(
      [
        record.title,
        urgent ? KIN_WORK_URGENT.label : null,
        ...parts.map((part) =>
          part === steps && record.steps !== undefined ? KIN_WORK_STEPS.spoken(record.steps) : part,
        ),
        record.late ? "Late" : handedBack,
      ].filter((part) => part !== null),
    ),
    mark: record.late ? "late" : handedBack === null ? null : "handed_back",
    markText: record.late ? KIN_WORK_MARKS.late : handedBackMark,
    steps,
    urgent,
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
  scope: KinViewerScope = KIN_SCOPE_ALL,
): {
  readonly title: string;
  readonly detail: string;
  readonly offerNew: boolean;
} {
  const text = filter.text.trim();
  if (text !== "")
    return { title: `Nothing matches “${text}”`, detail: "Try another word.", offerNew: false };
  const whole = kinWorkNothingAll(filter, names);
  // A teammate sees part of the company's tasks: "nobody is blocked" would be a guess.
  return scope.all || filter.owner !== null || filter.project != null || filter.party != null
    ? whole
    : { ...whole, detail: kinScopeNote("tasks", scope) ?? whole.detail };
}

function kinWorkNothingAll(
  filter: KinWorkFilter,
  names: KinWorkNames,
): {
  readonly title: string;
  readonly detail: string;
  readonly offerNew: boolean;
} {
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
  /** A web link this viewer may take off: the address `kin.work.linkRemove` takes. */
  readonly removeUrl?: string;
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
  /** "Tech lead gave this to you · Nov 7". */
  readonly given: string | null;
  /** The one line on why its holder was picked. */
  readonly reason: string | null;
  /** Whoever gave it to you, when you can give it back to them; null otherwise. */
  readonly handBackTo: string | null;
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
  /** A task's milestone; null with none. */
  readonly milestone: KinWorkRef | null;
  /** A milestone's tasks, open first; null on a task. */
  readonly tasks: ReadonlyArray<KinWorkRowView> | null;
  /** Who has to do it. Only worth showing with a client. */
  readonly side: KinRecordSide;
  /** Whether it is kept to the owner, and whether that is its own label to change. */
  readonly privacy: KinWorkPrivacy;
  /** The owner shared it with the team. */
  readonly shared: boolean;
  /** Who marked it private, while it is; null when unknown. */
  readonly markedBy: KinPersonId | null;
  /** What the host lets this reader do to it: a control shows only when it is here. */
  readonly can: KinRecordCan;
  /** How it comes back once closed, as a rule and in words; null when it doesn't. */
  readonly repeat: { readonly rule: KinRepeatRule; readonly text: string } | null;
  /** Its checklist (`kinWorkSteps`); null where it has none to show or add. */
  readonly steps: KinWorkStepsView | null;
  /** Someone marked it urgent. */
  readonly urgent: boolean;
}

/** How private something is, and what to say about it beside the label. */
export interface KinWorkPrivacy {
  readonly private: boolean;
  /** Its client or project makes it private, so its own label changes nothing. */
  readonly inherited: boolean;
  readonly note: string;
}

export const KIN_WORK_PRIVATE = "Private";

/** Giving a task back to whoever gave it, with an optional word on why. */
export const KIN_WORK_HAND_BACK = {
  button: "Hand back",
  title: "Hand back this task?",
  detail: (to: string) => `It goes back to ${kinMidSentence(to)} to give to someone else.`,
  reasonLabel: "Why (optional)",
  confirm: "Hand back",
  failed: "Couldn't hand it back.",
} as const;

export function kinWorkPrivacy(input: {
  readonly sensitive: boolean;
  readonly inherited: boolean;
  /** What makes it private when it is not its own label: "its client", "Acme". */
  readonly because: string;
  /** Who still sees it when its own label is on, where that is more than you. */
  readonly privateNote?: string;
}): KinWorkPrivacy {
  return {
    private: input.sensitive || input.inherited,
    inherited: input.inherited,
    note: input.inherited
      ? `Private because ${input.because} is.`
      : input.sensitive
        ? (input.privateNote ?? "Only you see this.")
        : "Not kept from your team.",
  };
}

export const KIN_WORK_SHARE = {
  label: "Share with team",
  on: "Your teammates can see this task and follow it.",
  off: "Teammates see this only if they hold it, or it's in a project they lead or are on.",
  failed: "Couldn't change who sees this.",
};

/** Who sees a task: the people on it and its project, the whole team, or only the owner's side. */
export type KinWorkAudience = "people" | "team" | "me";

export const KIN_WORK_MILESTONE = {
  label: "Milestone",
  tasks: "Tasks",
  noTasks: "No tasks under it yet.",
} as const;

export const KIN_WORK_AUDIENCE = {
  label: "Who can see this",
  failed: "Couldn't change who sees this.",
} as const;

/**
 * A task's one privacy control, as the host decides it: private only when marked, and its holder
 * always sees it; unmarked, its maker, holder and project's people do, and the team once shared.
 * Each answer says the server's `personSees` rule in words: change the two together.
 */
export function kinWorkAudience(
  view: Pick<KinWorkItemView, "privacy" | "shared" | "project"> &
    Partial<Pick<KinWorkItemView, "markedBy">>,
  /** What the host lets this reader change (`KinRecordDetail.can`). */
  can: Pick<KinRecordCan, "mark" | "unmark" | "share">,
  names?: Pick<KinWorkNames, "me" | "owner" | "people">,
) {
  const people = view.project === null ? "People on it" : "People on it and the project";
  const current: KinWorkAudience = view.privacy.private ? "me" : view.shared ? "team" : "people";
  const owner = names === undefined ? null : ownerWord(names);
  // Kept to whoever marked it: "Only me" to them, their name to anyone else who sees it.
  const marker =
    names === undefined || current !== "me" ? null : markerWord(view.markedBy ?? null, names);
  const answer =
    current === "me"
      ? `Only ${marker ?? "you"}, co-owners and whoever has it`
      : current === "team"
        ? "Everyone on the team"
        : view.project === null
          ? `${owner ?? "You"}, co-owners and whoever has it or gave it`
          : `${owner ?? "You"}, co-owners, whoever has it or gave it, and the people on ${view.project.title}`;
  const label = {
    people,
    team: "The whole team",
    me: marker === null ? "Only me" : `Only ${marker}`,
  };
  const now = { private: view.privacy.private && !view.privacy.inherited, shared: view.shared };
  // A choice is offered only when the host takes every change it makes.
  const reachable = (to: KinWorkAudience) => {
    const move = kinWorkAudienceMove(now, to);
    return (
      to === current ||
      ((move.private === null || (move.private ? can.mark : can.unmark)) &&
        (move.shared === null || can.share))
    );
  };
  const ids = (["people", "team", "me"] as const).filter(reachable);
  const choices = ids.map((id) => ({ id, label: label[id] }));
  return { current, answer, short: label[current], choices: choices.length > 1 ? choices : [] };
}

/** What picking `to` changes, null where it stays: its private mark, and its sharing. */
export const kinWorkAudienceMove = (
  now: { readonly private: boolean; readonly shared: boolean },
  to: KinWorkAudience,
) => ({
  private: now.private === (to === "me") ? null : to === "me",
  shared: now.shared === (to === "team") ? null : to === "team",
});

export const KIN_ENTRY_SHARE: typeof KIN_WORK_SHARE = {
  label: "Share with team",
  on: "Teammates who can see Money read its figures.",
  off: "Only the owner and co-owners see this, and the lead of its project.",
  failed: "Couldn't change who sees this.",
};

export const KIN_DOC_SHARE: typeof KIN_WORK_SHARE = {
  label: "Share with team",
  on: "Teammates who can see Docs read this one.",
  off: "Only the owner and co-owners see this doc, and the people on its project.",
  failed: "Couldn't change who sees this.",
};

/** A company doc, such as a playbook: the team's to read, with no switch. Private hides it. */
export const KIN_DOC_COMPANY = {
  label: "Who can read this",
  note: "Everyone on the team with Docs, and the agents working for them: it's a company doc. Marked private, only the owner and co-owners see it.",
} as const;

const CATEGORY_LABEL = {
  task: null,
  issue: "Issue",
  obligation: "Commitment",
  meeting: "Meeting",
} as const;

export const kinWorkActorName = (actor: KinWorkActor, names: KinWorkNames) =>
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

/** "today", "yesterday" or "15 Nov" for an ISO time, on this device's calendar. */
export const kinWorkDayOfTime = (iso: string, now: Date) => dayFromText(iso, now, null);

/** A due date as the history wrote it, as the day it is where the owner is. */
export const kinWorkDueDayText = (text: string | null, now: Date, zone: string | null) =>
  dayFromText(text, now, zone);

/** A due time from the history, as the day it is where the owner is, like the due date itself. */
const dayFromText = (text: string | null, now: Date, zone: string | null) => {
  if (text === null) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime())
    ? null
    : kinWorkDay(dayInZone(date, zone), dayInZone(now, zone));
};

const ADDED = {
  work: "added this",
  clients: "added this client",
  contacts: "added this contact",
  projects: "started this project",
  invoices: "added this invoice",
  receipts: "made this receipt",
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
  /** What a task's notes are called where the line shows: the record page calls them its brief. */
  notesWord = "notes",
): string {
  const who = kinWorkActorName(change.by, names);
  const field = (name: string) => change.fields.find((held) => held.field === name);
  if (change.kind === "created") {
    // The system brought agents' notes over; a person's import is a sheet they brought in.
    return change.via === "import"
      ? change.by._tag === "system"
        ? "Brought over from your agents' notes"
        : "Brought over in an import"
      : `${who} ${ADDED[list]}`;
  }
  if (change.kind === "linked") {
    const link = change.fields[0];
    if (link !== undefined && link.to === null) return `${who} removed a link`;
    if (link?.field === "worker") return `${who} started work on it`;
    if (link?.field === "pull_request") return `${who} linked ${link.to ?? "a pull request"}`;
    return `${who} added a link`;
  }
  // Kin stopped the task waiting on the person a question asked, who dismissed it unanswered.
  if (field(KIN_DISMISSED_FIELD) !== undefined)
    return `${who} dismissed the question without choosing`;
  const clauses: Array<string> = [];
  // Access moves leave the task where it is; the line says whose access and who moved it.
  const removed = principalFromText(field("accessRemoved")?.from ?? null);
  if (removed !== null)
    clauses.push(
      removed._tag === "person" && removed.personId === names.me
        ? "removed your access; it stayed with you"
        : `removed ${kinWorkName(removed, names)}'s access; it stays with them`,
    );
  if (field("accessBack") !== undefined) clauses.push("came back; it's theirs again");
  const owner = field("owner");
  const to = principalFromText(owner?.to ?? null);
  const handedBack = field("handedBack");
  const left = principalFromText(field(KIN_LEFT_FIELD)?.from ?? null);
  if (to !== null) {
    clauses.push(
      handedBack !== undefined
        ? `handed it back to ${kinWorkName(to, names, "you")}${handedBack.to === null ? "" : `: “${handedBack.to}”`}`
        : change.by._tag !== "system" && kinWorkSamePrincipal(change.by, to)
          ? "took it on"
          : `gave it to ${kinWorkName(to, names, "you")}${left === null ? "" : ` (${kinWorkName(left, names)} left)`}`,
    );
  }
  // A held notice: `untold` names the holder not told yet, and clears once they are.
  const untold = field("untold");
  const told = owner === undefined ? principalFromText(untold?.from ?? null) : null;
  if (untold?.to != null) clauses.push("not told yet");
  else if (told !== null) clauses.push(`told ${kinWorkName(told, names, "you")}`);
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
  else if (state === "done") clauses.push(list === "invoices" ? "marked it paid" : "finished it");
  else if (state === "dropped")
    clauses.push(list === "invoices" || list === "receipts" ? "voided it" : "dropped it");
  else if (state === "open") clauses.push("put it back to not started");
  // An invoice waits on payment from the moment it is issued.
  else if (state === "waiting" && list === "invoices") clauses.push("issued it");
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
  if (field("notes") !== undefined) clauses.push(`changed the ${notesWord}`);
  if (field("confirmed")?.to === "true") clauses.push("kept it");
  if (field("terms") !== undefined) clauses.push("changed the terms");
  if (["role", "email", "phone", "emails", "phones"].some((name) => field(name) !== undefined))
    clauses.push("changed their details");
  if (field("repos") !== undefined) clauses.push("changed its repos");
  const repeat = field("repeat");
  if (repeat !== undefined)
    clauses.push(repeat.to === null ? "stopped it repeating" : `set it to repeat ${repeat.to}`);
  const side = field("side")?.to;
  if (side === "theirs") clauses.push("marked it as theirs to do");
  else if (side === "ours") clauses.push("marked it as ours to do");
  const party = field("party");
  if (party !== undefined)
    clauses.push(party.to === null ? "took it off its client" : "put it under a client");
  const project = field("project");
  if (project !== undefined)
    clauses.push(project.to === null ? "took it out of its project" : "put it in a project");
  if (field("steps") !== undefined) clauses.push("changed its steps");
  const urgent = field("urgent")?.to;
  if (urgent === "true") clauses.push("marked it urgent");
  else if (urgent === "false") clauses.push("took the urgent mark off");
  const sensitive = field("sensitive")?.to;
  if (sensitive === "true") clauses.push("made it private");
  else if (sensitive === "false") clauses.push("made it not private");
  // Clients keep their kind in the category field.
  const kind = list === "clients" ? field("category") : undefined;
  if (kind?.to === "vendor") clauses.push("marked them a vendor");
  else if (kind?.to === "client") clauses.push("marked them a client");
  else if (kind?.to === "prospect")
    clauses.push(
      kind.from === "client" ? "marked them a prospect again" : "marked them a prospect",
    );
  const said = clauses.length === 0 ? "updated it" : clauses.join(", ");
  // A change Kin made by taking the default of a question nobody answered.
  return field(KIN_TAKEN_DEFAULT_FIELD) === undefined
    ? `${who} ${said}`
    : `${who} went with the default: ${said} (nobody answered)`;
}

function linkView(
  link: KinRecordLink,
  working: boolean,
  place: KinWorkPlace,
  editable: boolean,
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
            // A person names a link, so its label names the host it really opens.
            label: link.label === null ? href : kinLinkLabel(link.label, new URL(href)),
            detail: null,
            open: { type: "url", href },
            thread: null,
            ...(editable ? { removeUrl: link.target } : {}),
          };
    }
  }
}

/** The clients or projects whose name holds every word typed, in the order given. */
export function kinWorkRefsMatching<R extends KinWorkRef>(
  refs: ReadonlyArray<R>,
  query: string,
): ReadonlyArray<R> {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return refs;
  return refs.filter((ref) => {
    const title = ref.title.toLowerCase();
    return words.every((word) => title.includes(word));
  });
}

/**
 * "Client stays Kestrel" when the task's last change moved it to another project and its client,
 * being neither project's, stayed (the host moves one that was the old project's); and the line
 * for a new client that took it off another client's project, as the host does. `clientOf` is
 * each project's client key by project key, from the pickers' rows; an unknown project says nothing.
 */
export function kinWorkClientStays(
  item: Pick<KinRecordDetail, "party" | "project" | "changes">,
  clientOf: ReadonlyMap<string, string | null>,
): string | null {
  const { party, project } = item;
  const last = item.changes.reduce<KinRecordDetail["changes"][number] | null>(
    (newest, change) => (newest === null || change.seq > newest.seq ? change : newest),
    null,
  );
  const moved = last?.fields.find((field) => field.field === "project");
  if (
    party !== undefined &&
    project === undefined &&
    moved?.to === null &&
    moved.from !== null &&
    last?.fields.some((field) => field.field === "party") === true
  ) {
    const was = clientOf.get(moved.from);
    return was == null || was === party.key ? null : KIN_WORK_NEW_COPY.projectLeft(moved.from);
  }
  if (party === undefined || project === undefined || last === null || moved === undefined)
    return null;
  if (moved.to !== project.key || last.fields.some((field) => field.field === "party")) return null;
  const now = clientOf.get(project.key);
  const before = moved.from === null ? null : clientOf.get(moved.from);
  if (now === undefined || before === undefined) return null;
  return now === party.key || before === party.key
    ? null
    : KIN_WORK_NEW_COPY.clientStays(party.title);
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
  // The agent that gave it on its own says more than the authority it gave it with; one a person
  // asked is named after them: "Zoya gave this to you, via Chief of staff".
  const giver: KinWorkPrincipal | null =
    item.assignedByAgent === undefined
      ? item.assignedBy
      : { _tag: "agent", agentId: item.assignedByAgent };
  // Handed back, it is with whoever gave it, and the holder's words say why.
  const lastMove = item.changes.find((change) => change.fields.some((f) => f.field === "owner"));
  const handBack = lastMove?.fields.find((f) => f.field === "handedBack");
  const via =
    giver?._tag === "person" && lastMove !== undefined && lastMove.by._tag === "agent"
      ? `, via ${kinWorkActorName(lastMove.by, names)}`
      : "";
  const given =
    item.handedBack !== undefined && !kinWorkClosed(item.state)
      ? `Handed back by ${kinWorkName(item.handedBack.by, names, "you")} · ${formatKinTime(new Date(item.handedBack.at), now)}`
      : lastMove !== undefined && handBack !== undefined
        ? `${kinWorkActorName(lastMove.by, names)} handed this back · ${formatKinTime(new Date(lastMove.at), now)}`
        : giver === null ||
            kinWorkSamePrincipal(giver, item.owner) ||
            // An agent that made the task for itself was given it by no one.
            (item.assignedByAgent === undefined &&
              lastMove?.kind === "created" &&
              item.createdBy._tag !== "system" &&
              kinWorkSamePrincipal(item.createdBy, item.owner))
          ? null
          : [
              `${kinWorkName(giver, names)} gave this to ${kinWorkName(item.owner, names, "you")}${via}`,
              item.assignedAt === null ? null : formatKinTime(new Date(item.assignedAt), now),
            ]
              .filter((part) => part !== null)
              .join(" · ");
  // The latest link to one target says the most: "PR #12 merged" over "PR #12".
  const notes = item.notes.trim();
  // Only a host that takes changes sends a task's own change number.
  const editable = item.seq !== undefined;
  const isClosed = kinWorkClosed(item.state);
  const can = item.can ?? olderHostCan(item, editable, isClosed, names);
  const links = new Map<string, KinWorkLinkView>();
  for (const link of item.links) {
    const view = linkView(link, item.working, place, item.can?.links === true);
    if (view !== null) links.set(view.key, view);
  }
  const suggested = !item.confirmed && !isClosed;
  const lead = item.owner._tag === "agent";
  return {
    key: item.key,
    rev: item.rev,
    // A sheet's title: its key is a reference, never a title.
    heading: category ?? "Task",
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
    reason: handBack !== undefined ? (handBack.to ?? null) : item.reason?.trim() || null,
    handBackTo:
      !isClosed && isMe(item.owner, names) && giver !== null && !isMe(giver, names)
        ? kinWorkName(giver, names)
        : null,
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
      text: kinWorkChangeText(
        change,
        names,
        now,
        item.list === "invoices" || item.list === "receipts" ? item.list : "work",
      ),
    })),
    historyNote: item.changes.length >= changesCap ? "Earlier history isn't shown." : null,
    assignLabel: can.give ? "Give to someone else" : null,
    editable,
    closed: isClosed,
    suggestion: suggested
      ? `${item.createdBy._tag === "agent" ? kinWorkActorName(item.createdBy, names) : "An agent"} suggested this task.`
      : null,
    takeBack: can.takeBack,
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
    milestone:
      item.milestone === undefined
        ? null
        : { key: item.milestone.key, title: item.milestone.title },
    tasks: item.tasks === undefined ? null : item.tasks.map((task) => kinWorkRow(task, names, now)),
    side: item.side,
    // A task is private only by its own label; whoever holds it still sees it.
    privacy: kinWorkPrivacy({
      sensitive: item.sensitive,
      inherited: false,
      because: "its client or project",
      privateNote: `Only ${markerWord(item.markedBy ?? null, names) ?? "you"}, co-owners and whoever holds it see this.`,
    }),
    shared: item.shared === true,
    markedBy: item.markedBy ?? null,
    can,
    repeat:
      item.repeat === undefined ? null : { rule: item.repeat, text: kinRepeatText(item.repeat) },
    steps: kinWorkSteps({ ...item, can }),
    urgent: item.urgent === true,
  };
}

/**
 * Who a private mark keeps a task to, in this reader's words: null for "you". An older host, or a
 * mark from before it was recorded, reads as the owner's.
 */
const markerWord = (
  markedBy: KinPersonId | null,
  names: Pick<KinWorkNames, "me" | "owner" | "people">,
): string | null =>
  markedBy === null
    ? ownerWord(names)
    : markedBy === names.me
      ? null
      : kinMidSentence(kinWorkName({ _tag: "person", personId: markedBy }, names));

/** A host from before `can`: it took what its sheet offered then, and checked on the write. */
const olderHostCan = (
  item: KinRecordDetail,
  editable: boolean,
  closed: boolean,
  names: KinWorkNames,
): KinRecordCan => ({
  states: editable
    ? (["open", "doing", "waiting", "done", "dropped"] as const).filter(
        (state) => state !== item.state,
      )
    : [],
  edit: editable,
  party: editable,
  project: editable,
  clearProject: editable,
  give: !closed,
  takeBack: !closed && !isMe(item.owner, names),
  mark: editable,
  unmark: editable,
  share: editable,
  confirm: editable && !item.confirmed && !closed,
});

/** An all-day date as `YYYY-MM-DD` where the owner is; null with no date or a timed one. */
export function kinWorkAllDay(
  at: string | null,
  allDay: boolean,
  names: Pick<KinWorkNames, "zone">,
) {
  const date = at === null ? null : new Date(at);
  return date === null || !allDay || Number.isNaN(date.getTime())
    ? null
    : civilDayOf(dayInZone(date, names.zone));
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
  // A link or a project's note leaves `rev` alone: at the same `rev` the fresh read wins unless the
  // answer has seen more of the entry's changes (`seq`, links included).
  const item =
    given !== null &&
    (read === null ||
      given.rev > read.rev ||
      (given.rev === read.rev && (given.seq ?? -1) > (read.seq ?? -1)))
      ? given
      : read;
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
  leadsHint:
    "Given to an agent, it starts right away and works with your access. Its progress shows here.",
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
  /** Who owes it, which makes it an obligation; null for a plain task about the client. */
  readonly side: KinRecordSide | null;
  /** How it comes back once closed; null when it doesn't. */
  readonly repeat: KinRepeatRule | null;
}

export const KIN_WORK_NO_DRAFT: KinWorkDraft = {
  title: "",
  owner: null,
  due: null,
  notes: "",
  party: null,
  project: null,
  side: null,
  repeat: null,
};

/** A form opened from a client or a project starts out about it. */
export const kinWorkDraftFor = (
  about: Partial<Pick<KinWorkDraft, "party" | "project" | "side">>,
): KinWorkDraft => ({ ...KIN_WORK_NO_DRAFT, ...about });

/** The form's name and its first field, which say whose move it is when a client is set. */
export function kinWorkDraftWords(draft: Pick<KinWorkDraft, "party" | "side">): {
  readonly title: string;
  readonly titleLabel: string;
} {
  if (draft.party === null || draft.side === null)
    return {
      title: KIN_WORK_NEW,
      titleLabel: KIN_WORK_NEW_COPY.titleLabel,
    };
  return draft.side === "theirs"
    ? {
        title: `What ${draft.party.title} owes you`,
        titleLabel: "What they owe",
      }
    : {
        title: `What you owe ${draft.party.title}`,
        titleLabel: "What you owe them",
      };
}

export const KIN_WORK_NEW_COPY = {
  title: KIN_WORK_NEW,
  titleLabel: "What needs doing",
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
  /** Neither side: a plain task about the client, not something owed. */
  sideNone: "Nobody, it's a task",
  noMatch: "Nothing by that name.",
  /** A task moved to another project keeps a client that is neither project's. */
  clientStays: (name: string) => `Client stays ${name}`,
  /** A task given another client left its project, which is a different client's. */
  projectLeft: (key: string) => `No longer on ${key}: that project is another client's`,
};

/** What happens next, said before the owner commits to it. */
export function kinWorkDraftHint(draft: KinWorkDraft, names: KinWorkNames): string | null {
  return draft.owner?._tag === "agent"
    ? `${kinWorkName(draft.owner, names)} starts on it right away. Its progress shows here.`
    : null;
}

const pad = (value: number) => String(value).padStart(2, "0");
/** A local calendar day as the host takes it for an all-day date. */
export const kinWorkDayOf = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

/** A picked day read back for display: "Fri 14 Nov", counted from today in `zone`, the company's. */
export function kinWorkDueLabel(day: string, now: Date, zone: string | null = null): string {
  const [year, month, date] = day.split("-").map((part) => Number.parseInt(part, 10));
  const label = kinWorkDay(civilDay(year ?? 1970, month ?? 1, date ?? 1), dayInZone(now, zone));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** The days people actually pick, for a phone where a calendar is a lot of taps; today is `zone`'s. */
export function kinWorkDueChoices(
  now: Date,
  zone: string | null = null,
): ReadonlyArray<{ readonly label: string; readonly day: string }> {
  const today = dayInZone(now, zone);
  const at = (days: number) => civilDayOf(new Date(today.getTime() + days * DAY_MS));
  const weekday = today.getUTCDay();
  const toFriday = 5 - weekday;
  const toMonday = ((8 - weekday) % 7) + (weekday === 1 ? 7 : 0);
  return [
    { label: "Today", day: at(0) },
    { label: "Tomorrow", day: at(1) },
    ...(toFriday > 1 ? [{ label: "Friday", day: at(toFriday) }] : []),
    ...(toMonday > 1 ? [{ label: "Next Monday", day: at(toMonday) }] : []),
    { label: "In two weeks", day: at(14) },
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
  if (title.length > KIN_WORK_TITLE_MAX) return { ok: false, problem: KIN_WORK_TITLE_TOO_LONG };
  const notes = draft.notes.trim();
  if (notes.length > KIN_WORK_NOTES_MAX)
    return { ok: false, problem: "Those notes are too long. Say the rest in chat." };
  if (draft.due !== null && !dayPattern.test(draft.due))
    return { ok: false, problem: "That date doesn't look right." };
  if (draft.repeat !== null && draft.due === null)
    return { ok: false, problem: KIN_WORK_REPEAT.needsDue };
  return {
    ok: true,
    input: {
      title,
      ...(draft.owner === null ? {} : { owner: draft.owner }),
      ...(draft.due === null ? {} : { dueAt: draft.due, dueAllDay: true }),
      ...(notes === "" ? {} : { notes }),
      ...(draft.party === null ? {} : { party: draft.party.key }),
      ...(draft.project === null ? {} : { project: draft.project.key }),
      // Who owes it only means something between us and a client.
      ...(draft.side === null || draft.party === null
        ? {}
        : {
            category: "obligation" as const,
            ...(draft.side === "theirs" ? { side: "theirs" as const } : {}),
          }),
      ...(draft.repeat === null ? {} : { repeat: draft.repeat }),
    },
  };
}

// The owner's changes

const KIN_WORK_CLOSED_GIVE = "This task is closed. Reopen it before giving it to someone.";

/** What the owner was doing when the host refused, where that changes what to say. */
type Refused = "give" | "decline" | null;

/** Why a change didn't go through, in words for the owner (`kinFailure`). */
function problemOf(error: unknown, doing: Refused): string {
  if (isKinChatError(error) && error.reason === "invalid_state") {
    if (doing === "give") return KIN_WORK_CLOSED_GIVE;
    if (doing === "decline") return "This is already one of your tasks. Drop it instead.";
  }
  return kinFailureText(error, "That didn't go through.", {
    gone: "That isn't there any more. Someone may have left, or the task was removed.",
    device: "This device isn't allowed to change Work.",
  });
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

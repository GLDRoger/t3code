// @effect-diagnostics globalDate:off - Pure view helpers format host times and local days for React render, outside an Effect runtime.
import {
  kinCurrency,
  KIN_PULSE_URGENT,
  kinPulseFactRecord,
  type KinGoal,
  type KinPulseAside,
  type KinPulseFact,
  type KinPulseScope,
  type KinPulseScreenRead,
  type KinRecordKey,
  formatKinWhen,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { kinMoneyDraft, kinMoneyText } from "./kinLists.ts";
import { KIN_NEEDS_YOU_SHOWN, type KinNeedsYouRow } from "./kinWorkHome.ts";
import { kinFailure } from "./kinAnswers.ts";
import { kinIsDealKey } from "./kinDeals.ts";

/**
 * "Needs attention": what Kin worked out needs someone, on the screens it is about. One model for
 * web and mobile: which facts a screen shows, how a row reads, and the three answers to it.
 */

export const KIN_ATTENTION = {
  title: "Needs attention",
  gotIt: "I've got it",
  notAProblem: "Not a problem",
  handled: "Handled",
  undo: "Undo",
  ask: (name: string) => `Ask ${name}`,
  snoozeTomorrow: "Snooze until tomorrow",
  snoozeMonday: "Snooze until Monday",
  snoozeWeek: "Snooze for a week",
  setAside: "Set aside until…",
  setAsideTitle: "Set aside until",
  setAsideDay: "Until this day",
  untilLifted: "Until I lift it",
  setAsideSave: "Set aside",
  cancel: "Cancel",
  failed: "Couldn't save that.",
  whatsNext: "What's next?",
  notNow: "Not now",
} as const;

/** "Not now" on a deal with no next step: its own hold, this many days. */
const KIN_NOT_NOW_DAYS = 14;

/** Where a row opens: the entry itself, Money, or nowhere of its own (ask the agent instead). */
export type KinAttentionOpen =
  | { readonly type: "record"; readonly key: KinRecordKey }
  | { readonly type: "money" }
  | { readonly type: "none" };

export interface KinAttentionRow {
  readonly id: string;
  readonly factKey: string;
  readonly title: string;
  readonly detail: string;
  /** The project or client it is about, when the screen isn't already that one. */
  readonly about: string | null;
  /** A date is missed or money is owed now, not only soon. */
  readonly urgent: boolean;
  readonly open: KinAttentionOpen;
  /** The agent that should act, for "Ask"; null when it is a person's or the owner's. */
  readonly agentId: string | null;
  /** What "Ask" puts in the chat, so the agent knows what it is about. */
  readonly askDraft: string;
  /** In the Handled list: who has it, until when, or that it is not a problem. */
  readonly handled: string | null;
  /** About money: Tasks counts these in one row that opens Money, which lists them. */
  readonly money: boolean;
  /** The record it is about, which "Set aside until…" holds; null when it is not a record. */
  readonly record: KinRecordKey | null;
  /** A deal with no next step: "What's next?" opens it, "Not now" holds it for 14 days. */
  readonly whatsNext: KinRecordKey | null;
}

/** A record set aside, one row in Handled whatever it covers, with its Undo when it is yours. */
export interface KinAsideRow {
  readonly id: string;
  readonly record: KinRecordKey;
  readonly title: string;
  /** "Set aside until 17 Dec · by Finance, on your word". */
  readonly detail: string;
  readonly liftable: boolean;
}

/** Which facts a screen is about: the whole company, one project, one client, or Money. */
export type KinAttentionScope =
  | { readonly type: "all" }
  | { readonly type: "project"; readonly key: KinRecordKey }
  | { readonly type: "client"; readonly key: KinRecordKey }
  | { readonly type: "money" };

const URGENT = KIN_PULSE_URGENT;

/** Open facts Needs you asks for: the rows it shows before "See all", and some to spare. */
export const KIN_NEEDS_YOU_PAGE = 8;

/** A client's own matters, and its tasks that are late or due. */
const CLIENT_MATTERS = new Set<KinPulseFact["sense"]>([
  "task_late",
  "task_due_soon",
  "client_cold",
  "client_quiet",
  "client_waiting_on_us",
  "theirs_late",
  "quote_unanswered",
  "invoice_overdue",
  "retainer_due",
  "renewal_due",
  "deal_no_next_step",
  "deal_quiet",
  "deal_date_passed",
  "notice_due",
]);

/** The host's filter for a scope: what it sends covers what `inScope` keeps. */
export const kinPulseScopeOf = (scope: KinAttentionScope): KinPulseScope =>
  scope.type === "project"
    ? { project: scope.key }
    : scope.type === "client"
      ? { client: scope.key }
      : scope.type === "money"
        ? { family: "money" }
        : {};

const inScope = (fact: KinPulseFact, scope: KinAttentionScope) => {
  switch (scope.type) {
    case "all":
      return true;
    case "project":
      return fact.scope.projectKey === scope.key;
    case "client":
      return fact.scope.clientKey === scope.key && CLIENT_MATTERS.has(fact.sense);
    case "money":
      // Goals sit above it on Money with their own bars; Tasks keeps their answers.
      return fact.family === "money";
  }
};

const openOf = (fact: KinPulseFact): KinAttentionOpen =>
  fact.family === "goals" || fact.subject.kind === "budget"
    ? { type: "money" }
    : fact.subject.kind === "record"
      ? { type: "record", key: fact.subject.key }
      : { type: "none" };

const dayLabel = (at: DateTime.Utc, now: Date) =>
  formatKinWhen(
    DateTime.toEpochMillis(at),
    new Date(DateTime.toEpochMillis(at)).getFullYear() === now.getFullYear() ? "date" : "dateYear",
  );

const handledText = (fact: KinPulseFact, names: ReadonlyMap<string, string>, now: Date) => {
  const handled = fact.handled;
  if (handled === null) return null;
  const by =
    handled.by._tag === "agent"
      ? (names.get(handled.by.agentId) ?? "An agent")
      : (names.get(handled.by.personId) ?? "Someone");
  return handled.until === null
    ? `${by}: not a problem`
    : `${by} has it until ${dayLabel(handled.until, now)}`;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The host words its facts for agents, with ISO days; a person reads "Nov 12" and "November". */
export function kinPlainDates(text: string): string {
  return text
    .replace(/ \((\d{4}-\d{2}-\d{2})\)/g, "")
    .replace(
      /\b(\d{4})-(\d{2})-(\d{2})\b/g,
      (_, _year, month: string, day: string) =>
        `${MONTHS[Number(month) - 1]?.slice(0, 3) ?? month} ${Number(day)}`,
    )
    .replace(
      /\b(\d{4})-(\d{2})\b/g,
      (_, _year, month: string) => MONTHS[Number(month) - 1] ?? month,
    );
}

function kinAttentionRow(
  fact: KinPulseFact,
  input: {
    readonly scope: KinAttentionScope;
    readonly names: ReadonlyMap<string, string>;
    readonly now: Date;
  },
): KinAttentionRow {
  const { subject, scope } = fact;
  const label = subject.kind === "record" ? `${subject.key} ${subject.title}` : subject.title;
  const where = [
    input.scope.type === "project" ? null : (scope.projectTitle ?? null),
    input.scope.type === "client" || input.scope.type === "project"
      ? null
      : (scope.clientTitle ?? null),
  ].filter((part) => part !== null && part !== subject.title);
  return {
    id: fact.key,
    factKey: fact.key,
    title: subject.title,
    detail: kinPlainDates(fact.consequence),
    about:
      [subject.kind === "record" ? subject.key : null, ...where]
        .filter((part) => part !== null)
        .join(" · ") || null,
    urgent: URGENT.has(fact.sense),
    open: openOf(fact),
    agentId: fact.actor._tag === "agent" ? fact.actor.agentId : null,
    askDraft: `About ${label}: ${fact.consequence} `,
    handled: handledText(fact, input.names, input.now),
    money: fact.family === "money",
    record: subject.kind === "record" ? subject.key : null,
    whatsNext:
      fact.sense === "deal_no_next_step" && subject.kind === "record" && kinIsDealKey(subject.key)
        ? subject.key
        : null,
  };
}

/** How a hold reads: until when, who set it and on whose word. */
function kinAsideText(aside: KinPulseAside, names: ReadonlyMap<string, string>, now: Date): string {
  const until =
    aside.until === null
      ? "Set aside until lifted"
      : `Set aside until ${dayLabel(aside.until, now)}`;
  const setBy =
    aside.by._tag === "agent"
      ? (names.get(aside.by.agentId) ?? "an agent")
      : (names.get(aside.by.personId) ?? "someone");
  const by = aside.byYou ? "by you" : `by ${setBy}`;
  const word = aside.yourWord
    ? ", on your word"
    : aside.onWordOf === null ||
        aside.onWordOf === (aside.by._tag === "person" ? aside.by.personId : null)
      ? ""
      : `, on ${names.get(aside.onWordOf) ?? "someone"}'s word`;
  return `${until} · ${by}${word}`;
}

const asideRow = (
  aside: KinPulseAside,
  names: ReadonlyMap<string, string>,
  now: Date,
): KinAsideRow => ({
  id: `aside:${aside.record.key}`,
  record: aside.record.key,
  title: aside.record.title,
  detail: kinAsideText(aside, names, now),
  liftable: aside.liftable,
});

/** The hold on this record itself, for one quiet line on its own page; null when none. */
export function kinAsideOf(
  read: KinPulseScreenRead | null,
  key: KinRecordKey,
  input: { readonly names: ReadonlyMap<string, string>; readonly now: Date },
): KinAsideRow | null {
  const aside = read?.setAside?.find((one) => one.record.key === key);
  return aside === undefined ? null : asideRow(aside, input.names, input.now);
}

/**
 * What a screen shows: the open facts in its scope, most urgent first, and the ones someone
 * handled, for the Handled list and its Undo. Null while nothing has been read.
 */
export function kinAttention(
  read: KinPulseScreenRead | null,
  input: {
    readonly scope: KinAttentionScope;
    readonly names: ReadonlyMap<string, string>;
    readonly now: Date;
  },
): {
  readonly open: ReadonlyArray<KinAttentionRow>;
  readonly handled: ReadonlyArray<KinAttentionRow>;
  /** What is set aside here, one row per record; a fact under one is not in `handled`. */
  readonly asides: ReadonlyArray<KinAsideRow>;
  /** The facts those cover: not drawn, but what they are about is answered. */
  readonly held: ReadonlyArray<KinAttentionRow>;
} {
  if (read === null) return { open: [], handled: [], asides: [], held: [] };
  const facts = read.facts.filter((fact) => inScope(fact, input.scope));
  const covering = new Set(facts.flatMap((fact) => (fact.aside ? [fact.aside.record.key] : [])));
  const scopeKey =
    input.scope.type === "client" || input.scope.type === "project" ? input.scope.key : null;
  const asides = (read.setAside ?? [])
    .filter(
      (aside) =>
        input.scope.type === "all" ||
        aside.record.key === scopeKey ||
        covering.has(aside.record.key),
    )
    .map((aside) => asideRow(aside, input.names, input.now));
  const rows = (list: ReadonlyArray<KinPulseFact>) =>
    [...list]
      .sort((a, b) => Number(URGENT.has(b.sense)) - Number(URGENT.has(a.sense)))
      .map((fact) => kinAttentionRow(fact, input));
  // An older host sends no list of holds: its held facts stay rows of their own.
  const listed = new Set((read.setAside ?? []).map((aside) => aside.record.key));
  return {
    open: rows(facts.filter((fact) => fact.handled === null)),
    handled: rows(
      facts.filter(
        (fact) =>
          fact.handled !== null && (fact.aside === undefined || !listed.has(fact.aside.record.key)),
      ),
    ),
    asides,
    held: rows(
      facts.filter((fact) => fact.aside !== undefined && listed.has(fact.aside.record.key)),
    ),
  };
}

/**
 * Tasks shows what isn't money row by row, and money as one count that opens Money. From a paged
 * read (`outline`), `hidden` counts the open rows past the page.
 */
export function kinTasksAttention(
  open: ReadonlyArray<KinAttentionRow>,
  read?: KinPulseScreenRead | null,
): {
  readonly rows: ReadonlyArray<KinAttentionRow>;
  readonly hidden: number;
  readonly money: number;
  readonly moneyRow: KinNeedsYouRow | null;
} {
  const outline = read?.outline;
  const rows = open.filter((row) => !row.money);
  const money = outline?.money ?? open.filter((row) => row.money).length;
  const late = outline?.moneyUrgent ?? open.some((row) => row.money && row.urgent);
  return {
    rows,
    hidden: outline === undefined ? 0 : Math.max(0, outline.open - outline.money - rows.length),
    money,
    moneyRow:
      money === 0
        ? null
        : {
            id: "attention:money",
            kind: "money",
            title: "Money",
            detail: money === 1 ? "1 thing needs attention" : `${money} things need attention`,
            late,
            open: { type: "money" },
            count: money,
          },
  };
}

/**
 * The read as it stands once these answers were tapped: a fact answered here leaves at once and
 * the live read brings it back, as handled or open again (after an Undo), when it changes.
 */
export function kinAttentionShown(
  read: KinPulseScreenRead | null,
  answered: ReadonlySet<string>,
): KinPulseScreenRead | null {
  if (read === null || answered.size === 0) return read;
  const gone = read.facts.filter((fact) => fact.handled === null && answered.has(fact.key));
  if (gone.length === 0) return read;
  const facts = read.facts.filter((fact) => fact.handled !== null || !answered.has(fact.key));
  const { outline } = read;
  if (outline === undefined) return { ...read, facts };
  const money = gone.filter((fact) => fact.family === "money").length;
  return {
    ...read,
    facts,
    outline: {
      ...outline,
      open: Math.max(0, outline.open - gone.length),
      money: Math.max(0, outline.money - money),
      // As a full read would: an answered fact covers its task only once it is back as handled.
      records: outline.records.filter(
        (key) => !gone.some((fact) => kinPulseFactRecord(fact) === key),
      ),
    },
  };
}

/**
 * What a tap on an answer leaves to say: nothing once it went through, and nothing when the fact
 * is no longer current, since it is already sorted (`kinFailure`'s "gone").
 */
export function kinAttentionProblem(failure: unknown | null): string | null {
  if (failure === null) return null;
  const said = kinFailure(failure, KIN_ATTENTION.failed);
  return said.kind === "gone" ? null : said.text;
}

/** The badge on Tasks: what needs attention and nobody has in hand yet. */
export const kinAttentionCount = (read: KinPulseScreenRead | null) =>
  read === null
    ? 0
    : (read.outline?.open ?? read.facts.filter((fact) => fact.handled === null).length);

/** The badge's text: nothing at zero, and "99+" past what fits. */
export const kinAttentionBadge = (count: number) =>
  count === 0 ? null : count > 99 ? "99+" : String(count);

/**
 * "Needs you" on Tasks is fed by both: what needs attention, then what it showed before without
 * the tasks and the overdue-money row the attention rows already cover.
 */
export function kinNeedsYouBeside(
  rows: ReadonlyArray<KinNeedsYouRow>,
  { open, handled, held }: ReturnType<typeof kinAttention>,
  read?: KinPulseScreenRead | null,
): ReadonlyArray<KinNeedsYouRow> {
  // Something already answered stays answered here too, not back as a plain row.
  const attention = [...open, ...handled, ...held];
  const outline = read?.outline;
  const covered = new Set<string>(
    outline?.records ??
      attention.flatMap((row) => (row.open.type === "record" ? [row.open.key] : [])),
  );
  const money =
    outline?.invoiceOverdue ?? attention.some((row) => row.factKey.startsWith("invoice_overdue:"));
  return rows.filter(
    (row) =>
      !(row.open.type === "task" && covered.has(row.open.key)) &&
      !(money && row.id === "money:overdue"),
  );
}

/**
 * The block over Tasks, the owner's and a co-owner's only: company-wide things, never drawing a
 * task the list already shows under "On me", which carries its own mark, though it counts it.
 * Null when nothing is in it.
 */
export function kinTasksBlock(input: {
  readonly ownerLevel: boolean;
  /** The keys the list shows under "On me". */
  readonly onMe: ReadonlySet<string>;
  readonly attention: ReadonlyArray<KinAttentionRow>;
  readonly needs: ReadonlyArray<KinNeedsYouRow>;
  /** Open facts past the page read, counted by the host. */
  readonly hidden: number;
  /** Answered rows, kept for their Undo until the read lets them go. */
  readonly handled: number;
  /** After "See all": every row, not the first few. */
  readonly expanded: boolean;
}): {
  readonly attention: ReadonlyArray<KinAttentionRow>;
  readonly needs: ReadonlyArray<KinNeedsYouRow>;
  /**
   * Every thing, as the Tasks badge counts them, the ones under "On me" included: Money's row is
   * as many as it says.
   */
  readonly total: number;
  /** Of `total`, the things drawn under "On me" below rather than here. */
  readonly onMe: number;
  /** Whether rows sit past the first few, so "See all" has something to show. */
  readonly more: boolean;
} | null {
  if (!input.ownerLevel) return null;
  const attention = input.attention.filter(
    (row) => !(row.open.type === "record" && input.onMe.has(row.open.key)),
  );
  const needs = input.needs.filter(
    (row) => !(row.open.type === "task" && input.onMe.has(row.open.key)),
  );
  if (attention.length === 0 && needs.length === 0 && input.handled === 0) return null;
  const rows = attention.length + needs.length + input.hidden;
  const onMe = input.attention.length - attention.length + input.needs.length - needs.length;
  const total = rows + onMe + input.needs.reduce((sum, row) => sum + (row.count ?? 1) - 1, 0);
  // The rows it shows, so the list below keeps every task the block doesn't. A money row leads,
  // so a long run of attention rows never hides it.
  const limit = input.expanded ? rows : KIN_NEEDS_YOU_SHOWN;
  const lead = needs[0]?.id === "attention:money" ? 1 : 0;
  const shownAttention = attention.slice(0, Math.max(0, limit - lead));
  return {
    attention: shownAttention,
    needs: [
      ...needs.slice(0, lead),
      ...needs.slice(lead, lead + Math.max(0, limit - lead - shownAttention.length)),
    ],
    total,
    onMe,
    more: rows > KIN_NEEDS_YOU_SHOWN,
  };
}

/**
 * The badge on Tasks, each thing once: for the owner and a co-owner what needs attention; for
 * anyone else their own late and due-today tasks, the ones "On me" marks.
 */
export const kinTasksBadgeCount = (input: {
  readonly ownerLevel: boolean;
  readonly attention: KinPulseScreenRead | null;
  readonly mineDue: ReadonlyArray<unknown> | null;
}) => (input.ownerLevel ? kinAttentionCount(input.attention) : (input.mineDue?.length ?? 0));

const pad = (value: number) => String(value).padStart(2, "0");
const dayOf = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const plusDays = (date: Date, days: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/** Snooze's three choices, as the days the host hides a row until. */
export function kinSnoozeDays(now: Date) {
  const toMonday = (8 - now.getDay()) % 7 || 7;
  return [
    { label: KIN_ATTENTION.snoozeTomorrow, until: dayOf(plusDays(now, 1)) },
    { label: KIN_ATTENTION.snoozeMonday, until: dayOf(plusDays(now, toMonday)) },
    { label: KIN_ATTENTION.snoozeWeek, until: dayOf(plusDays(now, 7)) },
  ] as const;
}

/** The day "Not now" holds a deal with no next step until. */
export const kinNotNowUntil = (now: Date) => dayOf(plusDays(now, KIN_NOT_NOW_DAYS));

/** "Set aside until…": the first day it may be set to (tomorrow) and the day it starts on. */
export function kinSetAsideDays(now: Date) {
  return { min: dayOf(plusDays(now, 1)), initial: dayOf(plusDays(now, 30)) } as const;
}

// Goals

export const KIN_GOALS = {
  saveFailed: "Couldn't save the goal.",
  title: "Goals",
  add: "Add goal",
  edit: "Edit goal",
  name: "Name",
  measure: "Measures",
  target: "Target",
  current: "Now at",
  unit: "Counts",
  startsOn: "From",
  dueOn: "By",
  save: "Save",
  reached: "Mark reached",
  remove: "Remove goal",
  behind: "Behind",
  onTrack: "On track",
  reachedLabel: "Reached",
  measures: {
    revenue_received: "Money received",
    clients_won: "Clients won",
    tasks_done: "Tasks done",
    manual: "A number we update",
  } satisfies Record<KinGoal["measure"], string>,
  targetHint: {
    revenue_received: "40 lakh, ₹40,00,000",
    clients_won: "5",
    tasks_done: "40",
    manual: "2",
  } satisfies Record<KinGoal["measure"], string>,
} as const;

export interface KinGoalView {
  readonly key: KinRecordKey;
  readonly title: string;
  /** "₹12,00,000 of ₹40,00,000". */
  readonly figure: string;
  /** "By 31 Mar · ₹18,00,000 expected by now". */
  readonly detail: string;
  /** 0 to 1, for the bar. */
  readonly progress: number;
  /** Where the straight line stands, 0 to 1, marked on the bar. */
  readonly pace: number;
  readonly status: "behind" | "on_track" | "reached";
}

/** A goal's figure rounded to whole units of its currency, as its decimals say. */
const wholeUnits = (minor: number, currency: string) => {
  const unit = 10 ** kinCurrency(currency).decimals;
  return Math.round(minor / unit) * unit;
};
const figureOf = (goal: KinGoal, value: number, withUnit = true) =>
  goal.currency === undefined
    ? `${Math.round(value)}${goal.unit === undefined || !withUnit ? "" : ` ${goal.unit}`}`
    : kinMoneyText({ minor: wholeUnits(value, goal.currency), currency: goal.currency });

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const shortDay = (day: string, now: Date) => {
  const [year, month, date] = day.split("-").map(Number);
  return formatKinWhen(
    new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1),
    year === now.getFullYear() ? "date" : "dateYear",
  );
};

export function kinGoalView(goal: KinGoal, now: Date): KinGoalView {
  const reached = goal.state === "done" || goal.current >= goal.target;
  return {
    key: goal.key,
    title: goal.title,
    figure: `${figureOf(goal, goal.current, false)} of ${figureOf(goal, goal.target)}`,
    detail: [
      goal.dueOn === null ? null : `By ${shortDay(goal.dueOn, now)}`,
      reached || goal.dueOn === null ? null : `${figureOf(goal, goal.expected)} expected by now`,
    ]
      .filter((part) => part !== null)
      .join(" · "),
    progress: clamp(goal.current / goal.target),
    pace: clamp(goal.expected / goal.target),
    status: reached ? "reached" : goal.behind ? "behind" : "on_track",
  };
}

/** Goals in a line: how many are behind, else how many are reached or on track. */
export function kinGoalsSummary(views: ReadonlyArray<Pick<KinGoalView, "status">>): string {
  const count = (status: KinGoalView["status"]) =>
    views.filter((one) => one.status === status).length;
  return [
    count("behind") === 0 ? null : `${count("behind")} behind`,
    count("on_track") === 0 ? null : `${count("on_track")} on track`,
    count("reached") === 0 ? null : `${count("reached")} reached`,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

/** A goal as its edit sheet starts: the figures as a person would type them. */
export function kinGoalDraft(goal: KinGoal | null, now: Date) {
  const today = dayOf(now);
  if (goal === null)
    return {
      title: "",
      measure: "revenue_received" as KinGoal["measure"],
      target: "",
      current: "",
      unit: "",
      startsOn: today,
      dueOn: dayOf(new Date(now.getFullYear(), now.getMonth() + 3, now.getDate())),
    };
  return {
    title: goal.title,
    measure: goal.measure,
    target:
      goal.currency === undefined
        ? String(goal.target)
        : kinMoneyDraft({ minor: goal.target, currency: goal.currency }, goal.currency),
    current: goal.measure === "manual" ? String(goal.current) : "",
    unit: goal.unit ?? "",
    startsOn: goal.startsOn,
    dueOn: goal.dueOn ?? today,
  };
}
export type KinGoalDraft = ReturnType<typeof kinGoalDraft>;

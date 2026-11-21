import type { KinBrief, KinBriefSaveInput, KinCheckIn, KinCoveringBrief } from "@t3tools/contracts";

import { kinZoneLabel } from "./kinTimeZone.ts";

export const KIN_CHECK_INS = {
  title: "Check-ins",
  detail: "When your agents look over what needs attention and tell you what moved.",
  zone: (zone: string) => `Times are in ${kinZoneLabel(zone)}.`,
  empty: "No check-ins. Add one to have an agent look over the company at a set time.",
  add: "Add check-in",
  edit: "Edit check-in",
  save: "Save check-in",
  runNow: "Run now",
  runNowPending: "Starting…",
  turnOff: "Turn off",
  turnOn: "Turn on",
  remove: "Remove",
  removeConfirm: "Remove this check-in? Its agent stops running it.",
  off: "Off",
  name: "Name",
  what: "What it's for",
  agent: "Agent",
  time: "Time",
  days: "Days",
  pipeline: "Add the pipeline to Monday's numbers",
  pipelineDetail:
    "Three lines Kin counts: what's open, last week's wins and losses, and late follow-ups.",
  failed: "Couldn't change the check-in.",
  unreadable: "Couldn't load check-ins.",
  newTitle: "Check-in",
  newWhat:
    "Look over what needs attention and what came in since the last check-in, and move what you can.",
} as const;

/**
 * The weekly brief's pipeline switch: on or off, or null for a check-in that has none (every
 * other one, and any from an older host).
 */
export const kinCheckInPipeline = (checkIn: Pick<KinCheckIn, "numbers"> | null) =>
  checkIn?.numbers === undefined ? null : checkIn.numbers.includes("pipeline");

/** Monday first, as a week reads; values are JavaScript's (0 is Sunday). */
export const KIN_WEEKDAYS = [
  { day: 1, short: "Mon", long: "Monday" },
  { day: 2, short: "Tue", long: "Tuesday" },
  { day: 3, short: "Wed", long: "Wednesday" },
  { day: 4, short: "Thu", long: "Thursday" },
  { day: 5, short: "Fri", long: "Friday" },
  { day: 6, short: "Sat", long: "Saturday" },
  { day: 0, short: "Sun", long: "Sunday" },
] as const;

const same = (days: ReadonlyArray<number>, want: ReadonlyArray<number>) =>
  days.length === want.length && want.every((day) => days.includes(day));

/** "Weekdays", "Every day", "Mondays", or "Mon, Wed, Fri". */
export function kinCheckInDays(days: ReadonlyArray<number>): string {
  if (same(days, [0, 1, 2, 3, 4, 5, 6])) return "Every day";
  if (same(days, [1, 2, 3, 4, 5])) return "Weekdays";
  if (same(days, [0, 6])) return "Weekends";
  const named = KIN_WEEKDAYS.filter(({ day }) => days.includes(day));
  return named.length === 1 ? `${named[0]!.long}s` : named.map(({ short }) => short).join(", ");
}

/** "Around 09:30 · Weekdays · Chief of staff": the row's one line. */
export function kinCheckInLine(checkIn: KinCheckIn): string {
  return `${checkIn.around === true ? "Around " : ""}${checkIn.at} · ${kinCheckInDays(checkIn.days)} · ${checkIn.agentName}`;
}

const COVERED: Record<KinCoveringBrief, string> = {
  weekly: "The weekly brief covers it today.",
  morning: "The morning brief covers it today.",
};
/** Why a morning or weekly brief isn't sent today, the company's day; null when nothing stopped it. */
export const kinCoveredLine = (row: { readonly coveredToday?: KinCoveringBrief | undefined }) =>
  row.coveredToday === undefined ? null : COVERED[row.coveredToday];

export interface KinCheckInDraft {
  readonly scheduleId: KinCheckIn["scheduleId"] | undefined;
  readonly agentId: KinCheckIn["agentId"] | null;
  readonly title: string;
  readonly what: string;
  readonly at: string;
  readonly days: ReadonlyArray<number>;
}

export function kinCheckInDraft(
  checkIn: KinCheckIn | null,
  firstAgent: KinCheckIn["agentId"] | null,
): KinCheckInDraft {
  return checkIn === null
    ? {
        scheduleId: undefined,
        agentId: firstAgent,
        title: KIN_CHECK_INS.newTitle,
        what: KIN_CHECK_INS.newWhat,
        at: "10:00",
        days: [1, 2, 3, 4, 5],
      }
    : { ...checkIn, scheduleId: checkIn.scheduleId };
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Null when the draft can be saved, else what to fix. */
export function kinCheckInProblem(draft: KinCheckInDraft): string | null {
  if (draft.agentId === null) return "Pick an agent to run it.";
  if (draft.title.trim() === "") return "Give it a name.";
  if (draft.what.trim() === "") return "Say what it's for.";
  if (!CLOCK.test(draft.at)) return "Set a time such as 09:30.";
  if (draft.days.length === 0) return "Pick at least one day.";
  return null;
}

/** A person's own briefs, under You in Settings: the seeded check-ins they receive. */
export const KIN_BRIEFS = {
  title: "Briefs",
  detail: "When Kin sends you the day's briefs.",
  titles: {
    morning: "Morning brief",
    afternoon: "Afternoon check-in",
    evening: "Evening summary",
    page: "Morning page",
  },
  edit: "Change",
  save: "Save",
  time: "Time",
  days: "Days",
  on: "On",
  off: "Off",
  loading: "Loading briefs",
  failed: "Couldn't change your brief. It stays as it was.",
} as const;

/** "Around 09:30 · Every day", or "Off · Around 18:30 · Weekdays". */
export function kinBriefLine(brief: KinBrief): string {
  const line = `${brief.around ? "Around " : ""}${brief.at} · ${kinCheckInDays(brief.days)}`;
  return brief.on ? line : `${KIN_BRIEFS.off} · ${line}`;
}

/** The check-in a brief is: the server seeds each as `checkin-<kind>`. */
export const kinBriefScheduleId = (kind: KinBrief["kind"]) => `checkin-${kind}`;

/** The company's check-ins less the ones this person already sees as their briefs. */
export const kinCheckInsBeyondBriefs = (
  checkIns: ReadonlyArray<KinCheckIn>,
  briefs: ReadonlyArray<Pick<KinBrief, "kind" | "page">>,
) =>
  checkIns.filter(
    (checkIn) =>
      !briefs.some(
        (brief) => brief.page !== true && checkIn.scheduleId === kinBriefScheduleId(brief.kind),
      ),
  );

/** The morning brief comes on the days its person picks; the other two are on or off. */
export const kinBriefHasDays = (kind: KinBrief["kind"]) => kind === "morning";

/** Kin's own morning page has days and can be off too; the owner's morning brief always comes. */
export const kinBriefTurnsOff = (brief: Pick<KinBrief, "kind" | "page">) =>
  brief.page === true || !kinBriefHasDays(brief.kind);

export const kinBriefTitle = (brief: Pick<KinBrief, "kind" | "page">) =>
  brief.page === true ? KIN_BRIEFS.titles.page : KIN_BRIEFS.titles[brief.kind];

/** Null when the brief can be saved as drafted, else what to fix. */
export function kinBriefProblem(draft: Pick<KinBrief, "at" | "days">): string | null {
  if (!CLOCK.test(draft.at)) return "Set a time such as 09:30.";
  if (draft.days.length === 0) return "Pick at least one day.";
  return null;
}

/** The save of a brief's form: what it changed from the brief as it opened, and only that. */
export function kinBriefSave(opened: KinBrief, draft: KinBrief) {
  const days = (brief: KinBrief) => [...brief.days].sort((a, b) => a - b).join();
  const changed: Array<NonNullable<KinBriefSaveInput["changed"]>[number]> = [];
  if (draft.at !== opened.at) changed.push("at");
  if (days(draft) !== days(opened)) changed.push("days");
  if (draft.on !== opened.on) changed.push("on");
  return { kind: draft.kind, at: draft.at, days: draft.days, on: draft.on, changed };
}

import type { KinCheckIn } from "@t3tools/contracts";

export const KIN_CHECK_INS = {
  title: "Check-ins",
  detail: "When your agents look over what needs attention and tell you what moved.",
  zone: (zone: string) => `Times are in ${zone}.`,
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
  failed: "Couldn't change the check-in.",
  unreadable: "Couldn't load check-ins.",
  newTitle: "Check-in",
  newWhat:
    "Look over what needs attention and what came in since the last check-in, and move what you can.",
} as const;

/** Monday first, as a week reads; values are JavaScript's (0 is Sunday). */
export const KIN_WEEKDAYS = [
  { day: 1, short: "Mon" },
  { day: 2, short: "Tue" },
  { day: 3, short: "Wed" },
  { day: 4, short: "Thu" },
  { day: 5, short: "Fri" },
  { day: 6, short: "Sat" },
  { day: 0, short: "Sun" },
] as const;

const same = (days: ReadonlyArray<number>, want: ReadonlyArray<number>) =>
  days.length === want.length && want.every((day) => days.includes(day));

/** "Weekdays", "Every day", "Mondays", or "Mon, Wed, Fri". */
export function kinCheckInDays(days: ReadonlyArray<number>): string {
  if (same(days, [0, 1, 2, 3, 4, 5, 6])) return "Every day";
  if (same(days, [1, 2, 3, 4, 5])) return "Weekdays";
  if (same(days, [0, 6])) return "Weekends";
  const named = KIN_WEEKDAYS.filter(({ day }) => days.includes(day));
  return named.length === 1 ? `${named[0]!.short}s` : named.map(({ short }) => short).join(", ");
}

/** "Around 09:30 · Weekdays · Chief of staff": the row's one line. */
export function kinCheckInLine(checkIn: KinCheckIn): string {
  return `${checkIn.around === true ? "Around " : ""}${checkIn.at} · ${kinCheckInDays(checkIn.days)} · ${checkIn.agentName}`;
}

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

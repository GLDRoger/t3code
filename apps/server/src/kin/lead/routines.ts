import type {
  KinLeadRoutine,
  KinMemoryItemId,
  KinRoutineCard,
  KinRoutineSection,
  KinWidgetId,
} from "@t3tools/contracts";

/** The most lines a morning brief or evening summary body may have, widgets aside. */
export const ROUTINE_MAX_LINES = 12;
const LINE_MAX = 200;
const INLINE_ENTRIES = 3;
const CARD_ROWS = 60;
const TEXT_MAX = 280;

export interface RoutineRow {
  readonly title: string;
  readonly note?: string;
  readonly itemId?: KinMemoryItemId;
  readonly link?: string;
  readonly widgetId?: KinWidgetId;
}

export interface MorningFacts {
  readonly routine: "morning_brief";
  readonly dueToday: ReadonlyArray<RoutineRow>;
  /** Owner-local Mondays only; other days leave it empty. */
  readonly dueThisWeek: ReadonlyArray<RoutineRow>;
  readonly overdue: ReadonlyArray<RoutineRow>;
  readonly waiting: ReadonlyArray<RoutineRow>;
  readonly reviews: ReadonlyArray<RoutineRow>;
  readonly ciRed: ReadonlyArray<RoutineRow>;
  /** `off` without the Kin App; otherwise what the read missed, empty when complete. */
  readonly github: "off" | ReadonlyArray<RoutineGithubGap>;
  readonly objectives: ReadonlyArray<RoutineRow>;
  readonly workersRunning: number;
  readonly workersBlocked: ReadonlyArray<RoutineRow>;
  readonly postponed: number;
  readonly yesterdayUnits: number | null;
  readonly pastReview: ReadonlyArray<RoutineRow>;
}

export type RoutineGithubGap = "unread_repos" | "more_pulls" | "no_login";

export interface EveningFacts {
  readonly routine: "evening_summary";
  readonly done: ReadonlyArray<RoutineRow>;
  readonly slipped: ReadonlyArray<RoutineRow>;
  readonly promised: ReadonlyArray<RoutineRow>;
  readonly waiting: ReadonlyArray<RoutineRow>;
  readonly dueTomorrow: ReadonlyArray<RoutineRow>;
  readonly units: number | null;
  readonly cacheHitRate: number | null;
  readonly failedWakeups: number;
  readonly failedDreams: number;
}

export interface RoutineHeader {
  readonly day: string;
  readonly dayLabel: string;
  readonly dueLabel: string | null;
  readonly lateByMs: number;
  readonly folded: ReadonlyArray<{ readonly routine: KinLeadRoutine; readonly dayLabel: string }>;
}

const names: Record<KinLeadRoutine, string> = {
  morning_brief: "Morning brief",
  evening_summary: "Evening summary",
  owner_check: "Owner check",
};
const LATE_NOTE_MS = 15 * 60_000;
const githubGaps: Record<RoutineGithubGap, string> = {
  unread_repos: "some repositories could not be read",
  more_pulls: "only the 50 most recently updated open PRs per repository were checked",
  no_login: "your profile has no GitHub login, so review requests were not checked",
};

const clip = (value: string, max: number) => {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  // Never leave half of an escape pair at the cut.
  return `${(cut.match(/\\+$/)?.[0].length ?? 0) % 2 === 1 ? cut.slice(0, -1) : cut}…`;
};
/** Memory, chat and GitHub text in the Markdown body: escaped so it renders as plain data. */
const escapeMarkdown = (value: string) => value.replace(/[\\[\]()!*_`#<>|~]/g, "\\$&");
// A link shows as a bare URL only when nothing in it could close or open Markdown syntax.
const SAFE_URL = /^https?:\/\/[^\s<>()[\]\\`*|!]+$/;
const link = (url: string | undefined) =>
  url === undefined ? "" : ` ${SAFE_URL.test(url) ? url : escapeMarkdown(url)}`;
const entry = (row: RoutineRow) =>
  row.note === undefined
    ? escapeMarkdown(row.title)
    : `${escapeMarkdown(row.title)} (${escapeMarkdown(row.note)})`;
const inline = (label: string, rows: ReadonlyArray<RoutineRow>) =>
  rows.length === 0
    ? []
    : [
        `${label}: ${rows.slice(0, INLINE_ENTRIES).map(entry).join("; ")}${
          rows.length > INLINE_ENTRIES ? `; +${rows.length - INLINE_ENTRIES} more` : ""
        }`,
      ];
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const late = (ms: number) =>
  ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`;
const units = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${Math.round(value / 1_000)}k`
      : `${Math.round(value)}`;

function headerLines(routine: KinLeadRoutine, header: RoutineHeader) {
  const lateNote =
    header.lateByMs >= LATE_NOTE_MS && header.dueLabel !== null
      ? `, ${late(header.lateByMs)} late (due ${header.dueLabel})`
      : "";
  return [
    `${names[routine]}, ${header.dayLabel}${lateNote}`,
    ...(header.folded.length === 0
      ? []
      : [
          `Also covers the missed ${header.folded
            .map((fold) => `${names[fold.routine].toLowerCase()} of ${fold.dayLabel}`)
            .join(", ")}.`,
        ]),
  ];
}

function morningLines(facts: MorningFacts) {
  const lines = [
    ...facts.dueToday.map((row) => `Due today: ${entry(row)}${link(row.link)}`),
    ...inline("Due this week", facts.dueThisWeek),
    ...inline("Overdue", facts.overdue),
    ...(facts.waiting.length === 0
      ? []
      : [
          `Waiting on you: ${facts.waiting.length}, oldest ${entry(facts.waiting[0] as RoutineRow)}`,
        ]),
    ...inline("PRs for your review", facts.reviews),
    ...inline("CI red on the default branch", facts.ciRed),
    ...(facts.github === "off"
      ? ["GitHub: not connected, so PRs and CI were not checked."]
      : facts.github.length === 0
        ? []
        : [`GitHub, partial: ${facts.github.map((gap) => githubGaps[gap]).join("; ")}.`]),
    ...inline("Objectives at risk", facts.objectives),
    ...(facts.workersRunning === 0 && facts.workersBlocked.length === 0
      ? []
      : [
          `Workers: ${facts.workersRunning} running, ${facts.workersBlocked.length} blocked${
            facts.workersBlocked.length === 0
              ? ""
              : ` (${facts.workersBlocked
                  .slice(0, INLINE_ENTRIES)
                  .map((row) => escapeMarkdown(row.title))
                  .join("; ")})`
          }`,
        ]),
    ...(facts.postponed === 0 && facts.yesterdayUnits === null
      ? []
      : [
          `Budget: ${facts.postponed} postponed for budget${
            facts.yesterdayUnits === null ? "" : `; yesterday ${units(facts.yesterdayUnits)} units`
          }`,
        ]),
    ...inline("Past review date", facts.pastReview),
  ];
  return lines.length === 0 ? ["Nothing due, overdue or waiting on you."] : lines;
}

function eveningLines(facts: EveningFacts) {
  const usage = [
    facts.units === null ? undefined : `${units(facts.units)} units today`,
    facts.cacheHitRate === null ? undefined : `cache hits ${Math.round(facts.cacheHitRate * 100)}%`,
    facts.failedWakeups === 0 ? undefined : plural(facts.failedWakeups, "failed wake-up"),
    facts.failedDreams === 0 ? undefined : plural(facts.failedDreams, "failed dream"),
  ].filter((part) => part !== undefined);
  const lines = [
    ...inline("Done", facts.done),
    ...inline("Slipped or moved", facts.slipped),
    ...inline("Promised today", facts.promised),
    ...(facts.waiting.length === 0
      ? []
      : [
          `Open questions for you: ${facts.waiting.length}, oldest ${entry(facts.waiting[0] as RoutineRow)}`,
        ]),
    ...inline("Due tomorrow", facts.dueTomorrow),
    ...(usage.length === 0 ? [] : [`Usage: ${usage.join("; ")}`]),
  ];
  return lines.length === 0 ? ["Nothing done, slipped, promised or due tomorrow."] : lines;
}

/** Keeps the body within the cap; the card still lists every row. */
function fitLines(lines: ReadonlyArray<string>, max = ROUTINE_MAX_LINES) {
  const clipped = lines.map((line) => clip(line, LINE_MAX));
  if (clipped.length <= max) return clipped;
  return [...clipped.slice(0, max - 1), `+${clipped.length - max + 1} more lines in the card`];
}

const sections = (
  facts: MorningFacts | EveningFacts,
): ReadonlyArray<[KinRoutineSection, ReadonlyArray<RoutineRow>]> =>
  facts.routine === "morning_brief"
    ? [
        ["due_today", facts.dueToday],
        ["due_this_week", facts.dueThisWeek],
        ["overdue", facts.overdue],
        ["waiting", facts.waiting],
        ["review_requested", facts.reviews],
        ["ci_red", facts.ciRed],
        ["objective_at_risk", facts.objectives],
        ["worker", facts.workersBlocked],
        ["past_review", facts.pastReview],
      ]
    : [
        ["done", facts.done],
        ["slipped", facts.slipped],
        ["promised", facts.promised],
        ["waiting", facts.waiting],
        ["due_tomorrow", facts.dueTomorrow],
      ];

/** The routine message: at most `ROUTINE_MAX_LINES` lines of body plus one card. */
export function renderRoutine(header: RoutineHeader, facts: MorningFacts | EveningFacts) {
  const body = fitLines([
    ...headerLines(facts.routine, header),
    ...(facts.routine === "morning_brief" ? morningLines(facts) : eveningLines(facts)),
  ]).join("\n");
  const card: KinRoutineCard = {
    routine: facts.routine,
    day: header.day,
    rows: sections(facts)
      .flatMap(([section, rows]) =>
        rows.map((row) => ({
          section,
          title: clip(row.title, TEXT_MAX),
          ...(row.note === undefined ? {} : { note: clip(row.note, TEXT_MAX) }),
          ...(row.itemId === undefined ? {} : { itemId: row.itemId }),
          ...(row.link === undefined ? {} : { link: row.link.slice(0, 2_000) }),
          ...(row.widgetId === undefined ? {} : { widgetId: row.widgetId }),
        })),
      )
      .slice(0, CARD_ROWS),
  };
  return { body, card };
}

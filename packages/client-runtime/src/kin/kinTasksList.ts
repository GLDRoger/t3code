// @effect-diagnostics globalDate:off - Pure view helpers compare due times with the reader's local day, outside an Effect runtime.
import {
  KIN_WORK_MOVE_GROUPS,
  kinWorkMove,
  kinWorkMoveOrder,
  type KinChoiceOption,
  type KinOpenRead,
  type KinRecord,
  type KinWorkMoveCard,
  type KinWorkMoveCounts,
  type KinWorkMoveGroup,
  type KinWorkRowMove,
  type KinWorkSummary,
} from "@t3tools/contracts";

import { kinMayHaveGoneLine } from "./kinChoicePresentation.ts";
import { kinLateWords } from "./kinTaskRecord.ts";
import {
  kinWorkClosed,
  kinWorkDueDays,
  kinWorkDueText,
  kinWorkName,
  kinWorkPrincipalKey,
  type KinTaskGroupBy,
  type KinWorkNames,
  type KinWorkRef,
} from "./kinWork.ts";

/** What the phone's Tasks says, in the drawing's words. */
export const KIN_TASKS = {
  groups: {
    needsYou: "Needs you",
    waiting: "Waiting on others",
    rest: "Rest of the team",
  } satisfies Record<KinWorkMoveGroup, string>,
  yourProjects: "Your projects",
  done: "Done in the last 14 days",
  clearTitle: "Nothing needs you right now",
  clearDetail:
    "No drafts to approve, no questions waiting, nothing late. New ones will show here first.",
  teammateFoot: "You see tasks you hold, tasks you asked for, and tasks on your projects.",
  groupBy: "Group by",
  showOnly: "Show only",
  order: "Inside each group: late first, then soonest due, then tasks with no date.",
  approve: "Approve and send",
  review: "Review",
  other: "Other…",
  giveTo: "Give to…",
  nudge: (name: string) => `Nudge ${name}`,
  nudged: "Nudged today",
  sent: (to: string | null) => (to === null ? "Sent" : `Sent to ${to}`),
  answered: (label: string) => `Answered: ${label}`,
  replyHint: "Sends this as your reply",
  nudgeFailed: "Couldn't send the nudge.",
  working: "Working on it",
  dueToday: "Due today",
  noDate: "No date",
  notInProject: "Not in a project",
  notForClient: "Not for a client",
} as const;

export const KIN_TASK_GROUP_BY: ReadonlyArray<{
  readonly id: KinTaskGroupBy;
  readonly label: string;
}> = [
  { id: "me", label: "Me first" },
  { id: "project", label: "Project" },
  { id: "person", label: "Person" },
  { id: "due", label: "Due date" },
  { id: "status", label: "Status" },
];

/** The chip that says the list is grouped some other way, and clears it; null for Me first. */
export const kinTaskGroupedChip = (groupBy: KinTaskGroupBy | undefined): string | null => {
  if (groupBy === undefined || groupBy === "me") return null;
  const label = KIN_TASK_GROUP_BY.find((one) => one.id === groupBy)?.label ?? groupBy;
  return `Grouped by ${label.toLowerCase()}`;
};

/**
 * The Needs you number, read alike by its heading and the dock's Tasks badge: the host's open list
 * where it streams one, else the Tasks read's own count. Null until either has arrived.
 */
export const kinNeedsYouCount = (input: {
  readonly open: KinOpenRead | null;
  readonly counts: KinWorkMoveCounts | null;
}): number | null =>
  input.open !== null ? input.open.counts.needsYou : (input.counts?.needsYou ?? null);

/**
 * A row's line after who has it: one coloured word first when there is one (late in red, due
 * today in amber, an agent working in blue), then when it is due and its client or project.
 */
export interface KinTaskLine {
  readonly holder: string;
  readonly lead: { readonly text: string; readonly tone: "late" | "soon" | "working" } | null;
  readonly rest: string;
}

export function kinTaskLine(
  record: KinRecord,
  names: KinWorkNames,
  now: Date,
  /** The heading already names its project, or a step stands in for "No date". */
  options: { readonly inProject?: boolean; readonly quietNoDate?: boolean } = {},
): KinTaskLine {
  const closed = kinWorkClosed(record.state);
  const working = record.working || (record.owner._tag === "agent" && record.state === "doing");
  const day = closed ? null : kinWorkDueText(record, names, now);
  const today = !closed && !record.late && kinWorkDueDays(record, names, now) === 0;
  const lead =
    record.late && record.dueAt !== null
      ? { text: kinLateWords(record.dueAt, now), tone: "late" as const }
      : working && !closed
        ? { text: KIN_TASKS.working, tone: "working" as const }
        : today
          ? { text: KIN_TASKS.dueToday, tone: "soon" as const }
          : null;
  const due =
    lead?.tone === "late" || today
      ? null
      : day !== null
        ? `Due ${day}`
        : closed || options.quietNoDate === true || lead !== null
          ? null
          : KIN_TASKS.noDate;
  const about = options.inProject ? null : (record.party?.title ?? record.project?.title ?? null);
  return {
    holder: kinWorkName(record.owner, names),
    lead,
    rest: [due, about].filter((part) => part !== null).join(" · "),
  };
}

/** The one step a row carries for this reader, drawn under its line. */
export type KinTaskStep =
  | {
      readonly kind: "send";
      readonly line: string;
      readonly card: KinWorkMoveCard;
      /**
       * The card's Confirm; null on a card with none, or one whose earlier try may have gone,
       * which only Review opens.
       */
      readonly approve: KinChoiceOption | null;
      /** That an earlier try at this mail may already have gone (`kinMayHaveGoneLine`). */
      readonly mayHaveGone: string | null;
      /** Who it goes to, for "Sent to …" once confirmed. */
      readonly to: string | null;
    }
  | {
      readonly kind: "question";
      readonly line: string;
      readonly card: KinWorkMoveCard;
      readonly options: ReadonlyArray<KinChoiceOption>;
    }
  | {
      readonly kind: "nudge";
      /** The holder's last word, quoted with their name; null when they left none. */
      readonly line: string | null;
      readonly name: string;
      readonly nudged: boolean;
      readonly give: boolean;
    };

const QUESTION_BUTTONS = 3;

export function kinTaskStep(
  record: KinRecord,
  move: KinWorkRowMove | null,
  names: KinWorkNames,
  now: Date = new Date(),
): KinTaskStep | null {
  if (move === null || kinWorkClosed(record.state)) return null;
  const { card } = move;
  if (card !== undefined)
    return card.kind === "send"
      ? {
          kind: "send",
          line: card.preview,
          card,
          approve:
            card.mayHaveGone === undefined
              ? (card.options.find((option) => option.kind === "yes") ?? null)
              : null,
          mayHaveGone:
            card.mayHaveGone === undefined ? null : kinMayHaveGoneLine(card.mayHaveGone.at, now),
          to: record.party?.title ?? null,
        }
      : {
          kind: "question",
          line: card.preview,
          card,
          options: card.options.slice(0, QUESTION_BUTTONS),
        };
  const holder = record.owner;
  if (
    move.group === "needsYou" &&
    record.late &&
    holder._tag === "person" &&
    holder.personId !== names.me
  ) {
    const name = kinWorkName(holder, names).split(/\s+/)[0] ?? "";
    return {
      kind: "nudge",
      line: move.said === undefined ? null : `${name}: “${move.said}”`,
      name,
      nudged: move.nudgedAt !== undefined,
      give: record.can?.give ?? false,
    };
  }
  return null;
}

/** One line of Tasks: a heading, the all-clear, a task, the Done row or the teammate's note. */
export type KinTasksItem<R extends KinRecord> =
  | {
      readonly type: "heading";
      readonly key: string;
      readonly title: string;
      /** The host's count of every match; null where the host gave none. */
      readonly count: number | null;
      /** Its client, beside a project heading. */
      readonly aside: string | null;
      /** A project heading opens the project. */
      readonly project: { readonly key: string; readonly title: string } | null;
    }
  | { readonly type: "clear"; readonly key: string }
  | {
      readonly type: "task";
      readonly key: string;
      readonly record: R;
      readonly move: KinWorkRowMove | null;
      /** Under its own project's heading, the row needn't name it. */
      readonly inProject: boolean;
      /** Where it sits in its group's card, for the card's rounded ends. */
      readonly first: boolean;
      readonly last: boolean;
    }
  | { readonly type: "done"; readonly key: string; readonly count: number }
  | { readonly type: "foot"; readonly key: string; readonly text: string };

const lateOf = (record: KinRecord) => ({
  late: record.late,
  dueMs: record.dueAt === null ? null : Date.parse(record.dueAt),
  createdMs: Date.parse(record.createdAt),
  key: record.key,
});
const byOrder = (a: KinRecord, b: KinRecord) => kinWorkMoveOrder(lateOf(a), lateOf(b));

/** The most urgent open tasks first, in the order Tasks lists them inside a group. */
export const kinTasksMostUrgent = <R extends KinRecord>(
  records: ReadonlyArray<R>,
  limit: number,
): ReadonlyArray<R> =>
  records
    .filter((record) => !kinWorkClosed(record.state))
    .sort(byOrder)
    .slice(0, limit);

/** A person's page: how many open tasks they hold that the reader sees, and the top few. */
export const KIN_PERSON_TASKS = {
  title: "Tasks",
  shown: 5,
  count: (count: number) => (count === 1 ? "1 open task" : `${count} open tasks`),
  none: "No open tasks you can see.",
  seeAll: "See all in Tasks",
  failed: "Couldn't load their tasks.",
} as const;

/**
 * The projects the Filter narrows to: the reader's own choices, then any other project a task in
 * view is in, so a teammate can narrow to a project they see tasks of without being on it.
 */
export function kinTaskFilterProjects(
  choices: ReadonlyArray<KinWorkRef>,
  records: ReadonlyArray<KinRecord>,
): ReadonlyArray<KinWorkRef> {
  const held = new Set(choices.map((choice) => choice.key));
  const more = new Map<string, KinWorkRef>();
  for (const { project } of records)
    if (project !== undefined && !held.has(project.key) && !more.has(project.key))
      more.set(project.key, { key: project.key, title: project.title });
  return more.size === 0
    ? choices
    : [...choices, ...[...more.values()].sort((a, b) => a.title.localeCompare(b.title))];
}

/** Whose move a row is, from the row alone, on a host that doesn't answer `byMove`. */
const moveOfRow = (record: KinRecord, names: KinWorkNames, ownerLevel: boolean) =>
  names.me === null
    ? null
    : kinWorkMove(
        {
          state: record.state,
          owner: record.owner,
          waitingOn: record.waitingOn,
          late: record.late,
          confirmed: record.confirmed,
          askedBy: null,
          givenBy: record.givenBy ?? null,
          card: false,
        },
        { personId: names.me, ownerLevel },
      );

function pushTasks<R extends KinRecord>(
  items: Array<KinTasksItem<R>>,
  rows: ReadonlyArray<{ readonly record: R; readonly move: KinWorkRowMove | null }>,
  inProject: boolean,
) {
  rows.forEach(({ record, move }, index) =>
    items.push({
      type: "task",
      key: record.key,
      record,
      move,
      inProject,
      first: index === 0,
      last: index === rows.length - 1,
    }),
  );
}

/**
 * Tasks grouped by whose move: Needs you, Waiting on others, then the rest of the team (a
 * teammate's projects), each in the host's order, headed by the host's counts; then the Done row,
 * and a teammate's note on what they see. Needs you always shows, with the all-clear when empty.
 */
export function kinTasksByMove<R extends KinRecord>(input: {
  readonly records: ReadonlyArray<R>;
  /** The host's `byMove` steps by key; empty from an older host, where the rows are placed here. */
  readonly moves: ReadonlyMap<string, KinWorkRowMove>;
  readonly counts: KinWorkMoveCounts | null;
  /** The Needs you number the badge shows too (`kinNeedsYouCount`). */
  readonly needsYou: number | null;
  readonly ownerLevel: boolean;
  readonly names: KinWorkNames;
}): ReadonlyArray<KinTasksItem<R>> {
  const { records, moves, counts, names, ownerLevel } = input;
  const fromHost = moves.size > 0 || counts !== null;
  const placed = new Map<KinWorkMoveGroup, Array<{ record: R; move: KinWorkRowMove | null }>>(
    KIN_WORK_MOVE_GROUPS.map((group) => [group, []]),
  );
  for (const record of records) {
    const move = moves.get(record.key) ?? null;
    const group = fromHost ? move?.group : moveOfRow(record, names, ownerLevel);
    if (group === undefined || group === null) continue;
    placed.get(group)!.push({ record, move });
  }
  if (!fromHost)
    for (const rows of placed.values()) rows.sort((a, b) => byOrder(a.record, b.record));
  const items: Array<KinTasksItem<R>> = [];
  for (const group of KIN_WORK_MOVE_GROUPS) {
    const rows = placed.get(group)!;
    const count = group === "needsYou" ? input.needsYou : (counts?.[group] ?? null);
    if (group !== "needsYou" && rows.length === 0 && (count ?? 0) === 0) continue;
    items.push({
      type: "heading",
      key: `group:${group}`,
      title: group === "rest" && !ownerLevel ? KIN_TASKS.yourProjects : KIN_TASKS.groups[group],
      count: fromHost || group === "needsYou" ? count : null,
      aside: null,
      project: null,
    });
    if (group === "needsYou" && rows.length === 0) {
      if ((counts?.needsYou ?? 0) === 0) items.push({ type: "clear", key: "clear" });
      continue;
    }
    pushTasks(items, rows, false);
  }
  if (counts !== null && counts.doneRecently > 0)
    items.push({ type: "done", key: "done", count: counts.doneRecently });
  if (!ownerLevel) items.push({ type: "foot", key: "foot", text: KIN_TASKS.teammateFoot });
  return items;
}

type Bucket = {
  readonly key: string;
  readonly title: string;
  readonly rank: number;
  readonly count: number | null;
  readonly aside: string | null;
  readonly project: { readonly key: string; readonly title: string } | null;
};

const DUE_BUCKETS = ["Late", "Due today", "This week", "Later", "No date"] as const;
const STATUS_BUCKETS = ["In progress", "Waiting", "Not started"] as const;

/**
 * Tasks grouped by one of their own fields, each group in the fixed order. Counts are the host's
 * summary where it has one for that group, and absent where it has none.
 */
export function kinTasksGroupedBy<R extends KinRecord>(input: {
  readonly records: ReadonlyArray<R>;
  readonly groupBy: Exclude<KinTaskGroupBy, "me">;
  readonly summary: KinWorkSummary | null;
  readonly names: KinWorkNames;
  readonly now: Date;
}): ReadonlyArray<KinTasksItem<R>> {
  const { groupBy, summary, names, now } = input;
  const bucketOf = (record: R): Bucket => {
    switch (groupBy) {
      case "project": {
        const project = record.project;
        if (project === undefined)
          return {
            key: "",
            title: KIN_TASKS.notInProject,
            rank: 1,
            count: null,
            aside: null,
            project: null,
          };
        return {
          key: project.key,
          title: project.title,
          rank: 0,
          count: summary?.projects?.find((one) => one.project.key === project.key)?.open ?? null,
          aside: record.party?.title ?? KIN_TASKS.notForClient,
          project: { key: project.key, title: project.title },
        };
      }
      case "person": {
        const key = kinWorkPrincipalKey(record.owner);
        const mine = record.owner._tag === "person" && record.owner.personId === names.me;
        return {
          key,
          title: kinWorkName(record.owner, names),
          rank: mine ? 0 : 1,
          count:
            summary?.owners.find((one) => kinWorkPrincipalKey(one.owner) === key)?.open ?? null,
          aside: null,
          project: null,
        };
      }
      case "due": {
        const days = kinWorkDueDays(record, names, now);
        const index = days === null ? 4 : record.late ? 0 : days < 1 ? 1 : days < 7 ? 2 : 3;
        return {
          key: DUE_BUCKETS[index]!,
          title: DUE_BUCKETS[index]!,
          rank: index,
          count: index === 0 ? (summary?.late ?? null) : null,
          aside: null,
          project: null,
        };
      }
      case "status": {
        const index = record.state === "doing" ? 0 : record.state === "waiting" ? 1 : 2;
        const counted =
          summary === null
            ? null
            : index === 0
              ? summary.doing
              : index === 1
                ? summary.waiting
                : Math.max(0, summary.open - summary.doing - summary.waiting);
        return {
          key: STATUS_BUCKETS[index],
          title: STATUS_BUCKETS[index],
          rank: index,
          count: counted,
          aside: null,
          project: null,
        };
      }
    }
  };
  const buckets = new Map<string, { bucket: Bucket; rows: Array<R> }>();
  for (const record of input.records) {
    if (kinWorkClosed(record.state)) continue;
    const bucket = bucketOf(record);
    const held = buckets.get(bucket.key);
    if (held === undefined) buckets.set(bucket.key, { bucket, rows: [record] });
    else held.rows.push(record);
  }
  const ordered = [...buckets.values()].sort(
    (a, b) => a.bucket.rank - b.bucket.rank || a.bucket.title.localeCompare(b.bucket.title),
  );
  const items: Array<KinTasksItem<R>> = [];
  for (const { bucket, rows } of ordered) {
    items.push({
      type: "heading",
      key: `${groupBy}:${bucket.key}`,
      title: bucket.title,
      count: bucket.count,
      aside: bucket.aside,
      project: bucket.project,
    });
    pushTasks(
      items,
      [...rows].sort(byOrder).map((record) => ({ record, move: null })),
      groupBy === "project" && bucket.project !== null,
    );
  }
  return items;
}

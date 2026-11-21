// @effect-diagnostics globalDate:off - Pure view helpers compare due times with the reader's local day, outside an Effect runtime.
import {
  KIN_WORK_MOVE_PLACES,
  kinWorkHandedBackOpen,
  kinWorkMove,
  kinWorkMoveOrder,
  type KinChoiceOption,
  type KinPulseFact,
  type KinPulseScreenRead,
  type KinRecord,
  type KinWorkMoveCard,
  type KinWorkMoveCounts,
  type KinWorkMoveGroup,
  type KinWorkMovePlace,
  type KinWorkRowMove,
  type KinWorkSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { KIN_DEAL_SENSES, kinAttention, type KinAttentionRow } from "./kinAttention.ts";
import { kinMayHaveGoneLine } from "./kinChoicePresentation.ts";
import { kinLateWords } from "./kinTaskRecord.ts";
import type { KinWorkAction, KinWorkChangesState, KinWorkNotice } from "./kinWorkChanges.ts";
import {
  KIN_WORK_STEPS,
  kinWorkClosed,
  kinWorkDueDays,
  kinWorkDueText,
  kinMidSentence,
  kinWorkName,
  kinWorkPrincipalKey,
  kinWorkStatusText,
  kinWorkWaitsOnMe,
  type KinTaskGroupBy,
  type KinWorkFilter,
  type KinWorkNames,
  type KinWorkOverview,
  type KinWorkRef,
  type KinWorkViewId,
} from "./kinWork.ts";

/** What the phone's Tasks says, in the drawing's words. */
export const KIN_TASKS = {
  groups: {
    needsYou: "Needs you",
    waiting: "Waiting on others",
    rest: "Rest of the team",
  } satisfies Record<KinWorkMoveGroup, string>,
  /** Your own tasks nothing asks of yet, outside Needs you's count. */
  noDateGroup: "No date",
  comingUp: "Coming up",
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
  handedBack: (name: string, note: string | null) =>
    note === null ? `${name} handed this back` : `${name} handed this back: “${note}”`,
  asked: (name: string) => `${name} asked where this stands`,
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

/** Tasks' Filter at a glance; client, project, who has it and grouping are under More filters. */
export const KIN_TASK_FILTER = {
  all: "All open",
  mine: "Mine",
  week: "This week",
  waiting: "Waiting",
  late: "Late",
  more: "More filters",
} as const;

/** The views More filters still offers, besides those at a glance. */
export const KIN_TASK_MORE_VIEWS: ReadonlyArray<KinWorkViewId> = ["doing", "closed"];

export interface KinTaskQuickFilter {
  readonly id: "all" | "mine" | "week" | "waiting" | "late";
  readonly label: string;
  readonly count: number | null;
  readonly selected: boolean;
  /** What a tap reads; a tap on a chosen one takes it off again. */
  readonly next: KinWorkFilter;
}

/**
 * The Filter's first five: everything open, your own (kept with a view), and Due this week,
 * Waiting and Late. Mine is left out until the reader is known.
 */
export function kinTaskQuickFilters(
  filter: KinWorkFilter,
  overview: KinWorkOverview,
  me: KinWorkNames["me"],
): ReadonlyArray<KinTaskQuickFilter> {
  const chip = (view: KinWorkViewId) => overview.chips.find((one) => one.id === view);
  const isMine = filter.owner?._tag === "person" && filter.owner.personId === me;
  const view = (id: "week" | "waiting" | "late"): KinTaskQuickFilter => ({
    id,
    label: KIN_TASK_FILTER[id],
    count: chip(id)?.count ?? null,
    selected: filter.view === id,
    next: { ...filter, view: filter.view === id ? "open" : id },
  });
  const known = chip("open")?.count ?? null;
  return [
    {
      id: "all",
      label: KIN_TASK_FILTER.all,
      count: filter.owner === null ? known : null,
      selected: filter.view === "open" && filter.owner === null,
      next: { ...filter, view: "open", owner: null },
    },
    ...(me === null
      ? []
      : [
          {
            id: "mine" as const,
            label: KIN_TASK_FILTER.mine,
            count:
              known === null
                ? null
                : (overview.owners.find(
                    (one) => one.owner._tag === "person" && one.owner.personId === me,
                  )?.open ?? 0),
            selected: isMine,
            next: {
              ...filter,
              owner: isMine ? null : { _tag: "person" as const, personId: me },
            },
          },
        ]),
    view("week"),
    view("waiting"),
    view("late"),
  ];
}

/** The chip that says the list is grouped some other way, and clears it; null for Me first. */
export const kinTaskGroupedChip = (groupBy: KinTaskGroupBy | undefined): string | null => {
  if (groupBy === undefined || groupBy === "me") return null;
  const label = KIN_TASK_GROUP_BY.find((one) => one.id === groupBy)?.label ?? groupBy;
  return `Grouped by ${label.toLowerCase()}`;
};

/**
 * The Needs you number, read alike by its heading and the dock's Tasks badge: the Tasks read's own
 * count with the deal facts beside it (`kinTasksDealFactsOf`). Null until the count has arrived.
 */
export const kinNeedsYouCount = (input: {
  readonly counts: Pick<KinWorkMoveCounts, "needsYou"> | null;
  readonly dealFacts?: number;
}): number | null =>
  input.counts === null ? null : input.counts.needsYou + (input.dealFacts ?? 0);

/**
 * A row's line after who has it: one coloured word first when there is one (late in red, due
 * today in amber, an agent working in blue), then when it is due and its client or project.
 */
export interface KinTaskLine {
  /** Null on the reader's own Tasks for a task they hold: the list is theirs. */
  readonly holder: string | null;
  readonly lead: { readonly text: string; readonly tone: "late" | "soon" | "working" } | null;
  readonly rest: string;
  /** Someone marked it urgent and it is still open: the row's flag. */
  readonly urgent: boolean;
}

export function kinTaskLine(
  record: KinRecord,
  names: KinWorkNames,
  now: Date,
  /** The heading already names its project, or a step stands in for "No date". */
  options: {
    readonly inProject?: boolean;
    readonly quietNoDate?: boolean;
    /** The reader's own Tasks, where their own name needn't be said. */
    readonly ownList?: boolean;
    /** The client or project every row shares (`kinTasksSharedAbout`), said by none of them. */
    readonly sharedAbout?: string | null;
  } = {},
): KinTaskLine {
  const closed = kinWorkClosed(record.state);
  const working = record.working || (record.owner._tag === "agent" && record.state === "doing");
  const day = closed ? null : kinWorkDueText(record, names, now);
  const today = !closed && !record.late && kinWorkDueDays(record, names, now) === 0;
  const lead =
    record.late && record.dueAt !== null
      ? { text: kinLateWords(record, names, now), tone: "late" as const }
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
  const named = record.party?.title ?? record.project?.title ?? null;
  const about = options.inProject || named === (options.sharedAbout ?? null) ? null : named;
  // The clock (`kinWorkRow`'s state) always has these words beside it; one waiting on the
  // reader is drawn as a to-do and says nothing of waiting.
  const waiting =
    record.state !== "waiting" || kinWorkWaitsOnMe(record, names)
      ? null
      : record.waitingOn === null
        ? kinWorkStatusText(record, names)
        : `Waiting on ${kinMidSentence(kinWorkName(record.waitingOn, names, "you"))}`;
  const mine = record.owner._tag === "person" && record.owner.personId === names.me;
  return {
    holder: options.ownList === true && mine ? null : kinWorkName(record.owner, names),
    lead,
    rest: [
      waiting,
      due,
      record.steps === undefined ? null : KIN_WORK_STEPS.count(record.steps),
      about,
    ]
      .filter((part) => part !== null)
      .join(" · "),
    urgent: record.urgent === true && !closed,
  };
}

/** The client (else project) every one of several tasks names, which their rows needn't repeat. */
export function kinTasksSharedAbout(records: ReadonlyArray<KinRecord>): string | null {
  const named = new Set(
    records.map((record) => record.party?.title ?? record.project?.title ?? null),
  );
  const [only] = named;
  return records.length > 1 && named.size === 1 ? (only ?? null) : null;
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
    }
  /** What someone did to a task the reader holds: handed it back, or asked where it stands. */
  | { readonly kind: "told"; readonly line: string };

const QUESTION_BUTTONS = 3;

/**
 * What a row's step did stands for the card it answered (`widgetId`): once the list reads a newer
 * card for the row, such as the same mail back after a failed send, the row offers that one.
 */
export function kinTaskStepStatusShown<S extends object>(
  status: S | undefined,
  step: KinTaskStep | null,
): S | null {
  if (status === undefined) return null;
  const answered = "widgetId" in status ? status.widgetId : undefined;
  const card = step === null || !("card" in step) ? undefined : step.card.widgetId;
  return answered === undefined || card === undefined || card === answered ? status : null;
}

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
  if (holder._tag === "person" && holder.personId === names.me) {
    const first = (by: KinRecord["owner"]) => kinWorkName(by, names).split(/\s+/)[0] ?? "";
    // Shown while it keeps the task in Needs you (`kinWorkMoveUnder`), so the two agree.
    if (
      record.handedBack !== undefined &&
      kinWorkHandedBackOpen(Date.parse(record.handedBack.at), Date.parse(record.updatedAt))
    )
      return {
        kind: "told",
        line: KIN_TASKS.handedBack(first(record.handedBack.by), move.handedBackNote ?? null),
      };
    if (move.askedBy !== undefined)
      return {
        kind: "told",
        line: KIN_TASKS.asked(first({ _tag: "person", personId: move.askedBy })),
      };
    return null;
  }
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
  /** A deal or prospect that stopped moving, with the client page's answers to it. */
  | {
      readonly type: "fact";
      readonly key: string;
      readonly row: KinAttentionRow;
      readonly first: boolean;
      readonly last: boolean;
    }
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
      /** Ticked done just now and held in place, struck through (`kinTasksWithTicked`). */
      readonly ticked?: true;
    }
  | { readonly type: "done"; readonly key: string; readonly count: number }
  | { readonly type: "foot"; readonly key: string; readonly text: string };

/** With the company's zone, urgent leads its whole due day; without, those due at one time. */
const lateOf = (record: KinRecord, zone?: string | null) => {
  const dueMs = record.dueAt === null ? null : Date.parse(record.dueAt);
  return {
    late: record.late,
    dueMs,
    createdMs: Date.parse(record.createdAt),
    key: record.key,
    urgent: record.urgent === true,
    ...(zone == null
      ? {}
      : {
          day:
            dueMs === null || Number.isNaN(dueMs)
              ? null
              : DateTime.formatIsoDate(DateTime.makeZonedUnsafe(dueMs, { timeZone: zone })),
        }),
  };
};
const byOrder = (a: KinRecord, b: KinRecord, zone?: string | null) =>
  kinWorkMoveOrder(lateOf(a, zone), lateOf(b, zone));

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
  /** Rows already lead this group's card. */
  after = false,
) {
  rows.forEach(({ record, move }, index) =>
    items.push({
      type: "task",
      key: record.key,
      record,
      move,
      inProject,
      first: index === 0 && !after,
      last: index === rows.length - 1,
    }),
  );
}

/**
 * The open deal and prospect facts that are the reader's to answer: their own, and for the owner
 * and a co-owner also those that fall to the owner. From the pulse's read, as Clients reads them.
 * A fact that clears leaves it, so its row goes with it.
 */
export function kinTasksDealFactsOf(
  pulse: KinPulseScreenRead | null | undefined,
  input: { readonly ownerLevel: boolean; readonly me: string | null },
): ReadonlyArray<KinPulseFact> {
  const all = (pulse?.facts ?? []).filter((fact) => fact.handled === null);
  return all.filter(
    (fact) =>
      KIN_DEAL_SENSES.has(fact.sense) &&
      ((fact.actor._tag === "person" && fact.actor.personId === input.me) ||
        (fact.actor._tag === "owner" && input.ownerLevel)),
  );
}

/** `kinTasksDealFactsOf` as rows, with the client page's answers. */
export function kinTasksDealFacts(input: {
  readonly ownerLevel: boolean;
  readonly names: KinWorkNames;
  readonly now: Date;
  readonly pulse?: KinPulseScreenRead | null | undefined;
}): ReadonlyArray<KinAttentionRow> {
  const { names, ownerLevel } = input;
  const facts = kinTasksDealFactsOf(input.pulse, { ownerLevel, me: names.me });
  const asOf = input.pulse?.asOf;
  if (facts.length === 0 || asOf === undefined) return [];
  return kinAttention(
    { asOf, total: facts.length, facts },
    {
      scope: { type: "all" },
      names: new Map([...names.agents, ...names.people]),
      now: input.now,
    },
  ).open;
}

/**
 * Tasks grouped by whose move: Needs you, then your own with no date, Waiting on others, your own
 * due past the coming week, then the rest of the team (a teammate's projects), each in the host's
 * order, headed by the host's counts; then the Done row, and a teammate's note on what they see.
 * Needs you always shows, with the all-clear when empty.
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
  /** Deal and prospect facts (`kinTasksDealFacts`), first under Needs you. */
  readonly facts?: ReadonlyArray<KinAttentionRow>;
  /** Tasks were read for this filter; until then no group is drawn, so none says all clear. */
  readonly read: boolean;
}): ReadonlyArray<KinTasksItem<R>> {
  const { records, moves, counts, names, ownerLevel } = input;
  if (!input.read) return [];
  const facts = input.facts ?? [];
  const fromHost = moves.size > 0 || counts !== null;
  const placed = new Map<KinWorkMovePlace, Array<{ record: R; move: KinWorkRowMove | null }>>(
    KIN_WORK_MOVE_PLACES.map((place) => [place, []]),
  );
  for (const record of records) {
    const move = moves.get(record.key) ?? null;
    const place = fromHost ? (move?.under ?? move?.group) : moveOfRow(record, names, ownerLevel);
    if (place === undefined || place === null) continue;
    placed.get(place)!.push({ record, move });
  }
  if (!fromHost)
    for (const rows of placed.values())
      rows.sort((a, b) => byOrder(a.record, b.record, names.zone));
  const title = (place: KinWorkMovePlace) =>
    place === "noDate"
      ? KIN_TASKS.noDateGroup
      : place === "comingUp"
        ? KIN_TASKS.comingUp
        : place === "rest" && !ownerLevel
          ? KIN_TASKS.yourProjects
          : KIN_TASKS.groups[place];
  const items: Array<KinTasksItem<R>> = [];
  for (const place of KIN_WORK_MOVE_PLACES) {
    const rows = placed.get(place)!;
    const count = place === "needsYou" ? input.needsYou : (counts?.[place] ?? null);
    if (place !== "needsYou" && rows.length === 0 && (count ?? 0) === 0) continue;
    items.push({
      type: "heading",
      key: `group:${place}`,
      title: title(place),
      count: fromHost || place === "needsYou" ? count : null,
      aside: null,
      project: null,
    });
    if (place === "needsYou") {
      facts.forEach((row, index) =>
        items.push({
          type: "fact",
          key: row.factKey,
          row,
          first: index === 0,
          last: index === facts.length - 1 && rows.length === 0,
        }),
      );
      if (rows.length === 0) {
        if (facts.length === 0 && (counts?.needsYou ?? 0) === 0)
          items.push({ type: "clear", key: "clear" });
        continue;
      }
      pushTasks(items, rows, false, facts.length > 0);
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
      [...rows].sort((a, b) => byOrder(a, b, names.zone)).map((record) => ({ record, move: null })),
      groupBy === "project" && bucket.project !== null,
    );
  }
  return items;
}

type KinTaskItem<R extends KinRecord> = Extract<KinTasksItem<R>, { readonly type: "task" }>;

/** A row ticked done, held where it stood (`kinTasksWithTicked`). */
export interface KinTaskTicked<R extends KinRecord> {
  readonly item: KinTaskItem<R>;
  /** The line it sat under when ticked; null at the top. */
  readonly after: string | null;
}

/** `key`'s row as it stands in `items`, to hold there once it is ticked; null when not shown. */
function kinTaskTicked<R extends KinRecord>(
  items: ReadonlyArray<KinTasksItem<R>>,
  key: string,
): KinTaskTicked<R> | null {
  const at = items.findIndex((item) => item.type === "task" && item.key === key);
  const item = items[at];
  if (item === undefined || item.type !== "task") return null;
  return { item, after: at === 0 ? null : (items[at - 1]?.key ?? null) };
}

const inCard = (item: KinTasksItem<KinRecord> | undefined) =>
  item !== undefined && (item.type === "task" || item.type === "fact");

/**
 * Rows ticked done stay in their place, struck through, while their Undo can still be reached,
 * so a second quick tap lands where the first did. Each goes back under the line it sat under;
 * one whose line has gone leaves. `latest` draws a held row as it is now.
 */
export function kinTasksWithTicked<R extends KinRecord>(
  items: ReadonlyArray<KinTasksItem<R>>,
  ticked: ReadonlyArray<KinTaskTicked<R>>,
  latest: (record: R) => R,
): ReadonlyArray<KinTasksItem<R>> {
  if (ticked.length === 0) return items;
  const keys = new Set(ticked.map((held) => held.item.key));
  const out = [...items];
  for (const held of ticked) {
    if (out.some((item) => item.key === held.item.key)) continue;
    const at = held.after === null ? 0 : out.findIndex((item) => item.key === held.after) + 1;
    if (at > 0 || held.after === null)
      out.splice(at, 0, { ...held.item, record: latest(held.item.record) });
  }
  return out.map((item, index) =>
    item.type === "task" || item.type === "fact"
      ? {
          ...item,
          first: !inCard(out[index - 1]),
          last: !inCard(out[index + 1]),
          ...(item.type === "task" && keys.has(item.key) && kinWorkClosed(item.record.state)
            ? { ticked: true as const }
            : {}),
        }
      : item,
  );
}

/** The ticked rows still held: while a change to one saves, or the list's notice (its Undo) is up. */
export const kinTasksTickedShown = <R extends KinRecord>(
  ticked: ReadonlyArray<KinTaskTicked<R>>,
  changes: Pick<KinWorkChangesState, "pending">,
  notice: KinWorkNotice | null,
): ReadonlyArray<KinTaskTicked<R>> =>
  notice !== null || ticked.some((held) => changes.pending[held.item.key] !== undefined)
    ? ticked
    : [];

/**
 * A row's tick: marking done holds the row where it stands (`held`, the rows still shown); a
 * tick back on the row whose Undo is up takes that Undo, so its waiting-on comes back too.
 */
export function kinTasksTick<R extends KinRecord>(input: {
  readonly held: ReadonlyArray<KinTaskTicked<R>>;
  readonly items: ReadonlyArray<KinTasksItem<R>>;
  readonly key: string;
  readonly action: KinWorkAction;
  readonly notice: KinWorkNotice | null;
}): { readonly ticked: ReadonlyArray<KinTaskTicked<R>>; readonly undo: boolean } {
  const { held, key, action, notice } = input;
  if (action.type !== "state") return { ticked: held, undo: false };
  if (action.state !== "done")
    return {
      ticked: held,
      undo: !kinWorkClosed(action.state) && notice?.key === key && notice.undo !== null,
    };
  const row = kinTaskTicked(input.items, key);
  return {
    ticked: row === null ? held : [...held.filter((one) => one.item.key !== key), row],
    undo: false,
  };
}

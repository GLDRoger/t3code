import type {
  KinCanvasActivity,
  KinCanvasChange,
  KinCanvasRead,
  KinCanvasWidget,
  KinDocListRow,
  KinRecord,
  KinRecordKey,
  KinRecordState,
} from "@t3tools/contracts";

import type { KinCanvasLayoutGroup, KinCanvasLayoutItem } from "./kinCanvasLayout.ts";
import type { KinCanvasLensTask } from "./kinCanvasLens.ts";
import {
  type KinWorkNames,
  kinMidSentence,
  kinWorkActorName,
  kinWorkClosed,
  kinWorkDayOfTime,
  kinWorkName,
  kinWorkRow,
} from "./kinWork.ts";

export const KIN_CANVAS = {
  title: "Canvas",
  empty: "Nothing to show yet",
  emptyDetail: "Tasks and docs you can see appear here, grouped by project.",
  noProject: "No project",
  showAll: "Show everything",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  backToCanvas: "Back to the canvas",
  lens: "Arrange",
  addWidget: "Add widget",
  removeWidget: "Remove widget",
  resetPlace: "Put back",
  open: "Open",
  ask: "Ask",
  askWho: "Ask an agent",
  select: "Select",
  selectDone: "Done",
  clearSelection: "Clear",
  markSeen: "Mark as seen",
  needsYou: "Needs you",
  nothingNew: "Nothing changed since you last looked.",
  firstLook: "Changes appear here from your next visit.",
  movedFailed: "Couldn't save where that card sits.",
  sourceGone: "Its source was removed",
  loadFailed: "Couldn't load the canvas",
  minimap: "Canvas overview",
  sinceTitle: "Since you last looked",
} as const;

export type KinCanvasCardKind = "task" | "doc";
export type KinCanvasTone = "late" | "done" | "doing" | "waiting" | "open" | "doc";

export interface KinCanvasCardView {
  readonly key: string;
  readonly kind: KinCanvasCardKind;
  readonly title: string;
  /** Under the title: who has it, when it's due, its state. */
  readonly line: string;
  readonly tone: KinCanvasTone;
  readonly status: string;
  /** "Tech lead changed it today": someone else changed it since you last looked. */
  readonly changed: string | null;
  /** "Tech lead is working on it": an agent's running turn has changed it. */
  readonly working: string | null;
  readonly needsYou: boolean;
  readonly accessibilityLabel: string;
}

export interface KinCanvasWidgetView {
  readonly key: string;
  readonly widget: KinCanvasWidget;
  /** What it counts: "Launch site". */
  readonly title: string;
  /** "6 of 13 done", "17 days left", "3 tasks open". */
  readonly headline: string;
  readonly detail: string;
  /** For a progress bar: 0..1, or null for widgets that aren't a share. */
  readonly fraction: number | null;
  readonly tone: "late" | "done" | "open" | "gone";
  readonly sourceKey: KinRecordKey;
  readonly accessibilityLabel: string;
}

export const KIN_CANVAS_WIDGET_KINDS = [
  { kind: "progress", label: "Progress", detail: "Tasks done of all of them" },
  { kind: "facts", label: "At a glance", detail: "Open, in progress, waiting and late" },
  { kind: "countdown", label: "Countdown", detail: "Time left to its due date" },
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const toneOf = (state: KinRecordState, late: boolean): KinCanvasTone =>
  late
    ? "late"
    : kinWorkClosed(state)
      ? "done"
      : state === "doing"
        ? "doing"
        : state === "waiting"
          ? "waiting"
          : "open";

/** "Tech lead changed it today", "Meera and 2 others added it yesterday". */
export function kinCanvasChangedText(
  change: KinCanvasChange,
  names: KinWorkNames,
  now: Date,
): string {
  const who = kinWorkActorName(change.by, names);
  const plus = change.others === 0 ? who : `${who} and ${plural(change.others, "other")}`;
  return `${plus} ${change.created ? "added" : "changed"} it ${kinWorkDayOfTime(change.at, now)}`;
}

/** One line for the return: "Tech lead and Meera changed 5 things since you last looked." */
export function kinCanvasSinceLine(
  read: Pick<KinCanvasRead, "since">,
  names: KinWorkNames,
): string {
  const { since } = read;
  if (since.seenAt === null) return KIN_CANVAS.firstLook;
  const total = since.changes.length + since.more;
  if (total === 0) return KIN_CANVAS.nothingNew;
  const actors: string[] = [];
  for (const change of since.changes) {
    const name = kinWorkActorName(change.by, names);
    if (!actors.includes(name)) actors.push(name);
  }
  const who =
    actors.length === 1
      ? actors[0]!
      : actors.length === 2
        ? `${actors[0]} and ${kinMidSentence(actors[1]!)}`
        : `${actors[0]}, ${kinMidSentence(actors[1]!)} and ${plural(actors.length - 2, "other")}`;
  return `${who} changed ${plural(total, "thing")} since you last looked.`;
}

const DOING: Partial<Record<KinCanvasActivity["state"], string>> = {
  starting: "starting",
  thinking: "thinking",
  writing: "writing",
  stalled: "stuck",
  paused: "paused",
  deferred: "waiting",
};

/** "Tech lead · working on W-14", "Finance · thinking", for the chips above the canvas. */
export function kinCanvasActivityText(activity: KinCanvasActivity): string {
  const doing = DOING[activity.state] ?? "working";
  if (activity.keys.length === 0) return `${activity.name} · ${doing}`;
  const on =
    activity.keys.length === 1
      ? activity.keys[0]
      : `${activity.keys[0]} and ${plural(activity.keys.length - 1, "other")}`;
  return `${activity.name} · ${doing} on ${on}`;
}

export function kinCanvasWidgetView(widget: KinCanvasWidget, nowDate: Date): KinCanvasWidgetView {
  const now = nowDate.getTime();
  const view = (
    headline: string,
    detail: string,
    fraction: number | null,
    tone: KinCanvasWidgetView["tone"],
  ): KinCanvasWidgetView => ({
    key: widget.id,
    widget,
    title: widget.source.title,
    sourceKey: widget.source.key,
    headline,
    detail,
    fraction,
    tone,
    accessibilityLabel: `${widget.source.title}: ${headline}. ${detail}`,
  });
  const value = widget.value;
  if (value._tag === "gone") return view(KIN_CANVAS.sourceGone, widget.source.key, null, "gone");
  if (value._tag === "progress") {
    const fraction = value.total === 0 ? 0 : value.done / value.total;
    return view(
      `${value.done} of ${value.total} done`,
      value.total === 0 ? "No tasks yet" : `${Math.round(fraction * 100)}% of its tasks`,
      fraction,
      value.total > 0 && value.done === value.total ? "done" : "open",
    );
  }
  if (value._tag === "facts") {
    const open = value.open + value.doing + value.waiting;
    const parts = [
      value.doing > 0 ? `${value.doing} in progress` : null,
      value.waiting > 0 ? `${value.waiting} waiting` : null,
      value.late > 0 ? `${value.late} late` : null,
    ].filter((part) => part !== null);
    return view(
      open === 0 ? "Nothing open" : `${plural(open, "task")} open`,
      parts.length === 0 ? "None late" : parts.join(" · "),
      null,
      value.late > 0 ? "late" : open === 0 ? "done" : "open",
    );
  }
  if (value.closed) return view("Done", "Closed", null, "done");
  if (value.at === null) return view("No due date", "Set one to count down", null, "open");
  const at = Date.parse(value.at);
  const day = kinWorkDayOfTime(value.at, nowDate);
  if (at < now) {
    const late = Math.max(1, Math.floor((now - at) / DAY_MS));
    return view(`${plural(late, "day")} late`, `Was due ${day}`, null, "late");
  }
  const days = Math.ceil((at - now) / DAY_MS);
  return view(days <= 1 ? "Due today" : `${plural(days, "day")} left`, `Due ${day}`, null, "open");
}

export interface KinCanvasProject {
  readonly key: string;
  readonly title: string;
}

export interface KinCanvasModel {
  readonly groups: ReadonlyArray<KinCanvasLayoutGroup>;
  readonly items: ReadonlyArray<KinCanvasLayoutItem>;
  readonly cards: ReadonlyMap<string, KinCanvasCardView>;
  readonly widgets: ReadonlyMap<string, KinCanvasWidgetView>;
  readonly lensTasks: ReadonlyArray<KinCanvasLensTask>;
  /** Keys someone else changed since you last looked, for the "new" marks. */
  readonly changed: ReadonlySet<string>;
  /** Keys an agent's running turn has changed, with the agent's name. */
  readonly working: ReadonlyMap<string, string>;
}

/** Done tasks stay on the canvas this long after closing, then leave it. */
export const KIN_CANVAS_DONE_DAYS = 14;

const byKey = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * Everything the canvas shows, from the records the viewer was sent: tasks and docs as cards in
 * their project's group, widgets first in theirs. Nothing here decides who may see what; the
 * reads that fed it already did.
 */
export function kinCanvasModel(input: {
  readonly tasks: ReadonlyArray<KinRecord>;
  readonly docs: ReadonlyArray<KinDocListRow>;
  readonly projects: ReadonlyArray<KinCanvasProject>;
  readonly canvas: KinCanvasRead | null;
  readonly needsYou: ReadonlySet<string>;
  readonly names: KinWorkNames;
  readonly now: Date;
}): KinCanvasModel {
  const nowMs = input.now.getTime();
  const changes = new Map((input.canvas?.since.changes ?? []).map((c) => [c.key as string, c]));
  const working = new Map<string, string>();
  for (const activity of input.canvas?.activity ?? [])
    for (const key of activity.keys) if (!working.has(key)) working.set(key, activity.name);

  const tasks = input.tasks.filter(
    (task) =>
      task.state !== "dropped" &&
      (task.closedAt === null || nowMs - Date.parse(task.closedAt) < KIN_CANVAS_DONE_DAYS * DAY_MS),
  );
  const docs = input.docs.filter((doc) => !doc.archived);
  const titles = new Map<string, string>(input.projects.map((p) => [p.key, p.title]));
  for (const row of [...tasks, ...docs]) if (row.project) titles.set(row.project.key, row.project.title);
  const projectOf = new Map<string, string | null>();
  for (const row of [...tasks, ...docs]) projectOf.set(row.key, row.project?.key ?? null);

  const changedText = (key: string) => {
    const change = changes.get(key);
    return change === undefined ? null : kinCanvasChangedText(change, input.names, input.now);
  };
  const workingText = (key: string) => {
    const name = working.get(key);
    return name === undefined ? null : `${name} is working on it`;
  };

  const cards = new Map<string, KinCanvasCardView>();
  const items: KinCanvasLayoutItem[] = [];
  const lensTasks: KinCanvasLensTask[] = [];
  const widgets = new Map<string, KinCanvasWidgetView>();
  for (const widget of input.canvas?.widgets ?? []) {
    widgets.set(widget.id, kinCanvasWidgetView(widget, input.now));
    const source = widget.source.key;
    const group =
      widget.kind === "countdown" && !titles.has(source) ? (projectOf.get(source) ?? null) : source;
    if (group === source && !titles.has(source)) titles.set(source, widget.source.title);
    items.push({ key: widget.id, group });
  }

  const ordered = [...tasks].sort((a, b) => {
    const closed = Number(kinWorkClosed(a.state)) - Number(kinWorkClosed(b.state));
    if (closed !== 0) return closed;
    const due = (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~");
    return due !== 0 ? due : byKey(a.key, b.key);
  });
  for (const task of ordered) {
    const row = kinWorkRow(task, input.names, input.now);
    const changed = changedText(task.key);
    const agent = workingText(task.key);
    cards.set(task.key, {
      key: task.key,
      kind: "task",
      title: task.title,
      line: row.line,
      tone: toneOf(task.state, task.late),
      status: row.status,
      changed,
      working: agent ?? (task.working ? "Working on it now" : null),
      needsYou: input.needsYou.has(task.key),
      accessibilityLabel: [row.accessibilityLabel, changed, agent].filter(Boolean).join(". "),
    });
    items.push({ key: task.key, group: task.project?.key ?? null });
    lensTasks.push({
      key: task.key,
      state: task.state,
      holder: row.holder,
      dueAt: task.dueAt,
      late: task.late,
    });
  }
  for (const doc of [...docs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const owner = kinWorkName(doc.owner, input.names);
    const changed = changedText(doc.key);
    const agent = workingText(doc.key);
    cards.set(doc.key, {
      key: doc.key,
      kind: "doc",
      title: doc.title,
      line: `Kept by ${kinMidSentence(owner)} · updated ${kinWorkDayOfTime(doc.updatedAt, input.now)}`,
      tone: "doc",
      status: "Doc",
      changed,
      working: agent,
      needsYou: input.needsYou.has(doc.key),
      accessibilityLabel: [`Doc ${doc.key}: ${doc.title}`, changed, agent]
        .filter(Boolean)
        .join(". "),
    });
    items.push({ key: doc.key, group: doc.project?.key ?? null });
  }

  const used = new Set(items.map((item) => item.group));
  const groups: KinCanvasLayoutGroup[] = [...titles]
    .filter(([key]) => used.has(key))
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([key, title]) => ({ key, title }));
  if (used.has(null)) groups.push({ key: null, title: KIN_CANVAS.noProject });

  return {
    groups,
    items,
    cards,
    widgets,
    lensTasks,
    changed: new Set([...changes.keys()].filter((key) => cards.has(key))),
    working,
  };
}

/** What an Ask about the chosen cards starts with in the agent's composer. */
export function kinCanvasAskDraft(
  cards: ReadonlyArray<Pick<KinCanvasCardView, "key" | "title">>,
): string {
  if (cards.length === 0) return "";
  if (cards.length === 1) return `About ${cards[0]!.key} (${cards[0]!.title}): `;
  return `About ${cards.map((card) => card.key).join(", ")}: `;
}

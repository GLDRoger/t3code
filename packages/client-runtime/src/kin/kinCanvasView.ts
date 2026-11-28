import type { KinDocListRow, KinProjectRow, KinRecord, KinRecordState } from "@t3tools/contracts";

import type { KinCanvasLayoutGroup, KinCanvasLayoutItem } from "./kinCanvasLayout.ts";
import {
  type KinWorkNames,
  kinMidSentence,
  kinWorkDayOfTime,
  kinWorkName,
  kinWorkRow,
} from "./kinWork.ts";

export const KIN_CANVAS = {
  title: "Map",
  list: "List",
  views: "Docs view",
  empty: "Nothing is being worked on",
  emptyDetail: "Tasks in progress and docs appear here, grouped by project.",
  emptyOpen: "No open tasks or docs yet",
  company: "Company",
  noProject: "Everything else",
  showAll: "Show everything",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  open: "Open",
  close: "Close",
  doing: "In progress",
  allOpen: "All open",
  agentWorking: "An agent is working on it now",
  board: "Map of tasks and docs",
  boardHint: "Drag to move around, pinch or double-tap to zoom",
  loading: "Loading the map",
  loadFailed: "Couldn't load the map",
  loadFailedDetail: "Tasks and docs didn't come through. Retry to read them again.",
  readFailed: "Couldn't load this doc",
  tasksFailed: "Some tasks didn't load",
  docsFailed: "Some docs didn't load",
  offlineTitle: "You're offline",
  offlineDetail: "The map comes back when the connection does.",
  refusedTitle: "The map isn't open to you here",
  refusedDetail: "It shows tasks and docs, and you don't have access to them here.",
  /** "Showing 300 of 2,140 open tasks": said wherever the board stops short. */
  partial: (shown: number, total: number | null, what: string) =>
    total === null
      ? `Showing the first ${shown.toLocaleString("en")} ${what}`
      : `Showing ${shown.toLocaleString("en")} of ${total.toLocaleString("en")} ${what}`,
} as const;

export type KinCanvasStatus = "refused" | "loading" | "offline" | "failed" | "ready";

/**
 * Whether the map shows or a whole-screen message does. Only a map with nothing to show waits or
 * fails whole; one with cards keeps them while the rest loads (as after the In progress / All open
 * switch) and its notice says what is missing.
 */
export function kinCanvasStatus(input: {
  readonly refused: boolean;
  readonly showing: boolean;
  readonly sources: ReadonlyArray<"rows" | "loading" | "offline" | "failed">;
}): KinCanvasStatus {
  if (input.refused) return "refused";
  if (input.showing) return "ready";
  for (const status of ["loading", "offline", "failed"] as const)
    if (input.sources.includes(status)) return status;
  return "ready";
}

/** Most tasks and docs the map reads; past these it says where it stops. */
export const KIN_CANVAS_MAX_TASKS = 300;
export const KIN_CANVAS_MAX_DOCS = 400;

export type KinCanvasCardKind = "task" | "doc";
export type KinCanvasTone = "late" | "doing" | "waiting" | "open" | "done" | "doc";

export interface KinCanvasCardView {
  readonly key: string;
  readonly kind: KinCanvasCardKind;
  readonly title: string;
  /** Under the title: who has it and when it's due, or who keeps a doc and when it changed. */
  readonly line: string;
  readonly tone: KinCanvasTone;
  /** "In progress", "Late", "Doc". */
  readonly status: string;
  /** An agent is working on it now (`KinRecord.working`). */
  readonly working: boolean;
  /** The person or agent who has it, for the avatar; null on a doc. */
  readonly holder: string | null;
  /** A doc's latest "what changed" line, for the middle zoom; null on a task. */
  readonly summary: string | null;
  readonly accessibilityLabel: string;
}

/** One area of the map: a project, a client's other work, the company's docs, or the rest. */
export interface KinCanvasGroupView extends KinCanvasLayoutGroup {
  readonly kind: "project" | "client" | "company" | "other";
  /** "12 open · 2 late · due 4 Dec", or null where there is nothing to count. */
  readonly line: string | null;
  readonly late: boolean;
  /** How many of its cards an agent is working on now. */
  readonly working: number;
}

export interface KinCanvasModel {
  readonly groups: ReadonlyArray<KinCanvasGroupView>;
  readonly items: ReadonlyArray<KinCanvasLayoutItem>;
  readonly cards: ReadonlyMap<string, KinCanvasCardView>;
  /** Keys of the tasks an agent is working on now, in board order. */
  readonly working: ReadonlyArray<string>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

const toneOf = (state: KinRecordState, late: boolean): KinCanvasTone =>
  late
    ? "late"
    : state === "doing"
      ? "doing"
      : state === "waiting"
        ? "waiting"
        : state === "open"
          ? "open"
          : "done";

type Area = { key: string; title: string; kind: KinCanvasGroupView["kind"] };
const COMPANY: Area = { key: "company", title: KIN_CANVAS.company, kind: "company" };
const OTHER: Area = { key: "other", title: KIN_CANVAS.noProject, kind: "other" };

/** Where a task or doc sits: its project, else its client, else the company's own docs, else the rest. */
function areaOf(row: KinRecord | KinDocListRow): Area {
  if (row.project !== undefined)
    return { key: `p:${row.project.key}`, title: row.project.title, kind: "project" };
  if (row.party !== undefined)
    return { key: `c:${row.party.key}`, title: row.party.title, kind: "client" };
  return "company" in row && row.company === true ? COMPANY : OTHER;
}

function projectLine(project: KinProjectRow, now: Date): string {
  const parts = [
    project.open === 0 ? "Nothing open" : `${project.open} open`,
    project.late > 0 ? `${project.late} late` : null,
    project.targetAt === null ? null : `due ${kinWorkDayOfTime(project.targetAt, now)}`,
  ];
  return parts.filter((part) => part !== null).join(" · ");
}

/**
 * Everything the map shows, from rows the viewer's own reads sent: an area per project (or client,
 * or the company's docs), its tasks first and then its docs. Nothing here decides who may see what.
 * Areas where an agent is working come first, then late projects, then by name, so the same input
 * always lays out the same way.
 */
export function kinCanvasModel(input: {
  readonly tasks: ReadonlyArray<KinRecord>;
  readonly docs: ReadonlyArray<KinDocListRow>;
  readonly projects: ReadonlyArray<KinProjectRow>;
  readonly names: KinWorkNames;
  readonly now: Date;
}): KinCanvasModel {
  const areas = new Map<string, Area>();
  const members = new Map<string, string[]>();
  const working = new Map<string, number>();
  const cards = new Map<string, KinCanvasCardView>();
  const add = (area: Area, key: string) => {
    if (!areas.has(area.key)) areas.set(area.key, area);
    const list = members.get(area.key);
    if (list === undefined) members.set(area.key, [key]);
    else list.push(key);
  };

  // Hermes on the phone has no toSorted.
  const tasks = [...input.tasks]
    .filter((task) => task.state !== "dropped" && task.state !== "done")
    .sort(
      (a, b) =>
        Number(b.working) - Number(a.working) ||
        Number(b.late) - Number(a.late) ||
        (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~") ||
        byName(a.key, b.key),
    );
  for (const task of tasks) {
    const row = kinWorkRow(task, input.names, input.now);
    const area = areaOf(task);
    cards.set(task.key, {
      key: task.key,
      kind: "task",
      title: task.title,
      line: row.line,
      tone: toneOf(task.state, task.late),
      status: row.status,
      working: task.working,
      holder: row.holder,
      summary: null,
      accessibilityLabel: task.working
        ? `${row.accessibilityLabel}. ${KIN_CANVAS.agentWorking}`
        : row.accessibilityLabel,
    });
    add(area, task.key);
    if (task.working) working.set(area.key, (working.get(area.key) ?? 0) + 1);
  }

  const docs = [...input.docs]
    .filter((doc) => !doc.archived && doc.character !== true)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const doc of docs) {
    const keeper = kinWorkName(doc.owner, input.names);
    const changed = kinWorkDayOfTime(doc.updatedAt, input.now);
    cards.set(doc.key, {
      key: doc.key,
      kind: "doc",
      title: doc.title,
      line: `${keeper} · updated ${changed}`,
      tone: "doc",
      status: "Doc",
      working: false,
      holder: null,
      // A first version's line only says it was made, which the card already shows.
      summary:
        doc.latest.kind === "created" || doc.latest.summary.trim() === ""
          ? null
          : doc.latest.summary,
      accessibilityLabel: `Doc ${doc.key}: ${doc.title}. Kept by ${kinMidSentence(keeper)}, updated ${changed}`,
    });
    add(areaOf(doc), doc.key);
  }

  const projects = new Map(input.projects.map((project) => [`p:${project.key}`, project]));
  const groups = [...areas.values()].map((area): KinCanvasGroupView => {
    const project = projects.get(area.key);
    return {
      key: area.key,
      title: project?.name ?? area.title,
      kind: area.kind,
      line: project === undefined ? null : projectLine(project, input.now),
      late: project !== undefined && project.late > 0,
      working: working.get(area.key) ?? 0,
    };
  });
  const rank = (group: KinCanvasGroupView) =>
    group.kind === "other" ? 3 : group.kind === "company" ? 2 : 0;
  groups.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(b.working > 0) - Number(a.working > 0) ||
      Number(b.late) - Number(a.late) ||
      byName(a.title, b.title),
  );

  const items = groups.flatMap((group) =>
    (members.get(group.key ?? "") ?? []).map((key) => ({ key, group: group.key })),
  );
  return {
    groups,
    items,
    cards,
    working: items.filter((item) => cards.get(item.key)?.working === true).map((item) => item.key),
  };
}

/** "3 in progress · 1 agent working", for the bar above the map. */
export function kinCanvasHeadline(model: KinCanvasModel): string {
  let tasks = 0;
  let docs = 0;
  for (const card of model.cards.values())
    if (card.kind === "task") tasks += 1;
    else docs += 1;
  const parts = [
    tasks > 0 ? plural(tasks, "task") : null,
    docs > 0 ? plural(docs, "doc") : null,
    model.working.length > 0 ? `${model.working.length} with an agent on it now` : null,
  ];
  return parts.filter((part) => part !== null).join(" · ");
}

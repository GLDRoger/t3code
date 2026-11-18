import type { KinRecordState } from "@t3tools/contracts";

import type { KinCanvasBox } from "./kinCanvasCamera.ts";
import {
  KIN_CANVAS_CARD_H,
  KIN_CANVAS_CARD_W,
  KIN_CANVAS_GAP,
  type KinCanvasCardBox,
  type KinCanvasGroupBox,
  type KinCanvasLayout,
  kinCanvasUnion,
} from "./kinCanvasLayout.ts";

/**
 * A lens lays the tasks out by one question for a while, then "Back to the canvas" puts every
 * card back. The stored layout never moves.
 */
export type KinCanvasLensId = "state" | "holder" | "due";

export const KIN_CANVAS_LENSES: ReadonlyArray<{
  readonly id: KinCanvasLensId;
  readonly label: string;
}> = [
  { id: "state", label: "By state" },
  { id: "holder", label: "By who has it" },
  { id: "due", label: "By due date" },
];

export interface KinCanvasLensTask {
  readonly key: string;
  readonly state: KinRecordState;
  /** Who has it, as the card names them. */
  readonly holder: string;
  readonly dueAt: string | null;
  readonly late: boolean;
}

const STATE_COLUMNS: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly states: ReadonlyArray<KinRecordState>;
}> = [
  { id: "open", title: "To do", states: ["open"] },
  { id: "doing", title: "In progress", states: ["doing"] },
  { id: "waiting", title: "Waiting", states: ["waiting"] },
  { id: "done", title: "Done", states: ["done"] },
];

const DAY_MS = 24 * 60 * 60 * 1000;

const dueColumn = (task: KinCanvasLensTask, now: number): string => {
  if (task.state === "done" || task.state === "dropped") return "closed";
  if (task.late) return "late";
  if (task.dueAt === null) return "none";
  const at = Date.parse(task.dueAt);
  if (Number.isNaN(at)) return "none";
  return at - now <= 7 * DAY_MS ? "week" : "later";
};

const DUE_COLUMNS = [
  { id: "late", title: "Late" },
  { id: "week", title: "Due this week" },
  { id: "later", title: "Later" },
  { id: "none", title: "No due date" },
  { id: "closed", title: "Done" },
];

export interface KinCanvasLensColumn {
  readonly id: string;
  readonly title: string;
  readonly keys: ReadonlyArray<string>;
}

/** The lens's columns, in reading order, with the tasks each holds. Empty columns are kept. */
export function kinCanvasLensColumns(
  lens: KinCanvasLensId,
  tasks: ReadonlyArray<KinCanvasLensTask>,
  now: number,
): ReadonlyArray<KinCanvasLensColumn> {
  const open = tasks.filter((task) => task.state !== "dropped");
  if (lens === "state")
    return STATE_COLUMNS.map((column) => ({
      id: column.id,
      title: column.title,
      keys: open.filter((task) => column.states.includes(task.state)).map((task) => task.key),
    }));
  if (lens === "due")
    return DUE_COLUMNS.map((column) => ({
      ...column,
      keys: open.filter((task) => dueColumn(task, now) === column.id).map((task) => task.key),
    }));
  const holders = [...new Set(open.filter((t) => t.state !== "done").map((t) => t.holder))].sort(
    (a, b) => (a === "You" ? -1 : b === "You" ? 1 : a.localeCompare(b)),
  );
  return holders.map((holder) => ({
    id: `holder:${holder}`,
    title: holder,
    keys: open.filter((t) => t.state !== "done" && t.holder === holder).map((t) => t.key),
  }));
}

const COLUMN_GAP = 64;
const HEAD = 52;
const PAD = 24;

/**
 * The lens as a layout: one column per answer, tasks stacked in it, widgets in a row above. Cards
 * the lens doesn't hold (docs) are left out, so the canvas shows only what answers the question.
 */
export function kinCanvasLensLayout(
  columns: ReadonlyArray<KinCanvasLensColumn>,
  widgets: ReadonlyArray<string>,
): KinCanvasLayout {
  const cards = new Map<string, KinCanvasCardBox>();
  const groups: KinCanvasGroupBox[] = [];
  const stepY = KIN_CANVAS_CARD_H + KIN_CANVAS_GAP;
  const top = widgets.length > 0 ? stepY + COLUMN_GAP / 2 : 0;
  widgets.forEach((key, i) => {
    cards.set(key, {
      key,
      group: null,
      x: PAD + i * (KIN_CANVAS_CARD_W + KIN_CANVAS_GAP),
      y: 0,
      w: KIN_CANVAS_CARD_W,
      h: KIN_CANVAS_CARD_H,
      placed: false,
    });
  });
  columns.forEach((column, i) => {
    const x = i * (KIN_CANVAS_CARD_W + PAD * 2 + COLUMN_GAP);
    column.keys.forEach((key, row) => {
      cards.set(key, {
        key,
        group: column.id,
        x: x + PAD,
        y: top + HEAD + row * stepY,
        w: KIN_CANVAS_CARD_W,
        h: KIN_CANVAS_CARD_H,
        placed: false,
      });
    });
    const rows = Math.max(1, column.keys.length);
    groups.push({
      key: column.id,
      title: column.title,
      x,
      y: top,
      w: KIN_CANVAS_CARD_W + PAD * 2,
      h: HEAD + rows * stepY - KIN_CANVAS_GAP + PAD,
      head: HEAD,
    });
  });
  const bounds: KinCanvasBox = kinCanvasUnion([...groups, ...cards.values()]) ?? {
    x: 0,
    y: 0,
    w: KIN_CANVAS_CARD_W,
    h: KIN_CANVAS_CARD_H,
  };
  return { cards, groups, bounds };
}

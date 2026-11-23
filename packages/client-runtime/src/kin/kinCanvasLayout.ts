import type { KinCanvasBox } from "./kinCanvasCamera.ts";

export const KIN_CANVAS_CARD_W = 240;
export const KIN_CANVAS_CARD_H = 132;
export const KIN_CANVAS_GAP = 24;
const GROUP_PAD = 24;
const GROUP_HEAD = 52;
const GROUP_GAP = 96;
const MAX_COLS = 4;

/** A card on the map, in the area it belongs to. */
export interface KinCanvasLayoutItem {
  readonly key: string;
  readonly group: string;
}

export interface KinCanvasLayoutGroup {
  readonly key: string;
  readonly title: string;
}

export interface KinCanvasCardBox extends KinCanvasBox {
  readonly key: string;
  readonly group: string;
}

export interface KinCanvasGroupBox extends KinCanvasBox {
  readonly key: string;
  readonly title: string;
  /** Height of the band above the cards that carries the group's name. */
  readonly head: number;
}

export interface KinCanvasLayout {
  readonly cards: ReadonlyMap<string, KinCanvasCardBox>;
  readonly groups: ReadonlyArray<KinCanvasGroupBox>;
  readonly bounds: KinCanvasBox;
}

export const kinCanvasOverlaps = (a: KinCanvasBox, b: KinCanvasBox, pad = 0) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

export function kinCanvasUnion(boxes: Iterable<KinCanvasBox>): KinCanvasBox | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const colsFor = (count: number) => Math.max(1, Math.min(MAX_COLS, Math.ceil(Math.sqrt(count))));
const STEP_X = KIN_CANVAS_CARD_W + KIN_CANVAS_GAP;
const STEP_Y = KIN_CANVAS_CARD_H + KIN_CANVAS_GAP;

const cardAt = (item: KinCanvasLayoutItem, x: number, y: number): KinCanvasCardBox => ({
  key: item.key,
  group: item.group,
  x,
  y,
  w: KIN_CANVAS_CARD_W,
  h: KIN_CANVAS_CARD_H,
});

/**
 * Where every card sits, the same way for the same input: each area a grid of its cards, in the
 * order given, areas packed in rows about as wide as the screen's shape asks.
 */
export function kinCanvasLayout(input: {
  readonly groups: ReadonlyArray<KinCanvasLayoutGroup>;
  readonly items: ReadonlyArray<KinCanvasLayoutItem>;
  /** The screen's shape, width over height, that the areas should roughly fill. */
  readonly aspect?: number;
}): KinCanvasLayout {
  const members = new Map<string, KinCanvasLayoutItem[]>();
  for (const group of input.groups) members.set(group.key, []);
  for (const item of input.items) members.get(item.group)?.push(item);
  const drafts = input.groups.flatMap((group) => {
    const items = members.get(group.key) ?? [];
    if (items.length === 0) return [];
    const cols = colsFor(items.length);
    const rows = Math.ceil(items.length / cols);
    return [
      {
        group,
        items,
        cols,
        w: cols * STEP_X - KIN_CANVAS_GAP + GROUP_PAD * 2,
        h: rows * STEP_Y - KIN_CANVAS_GAP + GROUP_HEAD + GROUP_PAD,
      },
    ];
  });
  const area = drafts.reduce((sum, d) => sum + (d.w + GROUP_GAP) * (d.h + GROUP_GAP), 0);
  const widest = drafts.reduce((max, d) => Math.max(max, d.w), 0);
  const rowWidth = Math.max(widest, Math.sqrt(area * (input.aspect ?? 1.6)) * 1.15);
  const cards = new Map<string, KinCanvasCardBox>();
  const groups: KinCanvasGroupBox[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const draft of drafts) {
    if (x > 0 && x + draft.w > rowWidth) {
      x = 0;
      y += rowH + GROUP_GAP;
      rowH = 0;
    }
    draft.items.forEach((item, i) => {
      cards.set(
        item.key,
        cardAt(
          item,
          x + GROUP_PAD + (i % draft.cols) * STEP_X,
          y + GROUP_HEAD + Math.floor(i / draft.cols) * STEP_Y,
        ),
      );
    });
    groups.push({
      x,
      y,
      w: draft.w,
      h: draft.h,
      key: draft.group.key,
      title: draft.group.title,
      head: GROUP_HEAD,
    });
    x += draft.w + GROUP_GAP;
    rowH = Math.max(rowH, draft.h);
  }
  return {
    cards,
    groups,
    bounds: kinCanvasUnion(groups) ?? { x: 0, y: 0, w: KIN_CANVAS_CARD_W, h: KIN_CANVAS_CARD_H },
  };
}

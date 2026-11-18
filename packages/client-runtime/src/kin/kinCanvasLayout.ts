import type { KinCanvasBox } from "./kinCanvasCamera.ts";

export const KIN_CANVAS_CARD_W = 240;
export const KIN_CANVAS_CARD_H = 132;
export const KIN_CANVAS_GAP = 24;
const GROUP_PAD = 24;
const GROUP_HEAD = 52;
const GROUP_GAP = 96;
const MAX_COLS = 4;
/** Cells a hand-arranged group scans for a free one before giving up and going below. */
const SCAN_ROWS = 40;

/** Something with a place on the canvas: an entry or a widget, in the group it belongs to. */
export interface KinCanvasLayoutItem {
  readonly key: string;
  /** The project it belongs to; null for the ones with none. */
  readonly group: string | null;
}

export interface KinCanvasLayoutGroup {
  readonly key: string | null;
  readonly title: string;
}

export interface KinCanvasCardBox extends KinCanvasBox {
  readonly key: string;
  readonly group: string | null;
  /** It sits at a place someone gave it, not one the canvas chose. */
  readonly placed: boolean;
}

export interface KinCanvasGroupBox extends KinCanvasBox {
  readonly key: string | null;
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

const frameAround = (cards: ReadonlyArray<KinCanvasBox>): KinCanvasBox => {
  const u = kinCanvasUnion(cards) ?? { x: 0, y: 0, w: KIN_CANVAS_CARD_W, h: KIN_CANVAS_CARD_H };
  return {
    x: u.x - GROUP_PAD,
    y: u.y - GROUP_HEAD,
    w: u.w + GROUP_PAD * 2,
    h: u.h + GROUP_HEAD + GROUP_PAD,
  };
};

const colsFor = (count: number) => Math.max(1, Math.min(MAX_COLS, Math.ceil(Math.sqrt(count))));
const STEP_X = KIN_CANVAS_CARD_W + KIN_CANVAS_GAP;
const STEP_Y = KIN_CANVAS_CARD_H + KIN_CANVAS_GAP;

const cardAt = (
  item: KinCanvasLayoutItem,
  x: number,
  y: number,
  placed: boolean,
): KinCanvasCardBox => ({
  key: item.key,
  group: item.group,
  x,
  y,
  w: KIN_CANVAS_CARD_W,
  h: KIN_CANVAS_CARD_H,
  placed,
});

/**
 * Where every card sits, the same way for the same input. A stored place is kept exactly. A group
 * nobody arranged is a grid, packed below the arranged ones; a new card in an arranged group takes
 * the first free cell from its top left, covering nothing.
 */
export function kinCanvasLayout(input: {
  readonly groups: ReadonlyArray<KinCanvasLayoutGroup>;
  readonly items: ReadonlyArray<KinCanvasLayoutItem>;
  readonly places: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  /** The screen's shape, width over height, that packed groups should roughly fill. */
  readonly aspect?: number;
}): KinCanvasLayout {
  const members = new Map<string | null, KinCanvasLayoutItem[]>();
  for (const group of input.groups) members.set(group.key, []);
  for (const item of input.items) {
    const into = members.get(item.group) ?? members.get(null);
    if (into === undefined) members.set(item.group, [item]);
    else into.push(item);
  }
  const titleOf = new Map(input.groups.map((group) => [group.key, group.title]));
  const cards = new Map<string, KinCanvasCardBox>();
  const taken: KinCanvasCardBox[] = [];
  const arranged: Array<{ key: string | null; cards: KinCanvasCardBox[] }> = [];
  const auto: Array<{ key: string | null; items: KinCanvasLayoutItem[] }> = [];

  for (const [key, items] of members) {
    if (items.length === 0) continue;
    const placed = items.filter((item) => input.places.has(item.key));
    if (placed.length === 0) {
      auto.push({ key, items });
      continue;
    }
    const boxes = placed.map((item) => {
      const at = input.places.get(item.key)!;
      return cardAt(item, at.x, at.y, true);
    });
    for (const box of boxes) taken.push(box);
    arranged.push({ key, cards: boxes });
  }

  // New cards in arranged groups: the first free cell, scanning from the group's top left.
  for (const group of arranged) {
    const origin = kinCanvasUnion(group.cards)!;
    const cols = Math.max(MAX_COLS, Math.round(origin.w / STEP_X));
    const loose = members.get(group.key)!.filter((item) => !input.places.has(item.key));
    let cell = 0;
    for (const item of loose) {
      let box: KinCanvasCardBox | null = null;
      while (box === null && cell < cols * SCAN_ROWS) {
        const at = cardAt(
          item,
          origin.x + (cell % cols) * STEP_X,
          origin.y + Math.floor(cell / cols) * STEP_Y,
          false,
        );
        cell += 1;
        if (!taken.some((other) => kinCanvasOverlaps(at, other, KIN_CANVAS_GAP / 2))) box = at;
      }
      const placedBox =
        box ??
        cardAt(
          item,
          origin.x,
          (kinCanvasUnion(taken)?.y ?? 0) + (kinCanvasUnion(taken)?.h ?? 0) + STEP_Y,
          false,
        );
      taken.push(placedBox);
      group.cards.push(placedBox);
    }
  }

  const groups: KinCanvasGroupBox[] = [];
  for (const group of arranged) {
    for (const card of group.cards) cards.set(card.key, card);
    groups.push({
      ...frameAround(group.cards),
      key: group.key,
      title: titleOf.get(group.key) ?? "",
      head: GROUP_HEAD,
    });
  }

  // Groups nobody arranged: a grid each, packed in rows below the arranged ones.
  const drafts = auto.map((group) => {
    const cols = colsFor(group.items.length);
    const rows = Math.ceil(group.items.length / cols);
    return {
      group,
      cols,
      w: cols * STEP_X - KIN_CANVAS_GAP + GROUP_PAD * 2,
      h: rows * STEP_Y - KIN_CANVAS_GAP + GROUP_HEAD + GROUP_PAD,
    };
  });
  const above = kinCanvasUnion(groups);
  const startX = above?.x ?? 0;
  let y = above === null ? 0 : above.y + above.h + GROUP_GAP;
  const area = drafts.reduce((sum, d) => sum + (d.w + GROUP_GAP) * (d.h + GROUP_GAP), 0);
  const widest = drafts.reduce((max, d) => Math.max(max, d.w), 0);
  const rowWidth = Math.max(widest, above?.w ?? 0, Math.sqrt(area * (input.aspect ?? 1.6)) * 1.15);
  let x = startX;
  let rowH = 0;
  for (const draft of drafts) {
    if (x > startX && x - startX + draft.w > rowWidth) {
      x = startX;
      y += rowH + GROUP_GAP;
      rowH = 0;
    }
    draft.group.items.forEach((item, i) => {
      cards.set(
        item.key,
        cardAt(
          item,
          x + GROUP_PAD + (i % draft.cols) * STEP_X,
          y + GROUP_HEAD + Math.floor(i / draft.cols) * STEP_Y,
          false,
        ),
      );
    });
    groups.push({
      x,
      y,
      w: draft.w,
      h: draft.h,
      key: draft.group.key,
      title: titleOf.get(draft.group.key) ?? "",
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

/**
 * The places one drop stores: the dropped card, beside whatever it landed on rather than over it,
 * and every card the canvas laid out itself, where it sits now, so its neighbours don't re-flow.
 */
export function kinCanvasDrop(
  layout: KinCanvasLayout,
  key: string,
  x: number,
  y: number,
): Array<{ key: string; x: number; y: number }> {
  const others = [...layout.cards.values()].filter((card) => card.key !== key);
  const free = (at: { x: number; y: number }) =>
    !others.some((card) =>
      kinCanvasOverlaps({ ...at, w: KIN_CANVAS_CARD_W, h: KIN_CANVAS_CARD_H }, card),
    );
  const spots = others.flatMap((card) => [
    { x: card.x - STEP_X, y: card.y },
    { x: card.x + STEP_X, y: card.y },
    { x: card.x, y: card.y - STEP_Y },
    { x: card.x, y: card.y + STEP_Y },
  ]);
  const distance = (at: { x: number; y: number }) => Math.hypot(at.x - x, at.y - y);
  // Hermes on the phone has no toSorted.
  const nearest = spots
    .filter(free)
    .reduce<{ x: number; y: number } | null>(
      (best, spot) => (best === null || distance(spot) < distance(best) ? spot : best),
      null,
    );
  const at = free({ x, y }) ? { x, y } : (nearest ?? { x, y });
  const places = [{ key, ...at }];
  for (const card of layout.cards.values())
    if (!card.placed && card.key !== key && places.length < 200)
      places.push({ key: card.key, x: card.x, y: card.y });
  return places;
}

/** Where a card dropped at (x, y) lands: snapped to a quiet grid so rows line up. */
export const kinCanvasSnap = (x: number, y: number) => ({
  x: Math.round(x / 8) * 8,
  y: Math.round(y / 8) * 8,
});

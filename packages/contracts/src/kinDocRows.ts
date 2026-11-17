import type { KinDocListRow, KinDocsEvent } from "./kinDocs.ts";

// `kin.docs.subscribe` with `acceptRows`: what a client folds the stream into, and how the Docs
// list page it read (unfiltered: `archived: false, files: false`) is kept equal to a fresh read.
// The server's property test folds with these same functions (`ownerDocs.property.test.ts`).

/** One doc the host sent lately: its row in the list, or null once it left the list. */
export interface KinDocRowEntry {
  readonly seq: number;
  readonly key: string;
  readonly row: KinDocListRow | null;
}

/**
 * What the stream said lately, newest per doc, and the list's total after the latest. A page read
 * at or after `floor` in this `epoch` is brought up to date from here; any other reads again.
 */
export interface KinDocRows {
  readonly epoch: number;
  readonly floor: number;
  readonly seq: number;
  readonly total: number | null;
  /** The highest number dropped for room: a page read before it reads again. */
  readonly evicted: number;
  readonly entries: ReadonlyMap<string, KinDocRowEntry>;
}

/** Docs remembered; past this the oldest go. */
const KIN_DOC_ROWS_CAP = 256;

export const kinDocRowsStart = (seq: number, epoch: number): KinDocRows => ({
  epoch,
  floor: seq,
  seq,
  total: null,
  evicted: 0,
  entries: new Map(),
});

/**
 * Takes in one change. One that names no doc, or names one without saying how it stands (an older
 * host), starts a new epoch at its number unless it is the number held (a reconnect where nothing
 * moved): what it changed can only be read, and a new session may number differently.
 */
export function kinApplyDocsEvent(rows: KinDocRows, event: KinDocsEvent): KinDocRows {
  const { key } = event;
  if (key === undefined || (event.row === undefined && event.unlisted !== true))
    return event.seq === rows.seq ? rows : kinDocRowsStart(event.seq, rows.epoch + 1);
  const held = rows.entries.get(key);
  if (held !== undefined && held.seq >= event.seq) return rows;
  const entries = new Map(rows.entries);
  entries.delete(key);
  entries.set(key, { seq: event.seq, key, row: event.row ?? null });
  let evicted = rows.evicted;
  // Map order is arrival order, since an entry moves to the end when it changes.
  for (const one of entries.values()) {
    if (entries.size <= KIN_DOC_ROWS_CAP) break;
    entries.delete(one.key);
    evicted = Math.max(evicted, one.seq);
  }
  return {
    ...rows,
    seq: Math.max(rows.seq, event.seq),
    total: event.total ?? rows.total,
    evicted,
    entries,
  };
}

/** The Docs list's order (`kin.docs.list`): latest change first, then key. */
function kinDocsOrder(a: KinDocListRow, b: KinDocListRow): number {
  const at = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  if (at !== 0) return at;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** A page of the unfiltered Docs list as a client holds it. */
export interface KinDocsHeldPage {
  readonly docs: ReadonlyArray<KinDocListRow>;
  readonly total: number;
  readonly more: boolean;
  /** The change number it was read (or last brought up) at. */
  readonly seq: number;
  /** The fold whose rows it was read beside; null when there was none yet. */
  readonly epoch: number | null;
}

/**
 * `page` brought up to `rows`: a changed doc put where a read would put it when that falls inside
 * what is held, one that left dropped, and the host's total. The same docs when nothing touched
 * them; null when only a read can be right.
 */
export function kinPatchDocsPage(
  page: KinDocsHeldPage,
  rows: KinDocRows,
): {
  readonly docs: ReadonlyArray<KinDocListRow>;
  readonly total: number;
  readonly more: boolean;
  /** Docs came into or left what is held. */
  readonly moved: boolean;
} | null {
  if (rows.epoch !== page.epoch || page.seq < rows.floor || rows.evicted > page.seq) return null;
  const newer = [...rows.entries.values()]
    .filter((entry) => entry.seq > page.seq)
    .sort((a, b) => a.seq - b.seq);
  if (newer.length === 0)
    return { docs: page.docs, total: page.total, more: page.more, moved: false };
  if (rows.total === null) return null;
  const docs = [...page.docs];
  for (const entry of newer) {
    const at = docs.findIndex((doc) => doc.key === entry.key);
    if (at >= 0) docs.splice(at, 1);
    const row = entry.row;
    if (row === null) continue;
    const last = docs.at(-1);
    // With nothing held and more beyond, where it falls among them is unknown.
    if (page.more && last === undefined) return null;
    if (!page.more || (last !== undefined && kinDocsOrder(row, last) < 0)) {
      const index = docs.findIndex((held) => kinDocsOrder(row, held) < 0);
      docs.splice(index < 0 ? docs.length : index, 0, row);
    }
  }
  const keys = new Set(page.docs.map((doc) => doc.key));
  return {
    docs,
    total: rows.total,
    more: docs.length < rows.total,
    moved: docs.length !== keys.size || docs.some((doc) => !keys.has(doc.key)),
  };
}

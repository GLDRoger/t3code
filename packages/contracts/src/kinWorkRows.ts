import type { KinOrgId } from "./kinChat.ts";
import { kinRestoreRecord } from "./kinWire.ts";
import type {
  KinRecord,
  KinWorkEvent,
  KinWorkListInput,
  KinWorkPrincipal,
  KinWorkSummary,
} from "./kinWork.ts";

// `kin.work.subscribe` with `acceptRows`: what a client folds the stream into, and how a list page
// it already read is kept equal to a fresh read of it. The server's property test folds with these
// same functions (`apps/server/src/kin/work/teamView.property.test.ts`).

type Counts = Extract<KinWorkEvent, { readonly _tag: "counts" }>;
type CountsBody = Omit<Counts, "_tag" | "seq" | "asOf" | "team">;

const principalKey = (owner: KinWorkPrincipal) =>
  owner._tag === "person" ? `person:${owner.personId}` : `agent:${owner.agentId}`;
const principalId = (owner: KinWorkPrincipal) =>
  owner._tag === "person" ? owner.personId : owner.agentId;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `kin.work.summary`'s owner order: most open first, then kind, then id. */
const ownerOrder = (a: KinWorkSummary["owners"][number], b: KinWorkSummary["owners"][number]) =>
  b.open - a.open ||
  (a.owner._tag < b.owner._tag ? -1 : a.owner._tag > b.owner._tag ? 1 : 0) ||
  (principalId(a.owner) < principalId(b.owner)
    ? -1
    : principalId(a.owner) > principalId(b.owner)
      ? 1
      : 0);

/**
 * The server's side of `counts`: what moved between the counts the client holds and `next`, or
 * null when nothing did. With nothing held, all of it.
 */
export function kinWorkCountsOf(
  held: KinWorkSummary | null,
  next: KinWorkSummary,
): CountsBody | null {
  const totals = {
    open: next.open,
    doing: next.doing,
    waiting: next.waiting,
    late: next.late,
    dueThisWeek: next.dueThisWeek,
    ...(next.closed === undefined ? {} : { closed: next.closed }),
  };
  if (held === null)
    return {
      ...totals,
      whole: true,
      owners: next.owners,
      ...(next.parties === undefined ? {} : { parties: next.parties }),
      ...(next.projects === undefined ? {} : { projects: next.projects }),
    };
  const before = new Map(held.owners.map((row) => [principalKey(row.owner), row]));
  const after = new Set(next.owners.map((row) => principalKey(row.owner)));
  const owners = next.owners.filter((row) => !same(before.get(principalKey(row.owner)), row));
  const ownersGone = held.owners
    .filter((row) => !after.has(principalKey(row.owner)))
    .map((row) => row.owner);
  const parties = same(held.parties, next.parties) ? undefined : next.parties;
  const projects = same(held.projects, next.projects) ? undefined : next.projects;
  const moved =
    owners.length > 0 ||
    ownersGone.length > 0 ||
    parties !== undefined ||
    projects !== undefined ||
    totals.open !== held.open ||
    totals.doing !== held.doing ||
    totals.waiting !== held.waiting ||
    totals.late !== held.late ||
    totals.dueThisWeek !== held.dueThisWeek ||
    totals.closed !== held.closed;
  if (!moved) return null;
  return {
    ...totals,
    ...(owners.length === 0 ? {} : { owners }),
    ...(ownersGone.length === 0 ? {} : { ownersGone }),
    ...(parties === undefined ? {} : { parties }),
    ...(projects === undefined ? {} : { projects }),
  };
}

/** The client's side: the counts held, moved by one `counts`. Null when a part is missing. */
export function kinApplyWorkCounts(
  held: KinWorkSummary | null,
  event: Counts,
): KinWorkSummary | null {
  if (event.whole !== true && held === null) return null;
  const owners =
    event.whole === true
      ? (event.owners ?? [])
      : (() => {
          const gone = new Set([
            ...(event.ownersGone ?? []).map(principalKey),
            ...(event.owners ?? []).map((row) => principalKey(row.owner)),
          ]);
          return [
            ...held!.owners.filter((row) => !gone.has(principalKey(row.owner))),
            ...(event.owners ?? []),
          ].sort(ownerOrder);
        })();
  const keep = <K extends "parties" | "projects">(key: K) =>
    event[key] !== undefined ? event[key] : event.whole === true ? undefined : held![key];
  const parties = keep("parties");
  const projects = keep("projects");
  return {
    open: event.open,
    doing: event.doing,
    waiting: event.waiting,
    late: event.late,
    dueThisWeek: event.dueThisWeek,
    ...(event.closed === undefined ? {} : { closed: event.closed }),
    owners,
    ...(parties === undefined ? {} : { parties }),
    ...(projects === undefined ? {} : { projects }),
    seq: event.seq,
    asOf: event.asOf,
  };
}

/** One entry the host sent lately: as it is now, or null once gone from sight. */
export interface KinWorkRowEntry {
  readonly seq: number;
  readonly key: string;
  /** Its list; null when the host didn't say, so every list treats it as maybe theirs. */
  readonly list: string | null;
  readonly record: KinRecord | null;
  /** The `seq` it came into this viewer's sight at, when the host said; 0 otherwise. */
  readonly freshAt: number;
  /** When it arrived here, counting up: a page applies what arrived since it last looked. */
  readonly arrival: number;
}

/**
 * What the stream said lately, newest per entry. A page read at or after `floor` in this `epoch`
 * is brought up to date from here; one read earlier, or in another epoch, reads again.
 */
export interface KinWorkRows {
  readonly epoch: number;
  readonly floor: number;
  readonly seq: number;
  readonly arrival: number;
  /** The latest arrival dropped for room: a page that hadn't looked since reads again. */
  readonly evicted: number;
  readonly entries: ReadonlyMap<string, KinWorkRowEntry>;
}

/** Entries remembered; past this the oldest go. */
const KIN_WORK_ROWS_CAP = 512;

export const kinWorkRowsStart = (seq: number, epoch = 0): KinWorkRows => ({
  epoch,
  floor: seq,
  seq,
  arrival: 0,
  evicted: 0,
  entries: new Map(),
});

type RowEvent = Extract<KinWorkEvent, { readonly _tag: "upsert" | "removed" }>;

/** Takes in one `upsert` or `removed`; anything at or below what is held is old news. */
export function kinApplyWorkRow(rows: KinWorkRows, event: RowEvent, orgId: KinOrgId): KinWorkRows {
  const key = event._tag === "upsert" ? event.record.key : event.key;
  const held = rows.entries.get(key);
  if (held !== undefined && held.seq >= event.seq) return rows;
  const arrival = rows.arrival + 1;
  const entries = new Map(rows.entries);
  entries.delete(key);
  entries.set(
    key,
    event._tag === "upsert"
      ? {
          seq: event.seq,
          key,
          list: event.list,
          record: kinRestoreRecord(event.record, orgId),
          freshAt: event.fresh === true ? event.seq : (held?.freshAt ?? 0),
          arrival,
        }
      : {
          seq: event.seq,
          key,
          list: event.list ?? held?.list ?? null,
          record: null,
          freshAt: held?.freshAt ?? 0,
          arrival,
        },
  );
  let evicted = rows.evicted;
  // Map order is arrival order, since an entry is moved to the end when it changes.
  for (const one of entries.values()) {
    if (entries.size <= KIN_WORK_ROWS_CAP) break;
    entries.delete(one.key);
    evicted = Math.max(evicted, one.arrival);
  }
  return { ...rows, seq: Math.max(rows.seq, event.seq), arrival, evicted, entries };
}

/** A page of `kin.work.list` as a client holds it, with what it learned since the read. */
export interface KinWorkHeldPage {
  readonly records: ReadonlyArray<KinRecord>;
  readonly total: number;
  /** More rows match than are held. */
  readonly more: boolean;
  /** The change number the host read the page at. */
  readonly readSeq: number;
  readonly epoch: number;
  /** The last arrival in `KinWorkRows` it was brought up to; 0 before the first. */
  readonly mark: number;
  /** When the host read it (`asOf`); null when unknown. */
  readonly asOf: string | null;
  /** Rows the stream named since the read that the page doesn't hold, as each was last. */
  readonly known: ReadonlyMap<string, KinRecord | null>;
}

/** A page as the host answered it, ready to be kept up to date from `rows`. */
export const kinWorkHeldPage = (
  page: {
    readonly records: ReadonlyArray<KinRecord>;
    readonly total: number;
    readonly more: boolean;
  },
  read: { readonly seq: number; readonly asOf: string | null; readonly epoch: number },
): KinWorkHeldPage => ({
  records: page.records,
  total: page.total,
  more: page.more,
  readSeq: read.seq,
  epoch: read.epoch,
  mark: 0,
  asOf: read.asOf,
  known: new Map(),
});

const STATE_RANK: Record<string, number> = { doing: 0, waiting: 1, open: 2 };
const time = (iso: string | null) => (iso === null ? null : Date.parse(iso));

/**
 * `KinRecords.query`'s order for Work: under way first, then soonest due, then oldest, then key.
 * A read with a due window (`dueBy`) is soonest due first whatever the state (`dueFirst`).
 */
function kinWorkOrder(a: KinRecord, b: KinRecord, dueFirst: boolean): number {
  const rank = (record: KinRecord) => STATE_RANK[record.state] ?? 3;
  if (!dueFirst && rank(a) !== rank(b)) return rank(a) - rank(b);
  const dueA = time(a.dueAt);
  const dueB = time(b.dueAt);
  if ((dueA === null) !== (dueB === null)) return dueA === null ? 1 : -1;
  if (dueA !== null && dueB !== null && dueA !== dueB) return dueA - dueB;
  const madeA = Date.parse(a.createdAt);
  const madeB = Date.parse(b.createdAt);
  if (madeA !== madeB) return madeA - madeB;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

const CLOSED = new Set(["done", "dropped"]);

/** A person's tasks are those they hold or are on besides its holder; an agent's, those it holds. */
const ownedBy = (owner: KinWorkPrincipal, record: KinRecord) =>
  principalKey(owner) === principalKey(record.owner) ||
  (owner._tag === "person" &&
    (record.alsoOn ?? []).some((who) => principalKey(who) === principalKey(owner)));

/**
 * Whether `record` is one `input` asks for, as `KinRecords.query` filters; undefined for a filter
 * a row can't answer, which the caller reads again for: words, a money window, and a client or
 * project, which a teammate's row may leave out while their filter still counts it.
 */
function kinWorkMatches(
  input: Omit<KinWorkListInput, "orgId">,
  record: KinRecord,
): boolean | undefined {
  if (
    (input.text !== undefined && input.text.trim() !== "") ||
    input.party !== undefined ||
    input.project !== undefined ||
    input.listCategory !== undefined ||
    input.dateFrom !== undefined ||
    input.dateTo !== undefined ||
    input.paidFrom !== undefined ||
    input.paidTo !== undefined ||
    input.spentFrom !== undefined ||
    input.spentTo !== undefined ||
    input.totalsBy !== undefined
  )
    return undefined;
  if (input.owner !== undefined && !ownedBy(input.owner, record)) return false;
  if (input.states !== undefined && input.states.length > 0) {
    if (!input.states.includes(record.state)) return false;
  } else if (input.open === true && CLOSED.has(record.state)) return false;
  else if (input.open === false && !CLOSED.has(record.state)) return false;
  if (input.late !== undefined && input.late !== record.late) return false;
  const due = time(record.dueAt);
  if (input.dueBy !== undefined) {
    const by = Date.parse(input.dueBy);
    if (Number.isNaN(by)) return undefined;
    if (due === null || due > by) return false;
  }
  if (input.dueAfter !== undefined) {
    const after = Date.parse(input.dueAfter);
    if (Number.isNaN(after)) return undefined;
    if (due === null || due < after) return false;
  }
  if (input.category !== undefined && input.category !== record.category) return false;
  if (input.side !== undefined && input.side !== record.side) return false;
  if (input.repo !== undefined && record.repo?.toLowerCase() !== input.repo.toLowerCase())
    return false;
  return true;
}

/**
 * `page` brought up to `rows`: held rows replaced in place or dropped, a new match put where a
 * read would put it when it falls inside what is held, and the total moved. The same page when
 * nothing touched it; null when a fresh read is the only way to be right.
 */
export function kinPatchWorkPage(
  page: KinWorkHeldPage,
  input: Omit<KinWorkListInput, "orgId">,
  rows: KinWorkRows,
): {
  readonly page: KinWorkHeldPage;
  /** Rows came into or left what is held. */
  readonly moved: boolean;
} | null {
  if (rows.epoch !== page.epoch || page.readSeq < rows.floor || rows.evicted > page.mark)
    return null;
  // What arrived since it last looked, and is newer than its read; in the order of their numbers.
  const newer = [...rows.entries.values()]
    .filter((entry) => entry.arrival > page.mark && entry.seq > page.readSeq)
    .sort((a, b) => a.seq - b.seq);
  if (newer.length === 0)
    return {
      page: rows.arrival > page.mark ? { ...page, mark: rows.arrival } : page,
      moved: false,
    };
  const list = input.list ?? "work";
  const dueFirst = input.dueBy !== undefined;
  const records = [...page.records];
  let { total } = page;
  const known = new Map(page.known);
  for (const entry of newer) {
    if (entry.list === "clients" || entry.list === "projects") {
      // A held row shows its client's or project's name and label: only a read redraws them.
      const named = (record: KinRecord) =>
        record.party?.key === entry.key || record.project?.key === entry.key;
      if (records.some(named)) return null;
      continue;
    }
    if (entry.list !== null && entry.list !== list) continue;
    // Work's order is the only one rebuilt here: another list's own entries read it again.
    if (list !== "work") return null;
    const at = records.findIndex((record) => record.key === entry.key);
    const prior = known.get(entry.key);
    let was: boolean | undefined;
    if (at >= 0) was = true;
    else if (prior === null) was = false;
    else if (prior !== undefined) was = kinWorkMatches(input, prior);
    else if (entry.freshAt > page.readSeq) was = false;
    else if (
      entry.record !== null &&
      page.asOf !== null &&
      Date.parse(entry.record.createdAt) > Date.parse(page.asOf)
    )
      was = false;
    else if (!page.more) was = false;
    if (was === undefined) return null;
    const now = entry.record === null ? false : kinWorkMatches(input, entry.record);
    if (now === undefined) return null;
    total = Math.max(0, total + (now ? 1 : 0) - (was ? 1 : 0));
    if (at >= 0) records.splice(at, 1);
    known.set(entry.key, entry.record);
    const record = entry.record;
    if (now && record !== null) {
      const last = records.at(-1);
      // With nothing held and more beyond, where it falls among them is unknown.
      if (page.more && last === undefined) return null;
      if (!page.more || (last !== undefined && kinWorkOrder(record, last, dueFirst) < 0)) {
        const index = records.findIndex((held) => kinWorkOrder(record, held, dueFirst) < 0);
        records.splice(index < 0 ? records.length : index, 0, record);
        known.delete(entry.key);
      }
    }
  }
  // A held row that didn't change keeps its object, so nothing redraws it.
  const before = new Map(page.records.map((record) => [record.key, record]));
  const kept = records.map((record) => {
    const old = before.get(record.key);
    return old !== undefined && same(old, record) ? old : record;
  });
  const keys = new Set(page.records.map((record) => record.key));
  return {
    page: {
      ...page,
      records: kept,
      total,
      more: page.more && kept.length < total,
      mark: rows.arrival,
      known,
    },
    // Rows came or went: the host's offset for the next page no longer lines up.
    moved: kept.length !== keys.size || kept.some((record) => !keys.has(record.key)),
  };
}

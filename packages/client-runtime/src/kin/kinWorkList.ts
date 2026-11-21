import {
  kinPatchWorkPage,
  kinWorkHeldPage,
  type EnvironmentId,
  type KinOrgId,
  type KinPartiesInput,
  type KinPartiesResult,
  type KinProjectsInput,
  type KinProjectsResult,
  type KinRecord,
  type KinWorkHeldPage,
  type KinWorkListInput,
  type KinWorkListResult,
  type KinWorkMoveCounts,
  type KinWorkRowMove,
  type KinWorkRows,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import {
  isKinChatError,
  KIN_WORK_DEFAULT_FILTER,
  kinWorkByMove,
  kinWorkListQuery,
  kinWorkRefsMatching,
  kinWorkRefused,
  kinWorkSameFilter,
  type KinWorkFilter,
  type KinWorkRef,
} from "./kinWork.ts";
import { kinFailure } from "./kinAnswers.ts";
import { kinNowMs } from "./kinNow.ts";
import type { KinLink } from "./kinHost.ts";
import { kinWorkRefOf } from "./kinWorkClients.ts";

export const KIN_WORK_PAGE = 50;

/** The host refused the read, or no longer finds what it reads: not a failure that may pass. */
const kinWorkDenied = (error: unknown) =>
  kinWorkRefused(error) || (isKinChatError(error) && error.reason === "not_found");
/** Typing in the search box reads once the owner pauses, not per letter. */
const KIN_WORK_TYPING_MS = 250;

/** One filter's rows as far as they have been read, and what is still on its way. */
export interface KinPagedListState<Filter, Row> {
  readonly filter: Filter;
  readonly records: ReadonlyArray<Row>;
  /** How many the host has for this filter; null before its first answer. */
  readonly total: number | null;
  readonly more: boolean;
  /** The change number the rows were read at; null before the first answer. */
  readonly seq: number | null;
  /** The first read of this filter, with nothing to show yet. */
  readonly loading: boolean;
  /** Why the first read failed; null otherwise. */
  readonly failed: unknown;
  /** Rows are shown while they are read again. */
  readonly refreshing: boolean;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
  /** A read-again failed, so the rows shown are older than the host's. */
  readonly stale: boolean;
  /** When the rows shown were last read or caught up, epoch ms; null before the first answer. */
  readonly readAt: number | null;
}

export type KinWorkListState = KinPagedListState<KinWorkFilter, KinRecord>;

const emptyState = <Filter, Row>(filter: Filter): KinPagedListState<Filter, Row> => ({
  filter,
  records: [],
  total: null,
  more: false,
  seq: null,
  loading: true,
  failed: null,
  refreshing: false,
  loadingMore: false,
  moreFailed: false,
  stale: false,
  readAt: null,
});

/**
 * What a list screen shows where its rows go: the rows once any were read for this filter, kept
 * through a failed or offline read again; with none held, offline says so rather than a spinner
 * or a failure, which is all a read the connection can't carry would show.
 */
export function kinListShown(
  state: Pick<KinPagedListState<unknown, unknown>, "seq" | "loading" | "failed">,
  link: KinLink,
): "rows" | "loading" | "offline" | "failed" {
  if (state.seq !== null) return "rows";
  if (link === "offline") return "offline";
  if (state.loading) return "loading";
  return state.failed === null ? "rows" : "failed";
}

export const kinPagedListInitial = emptyState;
export const KIN_WORK_LIST_INITIAL: KinWorkListState = emptyState(KIN_WORK_DEFAULT_FILTER);

/** One page as any of Work's lists answers with it. */
export interface KinPage<Row> {
  readonly rows: ReadonlyArray<Row>;
  readonly total: number;
  readonly nextCursor: string | null;
  readonly seq: number;
}

/**
 * A list's reads: one filter at a time, a page at a time, read again when the host's change
 * number passes the one the rows were read at. Only one read runs at once; a change that
 * arrives meanwhile is remembered and costs a single read afterwards, however many arrived.
 * Tasks, clients and projects are each one of these.
 */
export function createKinPagedList<Filter extends { readonly text: string }, Row>(options: {
  readonly initial: Filter;
  readonly sameFilter: (a: Filter, b: Filter) => boolean;
  /** Reads one page of `filter`, from `cursor` when given. */
  readonly read: (
    filter: Filter,
    page: { readonly limit: number; readonly cursor?: string },
  ) => Promise<AtomCommandResult<KinPage<Row>, unknown>>;
  /** What makes two rows the same one. */
  readonly idOf: (row: Row) => string;
  readonly onChange: (state: KinPagedListState<Filter, Row>) => void;
  /** Runs `run` after `ms`; returns its cancel. */
  readonly schedule: (run: () => void, ms: number) => () => void;
  readonly now?: () => number;
  /**
   * The rows held brought up to date without a read, from what the host already sent; null when
   * only a read can. `moved` says rows came or went, so the next page reads from the top.
   */
  readonly catchUp?: (state: KinPagedListState<Filter, Row>) => {
    readonly records: ReadonlyArray<Row>;
    readonly total: number;
    readonly more: boolean;
    readonly moved: boolean;
  } | null;
}) {
  type State = KinPagedListState<Filter, Row>;
  const append = (held: ReadonlyArray<Row>, page: ReadonlyArray<Row>) => {
    // A row that moved up between two page reads would otherwise show twice.
    const seen = new Set(held.map(options.idOf));
    return [...held, ...page.filter((row) => !seen.has(options.idOf(row)))];
  };
  const sameFilter = options.sameFilter;
  const now = options.now ?? kinNowMs;
  let state: State = emptyState(options.initial);
  // Bumped whenever what is being read stops mattering: a new filter, a manual refresh, the end.
  let generation = 0;
  let running = false;
  let cursor: string | null = null;
  /** Rows came or went without a read, so `cursor`'s place among them no longer holds. */
  let drifted = false;
  /** The highest change number announced while a read was running. */
  let announced: number | null = null;
  /** One announced meanwhile has to read, whatever its number. */
  let announcedForce = false;
  /** The filter the rows on screen were read for; null with none. */
  let shownFor: Filter | null = null;
  let cancelTyping: (() => void) | null = null;

  const set = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    options.onChange(state);
  };

  const afterRead = () => {
    running = false;
    const seen = announced;
    const force = announcedForce;
    announced = null;
    announcedForce = false;
    if (seen !== null) changed(seen, force);
  };

  /** Reads from the top: one page, or as many as it takes to cover the rows already shown. */
  const load = async (want: number) => {
    const mine = ++generation;
    running = true;
    const { filter } = state;
    let records: ReadonlyArray<Row> = [];
    let next: string | null = null;
    let seq: number | null = null;
    let total = 0;
    do {
      const result = await options.read(filter, {
        limit: KIN_WORK_PAGE,
        ...(next === null ? {} : { cursor: next }),
      });
      if (mine !== generation) return;
      if (!AsyncResult.isSuccess(result)) {
        const failed = squashAtomCommandFailure(result);
        // Rows read for other words can't stand in for these, so only the same filter's stay up,
        // and only through a failure that may pass: a refusal means they are no longer theirs.
        if (shownFor !== null && sameFilter(shownFor, state.filter) && !kinWorkDenied(failed))
          set({ refreshing: false, stale: true });
        else {
          shownFor = null;
          set({ ...emptyState<Filter, Row>(state.filter), loading: false, failed });
        }
        return afterRead();
      }
      records = append(records, result.value.rows);
      next = result.value.nextCursor;
      total = result.value.total;
      // The first page's number: a change during the later pages reads everything again.
      seq ??= result.value.seq;
    } while (next !== null && records.length < want);
    cursor = next;
    drifted = false;
    shownFor = state.filter;
    set({
      records,
      total,
      more: next !== null,
      seq,
      loading: false,
      failed: null,
      refreshing: false,
      loadingMore: false,
      moreFailed: false,
      stale: false,
      readAt: now(),
    });
    afterRead();
  };

  const reread = () => {
    if (state.seq !== null) set({ refreshing: true });
    else set({ loading: true, failed: null });
    void load(Math.max(state.records.length, KIN_WORK_PAGE));
  };

  /** The host announced change number `seq`; `force` reads again whatever the number. */
  function changed(seq: number, force = false) {
    const behind = force || state.seq === null || seq > state.seq || state.stale;
    if (!behind) return;
    if (running) {
      announced = Math.max(announced ?? 0, seq);
      announcedForce ||= force;
      return;
    }
    // Still typing: the read that follows the pause will be current anyway.
    if (cancelTyping !== null) return;
    const caught = force || state.stale || state.seq === null ? null : options.catchUp?.(state);
    if (caught === undefined || caught === null) return reread();
    drifted ||= caught.moved;
    const same =
      caught.total === state.total &&
      caught.more === state.more &&
      caught.records.length === state.records.length &&
      caught.records.every((row, index) => row === state.records[index]);
    // Nothing shown moved: the number advances without a redraw.
    if (same) state = { ...state, seq, readAt: now() };
    else
      set({ records: caught.records, total: caught.total, more: caught.more, seq, readAt: now() });
  }

  const abandon = () => {
    generation += 1;
    running = false;
    announced = null;
    cancelTyping?.();
    cancelTyping = null;
  };

  return {
    getState: () => state,
    /** Reads the current filter from the top; call once the list is on screen. */
    start: () => {
      abandon();
      reread();
    },
    setFilter: (filter: Filter) => {
      if (sameFilter(filter, state.filter)) {
        // The search box keeps what was typed, spaces included.
        if (filter.text !== state.filter.text) set({ filter });
        return;
      }
      const typing = sameFilter({ ...filter, text: "" }, { ...state.filter, text: "" });
      abandon();
      if (typing && state.seq !== null) {
        set({ filter, refreshing: true });
        cancelTyping = options.schedule(() => {
          cancelTyping = null;
          void load(KIN_WORK_PAGE);
        }, KIN_WORK_TYPING_MS);
        return;
      }
      shownFor = null;
      state = emptyState(filter);
      options.onChange(state);
      void load(KIN_WORK_PAGE);
    },
    changed,
    /** The next page, when the owner reaches the end of what is shown. */
    loadMore: async () => {
      if (running || state.seq === null || !state.more) return;
      if (drifted || cursor === null) {
        set({ loadingMore: true, moreFailed: false });
        return load(state.records.length + KIN_WORK_PAGE);
      }
      const mine = ++generation;
      running = true;
      set({ loadingMore: true, moreFailed: false });
      const result = await options.read(state.filter, { limit: KIN_WORK_PAGE, cursor });
      if (mine !== generation) return;
      if (AsyncResult.isSuccess(result)) {
        cursor = result.value.nextCursor;
        set({
          records: append(state.records, result.value.rows),
          total: result.value.total,
          more: cursor !== null,
          loadingMore: false,
        });
      } else set({ loadingMore: false, moreFailed: true });
      afterRead();
    },
    /** Reads again now: the retry after a failure, and pull to refresh. */
    refresh: () => {
      abandon();
      reread();
    },
    /**
     * Back on screen with the rows it held: the next `changed` catches them up from what the host
     * sent since (`catchUp`), reading only what that can't bring. Nothing held, or a failure, reads.
     */
    resume: () => {
      abandon();
      if (state.seq === null || state.failed !== null || state.stale) reread();
    },
    /** Stops caring about anything in flight. `start` brings it back. */
    dispose: abandon,
  };
}

/** The Work list: tasks by view, owner, client, project and words. */
export function createKinWorkList(options: {
  readonly orgId: KinOrgId;
  readonly read: (
    input: KinWorkListInput,
  ) => Promise<AtomCommandResult<KinWorkListResult, unknown>>;
  readonly onChange: (state: KinWorkListState) => void;
  readonly now: () => number;
  /** The host has the newer filters, so "Due this week" is asked for whole. */
  readonly hostFilters: () => boolean;
  /** Runs `run` after `ms`; returns its cancel. */
  readonly schedule: (run: () => void, ms: number) => () => void;
  /** Where the list starts: narrowed to a client or project, when opened from one. */
  readonly initial?: KinWorkFilter;
  /** The tasks the host sent whole lately (`KinWorkLive.rows`); null from an older host. */
  readonly rows?: () => KinWorkRows | null;
}) {
  const follow = kinWorkPageFollower(options.rows ?? (() => null));
  // A `byMove` read's steps by key and its counts, kept beside the rows they came with.
  let moves = new Map<string, KinWorkRowMove>();
  let counts: KinWorkMoveCounts | null = null;
  let movesFor: KinWorkFilter | null = null;
  const list = createKinPagedList<KinWorkFilter, KinRecord>({
    initial: options.initial ?? KIN_WORK_DEFAULT_FILTER,
    sameFilter: kinWorkSameFilter,
    idOf: (record) => record.recordId,
    onChange: options.onChange,
    schedule: options.schedule,
    now: options.now,
    read: async (filter, page) => {
      const input = {
        ...kinWorkListQuery(options.orgId, filter, options.now(), options.hostFilters()),
        ...page,
      };
      const result = await follow.read(input, options.read);
      if (AsyncResult.isSuccess(result)) {
        const top = page.cursor === undefined;
        if (top || movesFor === null || !kinWorkSameFilter(movesFor, filter)) moves = new Map();
        movesFor = filter;
        for (const move of result.value.moves ?? []) moves.set(move.key, move);
        if (top || result.value.counts !== undefined) counts = result.value.counts ?? null;
      }
      return mapPage(result, (value) => ({ ...value, rows: value.records }));
    },
    // Grouped by whose move, a change can move a row between groups: only a read says where.
    catchUp: (state) => (kinWorkByMove(state.filter) ? null : follow.catchUp(state.records)),
  });
  const current = () => movesFor !== null && kinWorkSameFilter(movesFor, list.getState().filter);
  return {
    ...list,
    /** Each row's step from the last `byMove` read; empty from an older host or another read. */
    moves: (): ReadonlyMap<string, KinWorkRowMove> => (current() ? moves : new Map()),
    /** The groups' counts from the last `byMove` read; null from an older host or another read. */
    counts: () => (current() ? counts : null),
    /** The host announced `seq`: rows it sent apply in place, and anything else reads again. */
    changed: (seq: number) => list.changed(seq, follow.newEpoch()),
    resume: () => (follow.newEpoch() ? list.refresh() : list.resume()),
  };
}

/**
 * One list's entries (quotes, expenses, a list someone made) a page at a time, as
 * `createKinPagedList`, brought up to date from Work's rows without a read when none of them is
 * this list's: a task or an invoice changing leaves the quotes on screen as they are.
 */
export function createKinListEntries<Filter extends { readonly text: string }>(options: {
  readonly initial: Filter;
  readonly sameFilter: (a: Filter, b: Filter) => boolean;
  /** The read a filter makes, without its page. */
  readonly query: (filter: Filter) => KinWorkListInput;
  /** One page of `filter`'s read. */
  readonly read: (
    input: KinWorkListInput,
    filter: Filter,
  ) => Promise<AtomCommandResult<KinWorkListResult, unknown>>;
  readonly onChange: (state: KinPagedListState<Filter, KinRecord>) => void;
  readonly schedule: (run: () => void, ms: number) => () => void;
  /** The entries the host sent whole lately (`KinWorkLive.rows`); null from an older host. */
  readonly rows: () => KinWorkRows | null;
}) {
  const follow = kinWorkPageFollower(options.rows);
  const list = createKinPagedList<Filter, KinRecord>({
    initial: options.initial,
    sameFilter: options.sameFilter,
    idOf: (record) => record.recordId,
    onChange: options.onChange,
    schedule: options.schedule,
    read: async (filter, page) =>
      mapPage(
        await follow.read({ ...options.query(filter), ...page }, (input) =>
          options.read(input, filter),
        ),
        (value) => ({
          ...value,
          rows: value.records,
        }),
      ),
    catchUp: (state) => follow.catchUp(state.records),
  });
  return {
    ...list,
    changed: (seq: number) => list.changed(seq, follow.newEpoch()),
    resume: () => (follow.newEpoch() ? list.refresh() : list.resume()),
  };
}

/** How long a list off screen is caught up from the stream; past this it is read again. */
const KIN_LIST_KEPT_MS = 5 * 60_000;
const KIN_LISTS_KEPT = 4;

/**
 * Lists kept while their screen is away, so coming back shows what was held: caught up from the
 * stream when recent, else read again with the rows still up, which stay if that read can't be
 * made. One screen holds a list at a time; a few are kept.
 */
export function createKinListKeeper<
  List extends {
    readonly dispose: () => void;
    readonly resume: () => void;
    readonly refresh: () => void;
  },
  State,
>(now: () => number) {
  type Kept = {
    readonly key: string;
    readonly list: List;
    /** Where the list's changes go: the screen showing it now. */
    readonly sink: { current: (state: State) => void };
    shown: boolean;
    at: number;
  };
  const kept = new Map<string, Kept>();
  return {
    /** The list kept under `key` when no screen shows it, else a new one. */
    take: (key: string, make: (onChange: (state: State) => void) => List): Kept => {
      const held = kept.get(key);
      if (held !== undefined && !held.shown) return held;
      const sink = { current: (_state: State) => {} };
      return { key, list: make((state) => sink.current(state)), sink, shown: false, at: now() };
    },
    /** A screen shows it; its changes go to `onChange`. */
    show: (entry: Kept, onChange: (state: State) => void) => {
      entry.shown = true;
      entry.sink.current = onChange;
      kept.delete(entry.key);
      kept.set(entry.key, entry);
      for (const old of kept.values()) {
        if (kept.size <= KIN_LISTS_KEPT) break;
        if (!old.shown) kept.delete(old.key);
      }
    },
    /** A kept list back on screen: caught up when recent, else read again over what it holds. */
    resume: (entry: Kept) =>
      now() - entry.at < KIN_LIST_KEPT_MS ? entry.list.resume() : entry.list.refresh(),
    /** Its screen left: reads in flight stop, and it waits to be taken again. */
    hide: (entry: Kept) => {
      entry.list.dispose();
      entry.shown = false;
      entry.at = now();
      entry.sink.current = () => {};
    },
    /** Whether `take` handed back a list held from before, which `resume`s instead of starting. */
    wasKept: (entry: Kept) => kept.get(entry.key) === entry,
  };
}

/**
 * Keeps one list read's pages in step with the rows Work's stream sends: what each read answered,
 * at which number and epoch, and what the stream said since.
 */
function kinWorkPageFollower(rows: () => KinWorkRows | null) {
  let held: { readonly input: KinWorkListInput; readonly page: KinWorkHeldPage } | null = null;
  /** Counts reads from the top: an answer to one since overtaken is not the page shown. */
  let reads = 0;
  return {
    /** Reads through `read`, keeping its answer; a page after the first adds to the one held. */
    read: async (
      input: KinWorkListInput,
      read: (input: KinWorkListInput) => Promise<AtomCommandResult<KinWorkListResult, unknown>>,
    ) => {
      const sent = rows();
      const top = input.cursor === undefined ? ++reads : reads;
      if (input.cursor === undefined) held = null;
      const before = held;
      const result = await read(input);
      if (top !== reads) return result;
      if (!AsyncResult.isSuccess(result) || sent === null) {
        held = null;
        return result;
      }
      const { value } = result;
      const more = value.nextCursor !== null;
      if (input.cursor === undefined) {
        const { cursor: _cursor, limit: _limit, ...asked } = input;
        held = {
          input: asked,
          page: {
            ...kinWorkHeldPage(
              { records: value.records, total: value.total, more },
              { seq: value.seq, asOf: value.asOf ?? null, epoch: sent.epoch },
            ),
            mark: sent.arrival,
          },
        };
      } else if (before !== null && held === before) {
        const seen = new Set(before.page.records.map((record) => record.key));
        held = {
          input: before.input,
          page: {
            ...before.page,
            records: [
              ...before.page.records,
              ...value.records.filter((record) => !seen.has(record.key)),
            ],
            total: value.total,
            more,
          },
        };
      }
      return result;
    },
    /** The held page as it stands now; null when only a read can tell. */
    catchUp: (shown: ReadonlyArray<KinRecord>) => {
      const now = rows();
      if (held === null || now === null) return null;
      // What is on screen has to be what was read, or the page patched isn't the one shown.
      const { records } = held.page;
      if (records.length !== shown.length || records.some((r, i) => r.key !== shown[i]?.key))
        return null;
      const patched = kinPatchWorkPage(held.page, held.input, now);
      if (patched === null) return null;
      held = { input: held.input, page: patched.page };
      return {
        records: patched.page.records,
        total: patched.page.total,
        more: patched.page.more,
        moved: patched.moved,
      };
    },
    /** The stream started over since the page was read: it reads again. */
    newEpoch: () => {
      const now = rows();
      return held !== null && now !== null && held.page.epoch !== now.epoch;
    },
  };
}

/**
 * One read of Work's tasks (a person's due today) kept current: read once, then brought up to
 * date from the rows the stream sends, and read again only when those can't say.
 */
export function createKinWorkFollowedRead(options: {
  readonly read: (
    input: KinWorkListInput,
  ) => Promise<AtomCommandResult<KinWorkListResult, unknown>>;
  readonly rows: () => KinWorkRows | null;
  /** The rows to show for `input`; an empty list when the first read failed. */
  readonly onChange: (records: ReadonlyArray<KinRecord>, input: KinWorkListInput) => void;
}) {
  const follow = kinWorkPageFollower(options.rows);
  let asked: KinWorkListInput | null = null;
  let shown: ReadonlyArray<KinRecord> | null = null;
  let generation = 0;
  const read = async (input: KinWorkListInput) => {
    const mine = ++generation;
    const result = await follow.read(input, options.read);
    if (mine !== generation) return;
    // A failed reread keeps what was shown; the stale notice says the page is behind.
    if (AsyncResult.isSuccess(result)) shown = result.value.records;
    else shown ??= [];
    options.onChange(shown, input);
  };
  return {
    /** Wants `input` as of a change to Work; reads only what the stream couldn't bring. */
    update: (input: KinWorkListInput) => {
      const same = asked !== null && JSON.stringify(input) === JSON.stringify(asked);
      const caught = !same || shown === null || follow.newEpoch() ? null : follow.catchUp(shown);
      asked = input;
      if (caught === null) return void read(input);
      const before = shown;
      if (
        before === null ||
        caught.records.length !== before.length ||
        caught.records.some((record, index) => record !== before[index])
      ) {
        shown = caught.records;
        options.onChange(shown, input);
      }
    },
    /** Stops caring about a read in flight; the next `update` reads afresh. */
    dispose: () => {
      generation += 1;
      asked = null;
      shown = null;
    },
  };
}

/** A host's answer as a page, whatever it calls its rows. */
export function mapPage<A, Row>(
  result: AtomCommandResult<A, unknown>,
  page: (value: A) => KinPage<Row>,
): AtomCommandResult<KinPage<Row>, unknown> {
  return AsyncResult.isSuccess(result)
    ? AsyncResult.success(page(result.value))
    : AsyncResult.failure(result.cause);
}

export type KinWorkList = ReturnType<typeof createKinWorkList>;

/** A picker's search answers at most this many names; past it, the picker asks for more letters. */
export const KIN_PICKER_SEARCH_CAP = 30;

export const KIN_PICKER_COPY = {
  searching: "Searching…",
  failed: "Couldn't search.",
  narrow: "Type more to narrow",
  nothing: (noun: "client" | "project", words: string) => `No ${noun} named “${words}”`,
} as const;

export interface KinPickerSearchState {
  /** What is typed, as typed. */
  readonly text: string;
  /** The host's answer for what is typed; null before it, and with nothing typed. */
  readonly found: {
    readonly open: ReadonlyArray<KinWorkRef>;
    readonly done: ReadonlyArray<KinWorkRef>;
    readonly more: boolean;
  } | null;
  readonly loading: boolean;
  /** Why the last search failed; null otherwise. */
  readonly failed: unknown;
}

export const KIN_PICKER_SEARCH_IDLE: KinPickerSearchState = {
  text: "",
  found: null,
  loading: false,
  failed: null,
};

/**
 * A client or project picker's search over every one the person may see, not only the first page
 * it holds: one read once typing pauses, none while nothing is typed.
 */
export function createKinPickerSearch(options: {
  readonly orgId: KinOrgId;
  readonly kind: "clients" | "projects";
  /** Projects only: the done ones too, so a late task can still be filed there. */
  readonly done: boolean;
  readonly readClients: (
    input: KinPartiesInput,
  ) => Promise<AtomCommandResult<KinPartiesResult, unknown>>;
  readonly readProjects: (
    input: KinProjectsInput,
  ) => Promise<AtomCommandResult<KinProjectsResult, unknown>>;
  readonly onChange: (state: KinPickerSearchState) => void;
  /** Runs `run` after `ms`; returns its cancel. */
  readonly schedule: (run: () => void, ms: number) => () => void;
}) {
  let state = KIN_PICKER_SEARCH_IDLE;
  let generation = 0;
  let cancelTyping: (() => void) | null = null;
  const set = (patch: Partial<KinPickerSearchState>) => {
    state = { ...state, ...patch };
    options.onChange(state);
  };
  const query = { orgId: options.orgId, limit: KIN_PICKER_SEARCH_CAP };
  const refsOf = (value: KinPartiesResult | KinProjectsResult) => ({
    refs: ("parties" in value ? value.parties : value.projects).map(kinWorkRefOf),
    more: value.nextCursor !== null,
  });
  const read = async (words: string) => {
    const mine = ++generation;
    const text = words.slice(0, 200);
    const reads: ReadonlyArray<
      Promise<AtomCommandResult<KinPartiesResult | KinProjectsResult, unknown>>
    > =
      options.kind === "clients"
        ? [options.readClients({ ...query, text })]
        : [
            options.readProjects({ ...query, text }),
            ...(options.done ? [options.readProjects({ ...query, text, state: "done" })] : []),
          ];
    const results = await Promise.all(reads);
    if (mine !== generation) return;
    const [open, done] = results.flatMap((result) =>
      AsyncResult.isSuccess(result) ? [refsOf(result.value)] : [],
    );
    // A failed read is kept whole: `kinFailure` reads its cause.
    const failed = results.find((result) => !AsyncResult.isSuccess(result));
    if (failed !== undefined || open === undefined)
      return set({ loading: false, failed: failed ?? "failed" });
    set({
      loading: false,
      failed: null,
      found: { open: open.refs, done: done?.refs ?? [], more: open.more || done?.more === true },
    });
  };
  const abandon = () => {
    generation += 1;
    cancelTyping?.();
    cancelTyping = null;
  };
  return {
    getState: () => state,
    type: (text: string) => {
      const words = text.trim();
      if (words === state.text.trim() && state.failed === null) {
        if (text !== state.text) set({ text });
        return;
      }
      abandon();
      if (words === "") return set(KIN_PICKER_SEARCH_IDLE);
      set({ text, found: null, loading: true, failed: null });
      cancelTyping = options.schedule(() => {
        cancelTyping = null;
        void read(words);
      }, KIN_WORK_TYPING_MS);
    },
    /** Reads what is typed again now, after a failure. */
    retry: () => {
      const words = state.text.trim();
      if (words === "") return Promise.resolve();
      abandon();
      set({ loading: true, failed: null });
      return read(words);
    },
    dispose: abandon,
  };
}

export type KinPickerSearch = ReturnType<typeof createKinPickerSearch>;

/** What a picker searches: whose host, which company, and clients or projects. */
export interface KinPickerSearchTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly kind: "clients" | "projects";
  readonly done: boolean;
}

/**
 * The search a mounted picker holds: the same one while its target stays, a fresh one once the
 * host, company or what it searches changes, so a reused picker never asks the old company.
 */
export function createKinPickerSearchSlot<S>(create: (target: KinPickerSearchTarget) => S) {
  let held: { readonly key: string; readonly search: S } | null = null;
  return (target: KinPickerSearchTarget) => {
    const key = JSON.stringify([target.environmentId, target.orgId, target.kind, target.done]);
    if (held?.key !== key) held = { key, search: create(target) };
    return held.search;
  };
}

/**
 * What a picker lists: the page it holds until something is typed, then the host's answer, with
 * the held page's matches meanwhile. The current value stays listed whenever its name matches.
 */
export function kinPickerSearchView(input: {
  readonly noun: "client" | "project";
  readonly search: KinPickerSearchState;
  readonly loaded: {
    readonly open: ReadonlyArray<KinWorkRef>;
    readonly done: ReadonlyArray<KinWorkRef>;
  };
  readonly held: KinWorkRef | null;
  /** The only keys this viewer may pick, such as a teammate's led projects; null for any. */
  readonly only?: ReadonlySet<string> | null;
}) {
  const { search, held } = input;
  const words = search.text.trim();
  const found =
    words === ""
      ? input.loaded
      : (search.found ?? {
          open: kinWorkRefsMatching(input.loaded.open, words),
          done: kinWorkRefsMatching(input.loaded.done, words),
        });
  const only = input.only ?? null;
  const shown =
    only === null
      ? found
      : {
          open: found.open.filter((ref) => only.has(ref.key)),
          done: found.done.filter((ref) => only.has(ref.key)),
        };
  const listed = (ref: KinWorkRef) =>
    shown.open.some((one) => one.key === ref.key) || shown.done.some((one) => one.key === ref.key);
  const keep =
    held !== null && !listed(held) && kinWorkRefsMatching([held], words).length > 0 ? held : null;
  const open = keep === null ? shown.open : [keep, ...shown.open];
  const settled = words !== "" && search.found !== null && !search.loading;
  return {
    open,
    done: shown.done,
    loading: search.loading,
    /** What to say about a failed search, and whether Try again can help. */
    failure: search.failed === null ? null : kinFailure(search.failed, KIN_PICKER_COPY.failed),
    /** "No client named …" or "Type more to narrow", once the host has answered. */
    note: !settled
      ? null
      : open.length + shown.done.length === 0
        ? KIN_PICKER_COPY.nothing(input.noun, words)
        : search.found?.more === true
          ? KIN_PICKER_COPY.narrow
          : null,
  };
}

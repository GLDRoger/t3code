import type { KinOrgId, KinRecord, KinWorkListInput, KinWorkListResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import {
  KIN_WORK_DEFAULT_FILTER,
  kinWorkListQuery,
  kinWorkSameFilter,
  type KinWorkFilter,
} from "./kinWork.ts";

export const KIN_WORK_PAGE = 50;
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
});

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
}) {
  type State = KinPagedListState<Filter, Row>;
  const append = (held: ReadonlyArray<Row>, page: ReadonlyArray<Row>) => {
    // A row that moved up between two page reads would otherwise show twice.
    const seen = new Set(held.map(options.idOf));
    return [...held, ...page.filter((row) => !seen.has(options.idOf(row)))];
  };
  const sameFilter = options.sameFilter;
  let state: State = emptyState(options.initial);
  // Bumped whenever what is being read stops mattering: a new filter, a manual refresh, the end.
  let generation = 0;
  let running = false;
  let cursor: string | null = null;
  /** The highest change number announced while a read was running. */
  let announced: number | null = null;
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
    announced = null;
    if (seen !== null) changed(seen);
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
        // Rows read for other words can't stand in for these, so only the same filter's stay up.
        if (shownFor !== null && sameFilter(shownFor, state.filter))
          set({ refreshing: false, stale: true });
        else {
          shownFor = null;
          set({
            ...emptyState<Filter, Row>(state.filter),
            loading: false,
            failed: squashAtomCommandFailure(result),
          });
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
    });
    afterRead();
  };

  const reread = () => {
    if (state.seq !== null) set({ refreshing: true });
    else set({ loading: true, failed: null });
    void load(Math.max(state.records.length, KIN_WORK_PAGE));
  };

  /** The host announced change number `seq`. */
  function changed(seq: number) {
    const behind = state.seq === null || seq > state.seq || state.stale;
    if (!behind) return;
    if (running) {
      announced = Math.max(announced ?? 0, seq);
      return;
    }
    // Still typing: the read that follows the pause will be current anyway.
    if (cancelTyping !== null) return;
    reread();
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
      if (running || cursor === null || state.seq === null) return;
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
}) {
  return createKinPagedList<KinWorkFilter, KinRecord>({
    initial: options.initial ?? KIN_WORK_DEFAULT_FILTER,
    sameFilter: kinWorkSameFilter,
    idOf: (record) => record.recordId,
    onChange: options.onChange,
    schedule: options.schedule,
    read: async (filter, page) =>
      mapPage(
        await options.read({
          ...kinWorkListQuery(options.orgId, filter, options.now(), options.hostFilters()),
          ...page,
        }),
        (value) => ({ ...value, rows: value.records }),
      ),
  });
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

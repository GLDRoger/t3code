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
export interface KinWorkListState {
  readonly filter: KinWorkFilter;
  readonly records: ReadonlyArray<KinRecord>;
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

const emptyState = (filter: KinWorkFilter): KinWorkListState => ({
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

export const KIN_WORK_LIST_INITIAL = emptyState(KIN_WORK_DEFAULT_FILTER);

const append = (held: ReadonlyArray<KinRecord>, page: ReadonlyArray<KinRecord>) => {
  // A row that moved up between two page reads would otherwise show twice.
  const seen = new Set(held.map((record) => record.recordId));
  return [...held, ...page.filter((record) => !seen.has(record.recordId))];
};

/**
 * The Work list's reads: one filter at a time, a page at a time, read again when the host's
 * change number passes the one the rows were read at. Only one read runs at once; a change that
 * arrives meanwhile is remembered and costs a single read afterwards, however many arrived.
 */
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
}) {
  let state = KIN_WORK_LIST_INITIAL;
  // Bumped whenever what is being read stops mattering: a new filter, a manual refresh, the end.
  let generation = 0;
  let running = false;
  let cursor: string | null = null;
  /** The highest change number announced while a read was running. */
  let announced: number | null = null;
  /** The filter the rows on screen were read for; null with none. */
  let shownFor: KinWorkFilter | null = null;
  let cancelTyping: (() => void) | null = null;

  const set = (patch: Partial<KinWorkListState>) => {
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
    const query = kinWorkListQuery(
      options.orgId,
      state.filter,
      options.now(),
      options.hostFilters(),
    );
    let records: ReadonlyArray<KinRecord> = [];
    let next: string | null = null;
    let seq: number | null = null;
    let total = 0;
    do {
      const result = await options.read({
        ...query,
        limit: KIN_WORK_PAGE,
        ...(next === null ? {} : { cursor: next }),
      });
      if (mine !== generation) return;
      if (!AsyncResult.isSuccess(result)) {
        // Rows read for other words can't stand in for these, so only the same filter's stay up.
        if (shownFor !== null && kinWorkSameFilter(shownFor, state.filter))
          set({ refreshing: false, stale: true });
        else {
          shownFor = null;
          set({
            ...emptyState(state.filter),
            loading: false,
            failed: squashAtomCommandFailure(result),
          });
        }
        return afterRead();
      }
      records = append(records, result.value.records);
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
    setFilter: (filter: KinWorkFilter) => {
      if (kinWorkSameFilter(filter, state.filter)) {
        // The search box keeps what was typed, spaces included.
        if (filter.text !== state.filter.text) set({ filter });
        return;
      }
      const typing =
        filter.view === state.filter.view &&
        kinWorkSameFilter({ ...filter, text: "" }, { ...state.filter, text: "" });
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
      const result = await options.read({
        ...kinWorkListQuery(options.orgId, state.filter, options.now(), options.hostFilters()),
        limit: KIN_WORK_PAGE,
        cursor,
      });
      if (mine !== generation) return;
      if (AsyncResult.isSuccess(result)) {
        cursor = result.value.nextCursor;
        set({
          records: append(state.records, result.value.records),
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

export type KinWorkList = ReturnType<typeof createKinWorkList>;

import {
  kinPatchWorkPage,
  kinWorkHeldPage,
  type KinOrgId,
  type KinRecord,
  type KinWorkHeldPage,
  type KinWorkListInput,
  type KinWorkListResult,
  type KinWorkRows,
} from "@t3tools/contracts";
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
    if (same) state = { ...state, seq };
    else set({ records: caught.records, total: caught.total, more: caught.more, seq });
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
  const list = createKinPagedList<KinWorkFilter, KinRecord>({
    initial: options.initial ?? KIN_WORK_DEFAULT_FILTER,
    sameFilter: kinWorkSameFilter,
    idOf: (record) => record.recordId,
    onChange: options.onChange,
    schedule: options.schedule,
    read: async (filter, page) => {
      const input = {
        ...kinWorkListQuery(options.orgId, filter, options.now(), options.hostFilters()),
        ...page,
      };
      const result = await follow.read(input, options.read);
      return mapPage(result, (value) => ({ ...value, rows: value.records }));
    },
    catchUp: (state) => follow.catchUp(state.records),
  });
  return {
    ...list,
    /** The host announced `seq`: rows it sent apply in place, and anything else reads again. */
    changed: (seq: number) => list.changed(seq, follow.newEpoch()),
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

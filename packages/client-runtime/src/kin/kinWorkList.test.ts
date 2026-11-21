import {
  EnvironmentId,
  KinChatError,
  kinApplyWorkRow,
  kinCompactRecord,
  kinWorkRowsStart,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  type KinPartiesInput,
  type KinPartiesResult,
  type KinProjectsInput,
  type KinRecord,
  type KinWorkListInput,
  type KinWorkListResult,
  type KinWorkRows,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AtomCommandResult } from "../state/runtime.ts";
import { KIN_WORK_DEFAULT_FILTER } from "./kinWork.ts";
import {
  KIN_PICKER_COPY,
  KIN_PICKER_SEARCH_CAP,
  KIN_WORK_PAGE,
  createKinPickerSearch,
  createKinPickerSearchSlot,
  kinPickerSearchView,
  createKinListEntries,
  createKinListKeeper,
  createKinWorkList,
  type KinWorkList,
  type KinWorkListState,
} from "./kinWorkList.ts";

const isChatError = Schema.is(KinChatError);
const orgId = KinOrgId.make("invented-org");
const owner = { _tag: "person", personId: KinPersonId.make("invented-owner") } as const;
const record = (n: number): KinRecord => ({
  recordId: KinRecordId.make(`rec-${n}`),
  orgId,
  key: `W-${n}`,
  title: `Invented task ${n}`,
  state: "open",
  waitingOn: null,
  owner,
  category: null,
  side: "ours",
  dueAt: null,
  dueAllDay: false,
  late: false,
  confirmed: true,
  sensitive: false,
  working: false,
  pullRequest: null,
  rev: 1,
  createdAt: "2026-11-10T08:00:00.000Z",
  updatedAt: "2026-11-10T08:00:00.000Z",
  closedAt: null,
});
const page = (from: number, count: number, total: number, seq: number): KinWorkListResult => ({
  records: Array.from({ length: count }, (_, index) => record(from + index)),
  total,
  nextCursor: from + count - 1 < total ? `o:${from + count - 1}` : null,
  seq,
  asOf: "2026-11-11T08:00:00.000Z",
});

/** A host whose answers the test releases one at a time, and a clock it winds by hand. */
function harness(rows?: () => KinWorkRows | null) {
  const states: Array<KinWorkListState> = [];
  const asked: Array<KinWorkListInput> = [];
  const waiting: Array<(result: KinWorkListResult | KinChatError | null) => void> = [];
  const timers: Array<() => void> = [];
  const list = createKinWorkList({
    orgId,
    read: (input) => {
      asked.push(input);
      return new Promise((resolve) =>
        waiting.push((result) =>
          resolve(
            result === null || isChatError(result)
              ? AsyncResult.failure(
                  Cause.fail(
                    result ?? new KinChatError({ reason: "unavailable", message: "Down." }),
                  ),
                )
              : AsyncResult.success(result),
          ),
        ),
      );
    },
    onChange: (state) => states.push(state),
    now: () => Date.parse("2026-11-11T08:00:00.000Z"),
    hostFilters: () => true,
    schedule: (run) => {
      timers.push(run);
      return () => timers.splice(timers.indexOf(run), 1);
    },
    ...(rows === undefined ? {} : { rows }),
  });
  const answer = async (result: KinWorkListResult | KinChatError | null) => {
    waiting.shift()?.(result);
    // The controller continues on the promise's microtasks.
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    list,
    asked,
    answer,
    timers,
    state: () => list.getState(),
    pending: () => waiting.length,
  };
}

describe("createKinWorkList", () => {
  it("reads one page, then the next from the host's cursor", async () => {
    const h = harness();
    h.list.start();
    expect(h.state().loading).toBe(true);
    await h.answer(page(1, KIN_WORK_PAGE, 120, 7));
    expect(h.state()).toMatchObject({ loading: false, total: 120, more: true, seq: 7 });
    expect(h.state().records).toHaveLength(KIN_WORK_PAGE);

    void h.list.loadMore();
    expect(h.state().loadingMore).toBe(true);
    expect(h.asked.at(-1)).toMatchObject({ cursor: "o:50", limit: KIN_WORK_PAGE, open: true });
    await h.answer(page(51, KIN_WORK_PAGE, 120, 7));
    expect(h.state().records).toHaveLength(100);
    expect(h.state().more).toBe(true);
  });

  it("reads again only when the host's change number passes the rows'", async () => {
    const h = harness();
    h.list.start();
    await h.answer(page(1, 3, 3, 7));
    h.list.changed(7);
    h.list.changed(6);
    expect(h.pending()).toBe(0);

    h.list.changed(8);
    expect(h.state().refreshing).toBe(true);
    await h.answer(page(1, 4, 4, 8));
    expect(h.state()).toMatchObject({ refreshing: false, seq: 8, total: 4 });
  });

  it("answers a burst of changes during a read with one more read", async () => {
    const h = harness();
    h.list.start();
    h.list.changed(8);
    h.list.changed(9);
    h.list.changed(10);
    expect(h.asked).toHaveLength(1);
    await h.answer(page(1, 3, 3, 8));
    expect(h.asked).toHaveLength(2);
    await h.answer(page(1, 3, 3, 10));
    expect(h.pending()).toBe(0);
    expect(h.state().seq).toBe(10);
  });

  it("covers every row already shown when it reads again", async () => {
    const h = harness();
    h.list.start();
    await h.answer(page(1, KIN_WORK_PAGE, 120, 7));
    void h.list.loadMore();
    await h.answer(page(51, KIN_WORK_PAGE, 120, 7));

    h.list.changed(8);
    await h.answer(page(1, KIN_WORK_PAGE, 121, 8));
    // Half the shown rows have been read again; the old ones stay up until the rest arrive.
    expect(h.state().seq).toBe(7);
    await h.answer(page(51, KIN_WORK_PAGE, 121, 8));
    expect(h.state().records).toHaveLength(100);
    expect(h.state()).toMatchObject({ seq: 8, total: 121, more: true, refreshing: false });
  });

  it("drops an answer for a filter the owner has left", async () => {
    const h = harness();
    h.list.start();
    h.list.setFilter({ ...KIN_WORK_DEFAULT_FILTER, view: "late" });
    expect(h.asked.at(-1)).toMatchObject({ late: true });
    await h.answer(page(1, 5, 5, 7));
    expect(h.state().loading).toBe(true);
    await h.answer(page(9, 1, 1, 7));
    expect(h.state().records.map((held) => held.key)).toEqual(["W-9"]);
  });

  it("waits for a pause in typing, keeping the rows up meanwhile", async () => {
    const h = harness();
    h.list.start();
    await h.answer(page(1, 3, 3, 7));
    h.list.setFilter({ ...KIN_WORK_DEFAULT_FILTER, text: "q" });
    h.list.setFilter({ ...KIN_WORK_DEFAULT_FILTER, text: "quote" });
    expect(h.asked).toHaveLength(1);
    expect(h.timers).toHaveLength(1);
    expect(h.state().records).toHaveLength(3);

    h.timers.shift()?.();
    expect(h.asked.at(-1)).toMatchObject({ text: "quote" });
    await h.answer(page(2, 1, 1, 7));
    expect(h.state().records.map((held) => held.key)).toEqual(["W-2"]);
  });

  it("keeps the rows up when reading again fails, and tries on the next change", async () => {
    const h = harness();
    h.list.start();
    await h.answer(page(1, 3, 3, 7));
    h.list.changed(8);
    await h.answer(null);
    expect(h.state()).toMatchObject({ stale: true, failed: null, refreshing: false });
    expect(h.state().records).toHaveLength(3);

    // Reconnecting announces the same number again; stale rows are read anyway.
    h.list.changed(8);
    await h.answer(page(1, 4, 4, 8));
    expect(h.state()).toMatchObject({ stale: false, seq: 8 });

    // Connected but nothing new announced: pull to refresh is the way back.
    h.list.changed(9);
    await h.answer(null);
    expect(h.state().stale).toBe(true);
    h.list.refresh();
    expect(h.state()).toMatchObject({ stale: true, refreshing: true });
    await h.answer(page(1, 5, 5, 9));
    expect(h.state()).toMatchObject({ stale: false, refreshing: false, seq: 9 });
    expect(h.state().records).toHaveLength(5);

    // A refusal is no passing failure: the rows were someone else's to show, so they go.
    for (const [seq, reason] of [
      [10, "not_allowed"],
      [11, "not_found"],
    ] as const) {
      h.list.changed(seq);
      const refused = new KinChatError({ reason, message: "Not yours." });
      await h.answer(refused);
      expect(h.state()).toMatchObject({ records: [], stale: false, failed: refused });
      h.list.refresh();
      await h.answer(page(1, 5, 5, seq));
    }
  });

  it("says so when the first read fails, and retries on demand or when the host is heard again", async () => {
    const h = harness();
    h.list.start();
    await h.answer(null);
    expect(h.state().loading).toBe(false);
    expect(h.state().failed).toBeInstanceOf(KinChatError);

    // Reconnecting announces a number the list never got to read at.
    h.list.changed(7);
    expect(h.pending()).toBe(1);
    await h.answer(null);
    expect(h.state().failed).toBeInstanceOf(KinChatError);

    h.list.refresh();
    expect(h.state()).toMatchObject({ loading: true, failed: null });
    await h.answer(page(1, 2, 2, 7));
    expect(h.state().records).toHaveLength(2);
  });

  it("applies the tasks the stream sent in place, and reads again when the stream starts over", async () => {
    let rows = kinWorkRowsStart(7);
    const h = harness(() => rows);
    h.list.start();
    await h.answer(page(1, 3, 3, 7));
    await Promise.resolve();

    const added = { ...record(9), createdAt: "2026-11-11T09:00:00.000Z" };
    rows = kinApplyWorkRow(
      rows,
      { _tag: "upsert", seq: 8, list: "work", record: kinCompactRecord(added), fresh: true },
      orgId,
    );
    h.list.changed(8);
    rows = kinApplyWorkRow(rows, { _tag: "removed", seq: 9, key: "W-2", list: "work" }, orgId);
    h.list.changed(9);
    expect(h.asked).toHaveLength(1);
    expect(h.state().records.map((held) => held.key)).toEqual(["W-1", "W-3", "W-9"]);
    expect(h.state()).toMatchObject({ total: 3, seq: 9, more: false });

    // The host couldn't say what changed: the same number still reads everything again.
    rows = kinWorkRowsStart(9, 1);
    h.list.changed(9);
    expect(h.asked).toHaveLength(2);
  });

  it("comes back to a kept list without reading, catching up from what the stream sent", async () => {
    let rows = kinWorkRowsStart(7);
    let clock = 0;
    const keeper = createKinListKeeper<KinWorkList, KinWorkListState>(() => clock);
    const h = harness(() => rows);
    const first = keeper.take("tasks", () => h.list);
    expect(keeper.wasKept(first)).toBe(false);
    keeper.show(first, () => {});
    h.list.start();
    await h.answer(page(1, 3, 3, 7));
    keeper.hide(first);

    // Away, a task arrives on the stream; back, it shows with no read of the page.
    rows = kinApplyWorkRow(
      rows,
      { _tag: "upsert", seq: 8, list: "work", record: kinCompactRecord(record(4)), fresh: true },
      orgId,
    );
    const again = keeper.take("tasks", () => harness().list);
    expect(again).toBe(first);
    expect(keeper.wasKept(again)).toBe(true);
    keeper.show(again, () => {});
    again.list.resume();
    again.list.changed(8);
    expect(h.asked).toHaveLength(1);
    expect(h.state().records.map((held) => held.key)).toEqual(["W-1", "W-2", "W-3", "W-4"]);

    // Shown elsewhere, or left too long, it isn't handed out again.
    expect(keeper.take("tasks", () => harness().list)).not.toBe(first);
    keeper.hide(again);
    clock += 10 * 60_000;
    expect(keeper.take("tasks", () => harness().list)).not.toBe(first);
  });
});

describe("createKinListEntries", () => {
  it("holds a quotes page through a task or invoice changing, and reads again for a quote", async () => {
    let rows = kinWorkRowsStart(7);
    const asked: Array<KinWorkListInput> = [];
    const quote = (n: number): KinRecord => ({ ...record(n), key: `QT-${n}` });
    const entries = createKinListEntries({
      initial: { text: "" },
      sameFilter: (a, b) => a.text === b.text,
      query: () => ({ orgId, list: "quotes", open: true }),
      read: (input) => {
        asked.push(input);
        return Promise.resolve(
          AsyncResult.success({ ...page(1, 2, 2, 7), records: [quote(1), quote(2)] }),
        );
      },
      onChange: () => {},
      schedule: () => () => {},
      rows: () => rows,
    });
    entries.start();
    await vi.waitFor(() => expect(entries.getState().seq).toBe(7));
    expect(asked).toHaveLength(1);

    rows = kinApplyWorkRow(
      rows,
      { _tag: "upsert", seq: 8, list: "work", record: kinCompactRecord(record(9)), fresh: true },
      orgId,
    );
    entries.changed(8);
    rows = kinApplyWorkRow(
      rows,
      {
        _tag: "upsert",
        seq: 9,
        list: "invoices",
        record: kinCompactRecord({ ...record(3), key: "INV-3" }),
      },
      orgId,
    );
    entries.changed(9);
    expect(asked).toHaveLength(1);
    expect(entries.getState()).toMatchObject({ seq: 9, total: 2 });

    rows = kinApplyWorkRow(
      rows,
      { _tag: "upsert", seq: 10, list: "quotes", record: kinCompactRecord(quote(1)) },
      orgId,
    );
    entries.changed(10);
    expect(asked).toHaveLength(2);
  });
});

describe("createKinPickerSearch", () => {
  // Only names and keys reach a picker; the rest of a row is the host's.
  const named = (names: ReadonlyArray<string>, more = false) =>
    AsyncResult.success({
      parties: names.map((name, index) => ({ key: KinRecordKey.make(`C-${index + 101}`), name })),
      total: names.length,
      nextCursor: more ? `o:${names.length}` : null,
      seq: 1,
      asOf: "2026-11-11T08:00:00.000Z",
    } as unknown as KinPartiesResult);
  function harness(
    answer: (input: KinPartiesInput) => AtomCommandResult<KinPartiesResult, unknown>,
  ) {
    const asked: Array<KinPartiesInput> = [];
    const timers: Array<() => void> = [];
    const settled: Array<() => void> = [];
    const search = createKinPickerSearch({
      orgId,
      kind: "clients",
      done: false,
      readClients: async (input) => {
        asked.push(input);
        return answer(input);
      },
      readProjects: (_input: KinProjectsInput) => {
        throw new Error("A client picker never reads projects.");
      },
      onChange: (state) => {
        if (!state.loading) settled.splice(0).forEach((resolve) => resolve());
      },
      schedule: (run) => {
        timers.push(run);
        return () => timers.splice(timers.indexOf(run), 1);
      },
    });
    // The host's answer has landed once the search stops loading.
    const pause = () => {
      const answered = new Promise<void>((resolve) => settled.push(resolve));
      timers.shift()?.();
      return answered;
    };
    return { search, asked, timers, pause };
  }
  const loaded = {
    open: [{ key: KinRecordKey.make("C-1"), title: "Invented Orbit Dental" }],
    done: [],
  };
  const view = (
    state: ReturnType<typeof harness>["search"],
    held: { key: KinRecordKey; title: string } | null,
  ) => kinPickerSearchView({ noun: "client", search: state.getState(), loaded, held });

  it("asks the host once typing pauses, with the words, and never with nothing typed", async () => {
    const h = harness(() => named(["Invented Kestrel Freight"]));
    expect(view(h.search, null).open).toEqual(loaded.open);
    h.search.type("k");
    h.search.type("ke");
    h.search.type("kestrel ");
    expect(h.asked).toEqual([]);
    expect(h.timers).toHaveLength(1);
    expect(h.search.getState().loading).toBe(true);
    await h.pause();
    expect(h.asked).toEqual([{ orgId, limit: KIN_PICKER_SEARCH_CAP, text: "kestrel" }]);
    expect(view(h.search, null)).toMatchObject({
      open: [{ key: "C-101", title: "Invented Kestrel Freight" }],
      loading: false,
      note: null,
    });
    h.search.type("");
    expect(h.timers).toHaveLength(0);
    expect(view(h.search, null).open).toEqual(loaded.open);
  });

  it("keeps the current value listed while its name matches, and says when nothing does", async () => {
    const held = { key: KinRecordKey.make("C-140"), title: "Invented Zephyr Kitchens" };
    const h = harness((input) =>
      named(input.text === "zephyr" ? [] : ["Invented Kestrel Freight"]),
    );
    expect(view(h.search, held).open.map((ref) => ref.key)).toEqual(["C-140", "C-1"]);
    h.search.type("zephyr");
    await h.pause();
    expect(view(h.search, held)).toMatchObject({ open: [held], note: null });
    h.search.type("nobody");
    await h.pause();
    expect(view(h.search, held)).toMatchObject({ open: [{ key: "C-101" }] });
    const empty = harness(() => named([]));
    empty.search.type("Nobody ");
    await empty.pause();
    expect(view(empty.search, held)).toMatchObject({
      open: [],
      note: KIN_PICKER_COPY.nothing("client", "Nobody"),
    });
    expect(KIN_PICKER_COPY.nothing("client", "Nobody")).toBe("No client named “Nobody”");
  });

  it("lists only what this viewer may pick, from the page held and the host's answer alike", async () => {
    const h = harness(() => named(["Invented Kestrel Freight", "Invented Kestrel Dental"]));
    const only = new Set(["C-102"]);
    const pick = () =>
      kinPickerSearchView({
        noun: "client",
        search: h.search.getState(),
        loaded,
        held: null,
        only,
      });
    expect(pick().open).toEqual([]);
    h.search.type("kestrel");
    await h.pause();
    expect(pick().open.map((ref) => ref.key)).toEqual(["C-102"]);
  });

  it("asks for more letters at the cap, and tries again after a failure", async () => {
    let fail = true;
    const h = harness(() =>
      fail
        ? AsyncResult.failure(
            Cause.fail(new KinChatError({ reason: "unavailable", message: "Down." })),
          )
        : named(
            Array.from({ length: KIN_PICKER_SEARCH_CAP }, (_, index) => `Invented ${index}`),
            true,
          ),
    );
    h.search.type("invented");
    await h.pause();
    expect(view(h.search, null)).toMatchObject({
      failure: { kind: "busy", retry: true },
      loading: false,
      note: null,
    });
    fail = false;
    await h.search.retry();
    expect(h.asked).toHaveLength(2);
    expect(view(h.search, null).note).toBe(KIN_PICKER_COPY.narrow);
  });

  it("follows its target: a picker reused for another host or company asks that one", async () => {
    const asked: Array<readonly [string, KinPartiesInput]> = [];
    const timers: Array<() => void> = [];
    const slot = createKinPickerSearchSlot((target) =>
      createKinPickerSearch({
        ...target,
        readClients: async (input) => {
          asked.push([target.environmentId, input]);
          return named(["Invented Kestrel Freight"]);
        },
        readProjects: () => {
          throw new Error("A client picker never reads projects.");
        },
        onChange: () => {},
        schedule: (run) => {
          timers.push(run);
          return () => timers.splice(timers.indexOf(run), 1);
        },
      }),
    );
    const other = KinOrgId.make("invented-other-org");
    const at = (environment: string, org: KinOrgId) =>
      slot({
        environmentId: EnvironmentId.make(environment),
        orgId: org,
        kind: "clients",
        done: false,
      });
    const first = at("env-a", orgId);
    expect(at("env-a", orgId)).toBe(first);
    const moved = at("env-a", other);
    expect(moved).not.toBe(first);
    expect(moved.getState().text).toBe("");
    moved.type("kestrel");
    timers.shift()?.();
    at("env-b", other).type("kestrel");
    timers.shift()?.();
    expect(asked.map(([environmentId, input]) => [environmentId, input.orgId])).toEqual([
      ["env-a", other],
      ["env-b", other],
    ]);
  });
});

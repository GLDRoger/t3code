import {
  KinChatError,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinRecord,
  type KinWorkListInput,
  type KinWorkListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { KIN_WORK_DEFAULT_FILTER } from "./kinWork.ts";
import { KIN_WORK_PAGE, createKinWorkList, type KinWorkListState } from "./kinWorkList.ts";

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
function harness() {
  const states: Array<KinWorkListState> = [];
  const asked: Array<KinWorkListInput> = [];
  const waiting: Array<(result: KinWorkListResult | null) => void> = [];
  const timers: Array<() => void> = [];
  const list = createKinWorkList({
    orgId,
    read: (input) => {
      asked.push(input);
      return new Promise((resolve) =>
        waiting.push((result) =>
          resolve(
            result === null
              ? AsyncResult.failure(
                  Cause.fail(new KinChatError({ reason: "unavailable", message: "Down." })),
                )
              : AsyncResult.success(result),
          ),
        ),
      );
    },
    onChange: (state) => states.push(state),
    now: () => Date.parse("2026-11-11T08:00:00.000Z"),
    schedule: (run) => {
      timers.push(run);
      return () => timers.splice(timers.indexOf(run), 1);
    },
  });
  const answer = async (result: KinWorkListResult | null) => {
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
});

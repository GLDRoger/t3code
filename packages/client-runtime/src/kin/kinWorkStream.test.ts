import {
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinRecordCompact,
  type KinRecordKey,
  type KinWorkEvent,
  type KinWorkSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  KIN_WORK_DEAL_LISTS,
  KIN_WORK_NOTHING_NAMED,
  KIN_WORK_READ_TIMEOUT,
  KIN_WORK_RETRY,
  KIN_WORK_NOT_TASKS,
  kinWorkListsMoved,
  kinWorkLiveFold,
  kinWorkNote,
  type KinWorkLive,
  type KinWorkResume,
} from "./kinWorkStream.ts";

const summary = (seq: number, open: number) =>
  ({
    open,
    doing: 0,
    waiting: 0,
    late: 0,
    owners: [],
    seq,
    asOf: "2026-11-12T05:00:00.000Z",
  }) as unknown as KinWorkSummary;

// Exactly what `kin.work.subscribe` sends, so the fold sees the real tag.
type Event = KinWorkEvent | typeof KIN_WORK_RETRY;

const changed = (seq: number, key?: string): KinWorkEvent =>
  key === undefined ? { _tag: "changed", seq } : { _tag: "changed", seq, key: key as KinRecordKey };

/** Changes the test sends, reads it answers one by one, and what the stream emits. */
const harness = (
  reads: Array<Effect.Effect<KinWorkSummary, string>>,
  rowsOf?: { readonly orgId: KinOrgId; readonly resume: KinWorkResume },
) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<Event>();
    const out = yield* Queue.unbounded<KinWorkLive>();
    yield* kinWorkLiveFold(
      Stream.fromQueue(events),
      () => reads.shift() ?? Effect.never,
      rowsOf,
    ).pipe(
      Stream.runForEach((live) => Queue.offer(out, live)),
      Effect.forkScoped,
    );
    return {
      send: (event: Event) => Queue.offer(events, event),
      next: Queue.take(out),
    };
  });

describe("kinWorkLiveFold", () => {
  it.effect("gives up on a read its connection dropped, and reads again on the next session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness([
          Effect.succeed(summary(7, 12)),
          Effect.never,
          Effect.succeed(summary(9, 413)),
        ]);
        yield* h.send(changed(7));
        expect(yield* h.next).toMatchObject({ seq: 7, failed: false, summary: { open: 12 } });

        // A burst of tasks arrives; the socket drops while its read is in flight.
        yield* h.send(changed(9, "W-9"));
        yield* TestClock.adjust(250);
        yield* TestClock.adjust(KIN_WORK_READ_TIMEOUT);
        expect(yield* h.next).toMatchObject({ seq: 9, failed: true, summary: { open: 12 } });

        // The next session announces the same number; failed counts are read again anyway.
        yield* h.send(changed(9));
        yield* TestClock.adjust(250);
        expect(yield* h.next).toMatchObject({ seq: 9, failed: false, summary: { open: 413 } });
      }),
    ),
  );

  it.effect("keeps going when the socket drop interrupts a read in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness([
          Effect.succeed(summary(7, 12)),
          Effect.failCause(Cause.interrupt()),
          Effect.succeed(summary(9, 413)),
        ]);
        yield* h.send(changed(7));
        yield* h.next;
        yield* h.send(changed(9, "W-9"));
        yield* TestClock.adjust(250);
        expect(yield* h.next).toMatchObject({ seq: 9, failed: true, summary: { open: 12 } });

        // The next session announces the same number; failed counts are read again anyway.
        yield* h.send(changed(9));
        yield* TestClock.adjust(250);
        expect(yield* h.next).toMatchObject({ seq: 9, failed: false, summary: { open: 413 } });
      }),
    ),
  );

  it.effect("retries in place, keeping the counts and which tasks changed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness([
          Effect.succeed(summary(4, 12)),
          Effect.fail("unavailable"),
          Effect.fail("unavailable"),
          Effect.succeed(summary(5, 13)),
        ]);
        yield* h.send(changed(4));
        yield* h.next;
        yield* h.send(changed(5, "W-5"));
        yield* TestClock.adjust(250);
        expect(yield* h.next).toMatchObject({ failed: true, summary: { open: 12 } });

        // A retry that fails too keeps what is held rather than dropping to nothing.
        yield* h.send(KIN_WORK_RETRY);
        expect(yield* h.next).toMatchObject({
          failed: true,
          summary: { open: 12 },
          changed: { "W-5": 5 },
        });
        yield* h.send(KIN_WORK_RETRY);
        expect(yield* h.next).toMatchObject({
          seq: 5,
          failed: false,
          summary: { open: 13 },
          changed: { "W-5": 5 },
        });
      }),
    ),
  );
});

describe("kinWorkLiveFold, from a host that sends rows", () => {
  const orgId = KinOrgId.make("invented-org");
  const task = (key: string): KinRecordCompact => ({
    recordId: KinRecordId.make(`rec-${key}`),
    key,
    title: `Invented ${key}`,
    state: "open",
    owner: { _tag: "person", personId: KinPersonId.make("invented-owner") },
    side: "ours",
    rev: 1,
    createdAt: "2026-11-12T05:00:00.000Z",
    updatedAt: "2026-11-12T05:00:00.000Z",
  });
  const whole = (seq: number, open: number, team?: true): KinWorkEvent => ({
    _tag: "counts",
    seq,
    ...(team ? { team } : {}),
    asOf: "2026-11-12T05:00:00.000Z",
    open,
    doing: 0,
    waiting: 0,
    late: 0,
    dueThisWeek: 0,
    whole: true,
    owners: [],
  });

  it.effect("applies tasks and moved counts without a read, and resumes from the last counts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const resume: KinWorkResume = { at: null };
        const h = yield* harness([], { orgId, resume });
        yield* h.send(whole(7, 12));
        expect(yield* h.next).toMatchObject({ seq: 7, summary: { open: 12, seq: 7 } });

        yield* h.send({ _tag: "upsert", seq: 8, list: "work", record: task("W-8"), fresh: true });
        yield* h.send({
          _tag: "counts",
          seq: 8,
          asOf: "2026-11-12T05:00:01.000Z",
          open: 13,
          doing: 0,
          waiting: 0,
          late: 0,
          dueThisWeek: 0,
        });
        const live = yield* h.next;
        expect(live).toMatchObject({ seq: 8, summary: { open: 13 }, lists: { work: 8 } });
        expect(live.rows?.entries.get("W-8")).toMatchObject({ seq: 8, freshAt: 8 });
        expect(resume.at).toEqual({ seq: 8, team: false });

        // Nothing changed while away: the stream says so and nothing is read.
        yield* h.send({ _tag: "synchronized", seq: 8 });
        yield* h.send({ _tag: "removed", seq: 9, key: "W-8", list: "work" });
        yield* h.send({ _tag: "synchronized", seq: 9 });
        expect((yield* h.next).rows?.entries.get("W-8")).toMatchObject({ record: null });
      }),
    ),
  );

  it.effect("starts over at a new epoch when the host can't say what changed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const resume: KinWorkResume = { at: null };
        const h = yield* harness([], { orgId, resume });
        yield* h.send(whole(7, 12));
        const before = (yield* h.next).rows!.epoch;
        yield* h.send({ _tag: "snapshot-required", seq: 3, team: true });
        yield* h.send(whole(3, 2, true));
        const live = yield* h.next;
        // Every read covering any list moves, so each screen reads its own view again.
        expect(live).toMatchObject({ seq: 3, unnamed: 3, summary: { open: 2 } });
        expect(live.rows).toMatchObject({ epoch: before + 1, floor: 3 });
        expect(resume.at).toEqual({ seq: 3, team: true });
      }),
    ),
  );

  it.effect("reads the counts when moved ones arrive with none held", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness([Effect.succeed(summary(5, 40))], { orgId, resume: { at: null } });
        yield* h.send({
          _tag: "counts",
          seq: 5,
          asOf: "2026-11-12T05:00:00.000Z",
          open: 40,
          doing: 0,
          waiting: 0,
          late: 0,
          dueThisWeek: 0,
        });
        expect(yield* h.next).toMatchObject({ seq: 5, summary: { open: 40 }, failed: false });
      }),
    ),
  );
});

describe("kinWorkListsMoved", () => {
  it("moves a read only for a change to a list it covers, or one that names no list", () => {
    const heard = (events: ReadonlyArray<Parameters<typeof kinWorkNote>[1]>) =>
      events.reduce(kinWorkNote, KIN_WORK_NOTHING_NAMED);
    const moved = (named: ReturnType<typeof heard>) => ({
      tasks: kinWorkListsMoved(named, ["work"]),
      money: kinWorkListsMoved(named, ["invoices", "expenses"]),
      clients: kinWorkListsMoved(named, ["clients", "projects"]),
      any: kinWorkListsMoved(named, "any"),
      notTasks: kinWorkListsMoved(named, KIN_WORK_NOT_TASKS),
      deals: kinWorkListsMoved(named, KIN_WORK_DEAL_LISTS),
    });
    // Where things stood when the stream began is not a change.
    expect(moved(heard([{ seq: 4 }]))).toEqual({
      tasks: 0,
      money: 0,
      clients: 0,
      any: 0,
      notTasks: 0,
      deals: 0,
    });
    const task = heard([{ seq: 4 }, { seq: 5, key: "W-5", list: "work" }]);
    expect(moved(task)).toEqual({
      tasks: 5,
      money: 0,
      clients: 0,
      any: 5,
      notTasks: 0,
      deals: 5,
    });
    const invoice = heard([
      { seq: 4 },
      { seq: 5, key: "W-5", list: "work" },
      { seq: 6, key: "INV-1", list: "invoices" },
    ]);
    expect(moved(invoice)).toEqual({
      tasks: 5,
      money: 6,
      clients: 0,
      any: 6,
      notTasks: 6,
      deals: 5,
    });
    // A quote made, accepted or dropped moves a deal of its client: the deal shows it.
    expect(moved(kinWorkNote(invoice, { seq: 7, key: "QT-3", list: "quotes" })).deals).toBe(7);
    // An older host names no list, and a change while away names nothing: every read moves.
    expect(moved(kinWorkNote(invoice, { seq: 7, key: "W-7" }))).toEqual({
      tasks: 7,
      money: 7,
      clients: 7,
      any: 7,
      notTasks: 7,
      deals: 7,
    });
    expect(moved(kinWorkNote(invoice, { seq: 8 }))).toEqual({
      tasks: 8,
      money: 8,
      clients: 8,
      any: 8,
      notTasks: 8,
      deals: 8,
    });
  });
});

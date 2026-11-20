// @effect-diagnostics globalDate:off anyUnknownInErrorContext:off -- fixed invented dates; each read fails in its own way and a failure is recorded as a refusal.
import { expect, layer as withLayer } from "@effect/vitest";
import {
  KIN_REFRESH_TOPICS,
  KinMoneyAnswerRpcs,
  KIN_MONEY_PARTS,
  type KinMoneyPart,
  type KinPersonId,
  KinFinanceRpcs,
  KinPulseRpcs,
  type KinPulseEvent,
  type KinPulseScreenRead,
  kinPulseApply,
  type KinWorkEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { PersonIdentity } from "./chat/KinIdentity.ts";
import * as RefreshHub from "./chat/KinRefreshHub.ts";
import { subscribeRefreshes } from "./chat/refreshes.ts";
import * as KinPulse from "./pulse/KinPulse.ts";
import * as Pulse from "./pulse/people.ts";
import budget from "./kinWireBudget.json" with { type: "json" };
import * as Docs from "./work/docs.ts";
import * as Goals from "./work/goals.ts";
import * as KinRecords from "./work/KinRecords.ts";
import * as OwnerDocs from "./work/ownerDocs.ts";
import { demandOfTick, makeMoneyStream } from "./work/moneyStream.ts";
import * as Money from "./work/ownerMoney.ts";
import * as MoneyAnswers from "./work/ownerMoneyAnswers.ts";
import * as Work from "./work/ownerWork.ts";
import * as WorkStream from "./work/workStream.ts";
import {
  as,
  BASE_SIZE,
  coOwnerId,
  day,
  layer,
  memberId,
  NOW,
  orgId,
  ownerId,
  ownerWriter,
  READS,
  rowsOf,
  SCHEMAS,
  type Services,
  seed,
  successOf,
  UNPAGED_CEILING,
  VIEWERS,
  wireBytes,
} from "./wireBudget.testkit.ts";

// What Kin's hot reads send each kind of person on an invented company; kinWireBudget.json must
// equal the measurement, so growth shows as that file's diff in the PR. At a real company's size,
// with a time ceiling per read, it runs nightly, and by hand from the repo root:
//   KIN_WIRE_ENTRIES=20000 node apps/server/scripts/kin-wire-scaled.ts

/**
 * Every viewer's `kin.work.subscribe` items for one create and one assignment, up to the
 * announcement that closes the window, and the bytes each named change makes their screen read
 * again (the task page, their due-today list and the counts, as `kinWorkRefreshOn(["work"])`).
 */
const oneChange = Effect.fn("KinWireBudget.oneChange")(function* (
  rereadBytes: ReadonlyMap<string, number>,
) {
  const records = yield* KinRecords.KinRecords;
  const listening = yield* Effect.forEach(VIEWERS, ([name, personId]) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      let count = 0;
      const fiber = yield* Work.subscribe(as(personId), { orgId }).pipe(
        Stream.tap(() => (count++ === 0 ? Deferred.succeed(ready, undefined) : Effect.void)),
        // The first item is where things stand; the next one without a key closes the window.
        Stream.takeUntil((item) => count > 1 && item.key === undefined),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      return { name, fiber };
    }),
  );
  const made = yield* Work.create(as(coOwnerId), {
    orgId,
    clientRequestId: "wire-budget-one-task",
    title: "Invented: check the logo files",
  });
  yield* Work.assign(as(ownerId), {
    orgId,
    key: made.key,
    to: { _tag: "person", personId: memberId },
  });
  yield* records.announce(orgId);
  const measured: Record<string, number> = {};
  for (const { name, fiber } of listening) {
    const items = [...(yield* Fiber.join(fiber))].slice(1, -1);
    measured[`change.${name}.items`] = items.length;
    measured[`change.${name}.bytes`] = items.reduce(
      (sum, item) => sum + wireBytes(SCHEMAS.subscribe, item),
      0,
    );
    measured[`change.${name}.rereadBytes`] =
      items.filter((item) => item.list === undefined || item.list === "work").length *
      (rereadBytes.get(name) ?? 0);
  }
  return measured;
});

/**
 * The same two changes on the row stream (`acceptRows`): what each viewer's session sends for the
 * task made and then given away, and what a reconnect with nothing changed costs. Ticks are fed to
 * each session one change at a time, as the live stream's window would.
 */
const rowsChange = Effect.fn("KinWireBudget.rowsChange")(function* () {
  const records = yield* KinRecords.KinRecords;
  const pull = yield* Stream.toPull(records.changes(orgId));
  const opening = (yield* pull)[0]!.seq;
  const measured: Record<string, number> = {};
  const bytesOf = (items: ReadonlyArray<KinWorkEvent>) =>
    items.reduce((sum, item) => sum + wireBytes(SCHEMAS.subscribe, item), 0);
  const sessions = yield* Effect.forEach(VIEWERS, ([name, personId]) =>
    Effect.gen(function* () {
      const session = yield* WorkStream.makeWorkStream(as(personId), { orgId, acceptRows: true });
      const start = yield* session.start(opening);
      measured[`rows.${name}.open.bytes`] = bytesOf(start);
      return { name, personId, session };
    }),
  );
  const cursors = new Map<string, { seq: number; team: boolean }>();
  const feed = Effect.fn("KinWireBudget.feed")(function* (change: string, key: string) {
    const ticks: Array<KinRecords.Tick> = [];
    while (!ticks.some((tick) => tick.key === key)) ticks.push(...(yield* pull));
    for (const { name, session } of sessions) {
      const items = yield* session.batch(ticks.flatMap((tick) => session.pendingOf(tick)));
      measured[`rows.${name}.${change}.items`] = items.length;
      measured[`rows.${name}.${change}.bytes`] = bytesOf(items);
      const last = items.at(-1);
      if (last?._tag === "counts" || last?._tag === "synchronized")
        cursors.set(name, { seq: last.seq, team: last.team === true });
    }
  });
  const made = yield* Work.create(as(coOwnerId), {
    orgId,
    clientRequestId: "wire-budget-row-task",
    title: "Invented: send the venue the floor plan",
  });
  yield* feed("create", made.key);
  yield* Work.assign(as(ownerId), {
    orgId,
    key: made.key,
    to: { _tag: "person", personId: memberId },
  });
  yield* feed("assign", made.key);
  for (const { name, personId } of sessions) {
    const at = cursors.get(name)!;
    const session = yield* WorkStream.makeWorkStream(as(personId), {
      orgId,
      acceptRows: true,
      afterSeq: at.seq,
      ...(at.team ? { afterTeam: true } : {}),
    });
    measured[`rows.${name}.resume.bytes`] = bytesOf(
      yield* session.start(yield* records.seq(orgId)),
    );
  }
  return measured;
});

/**
 * One doc rewritten: what each viewer's docs feed sends for it. With rows the Docs list patches
 * from the change itself; without, it reads its page again (`docsPage`).
 */
const docChange = Effect.fn("KinWireBudget.docChange")(function* () {
  const records = yield* KinRecords.KinRecords;
  const sql = yield* SqlClient.SqlClient;
  const pull = yield* Stream.toPull(records.changes(orgId));
  yield* pull;
  const measured: Record<string, number> = {};
  const sessions = yield* Effect.forEach(VIEWERS, ([name, personId]) =>
    Effect.map(OwnerDocs.makeDocsStream(as(personId), { orgId, acceptRows: true }), (session) => ({
      name,
      session,
    })),
  );
  const [doc] = yield* sql<{ key: string }>`SELECT key FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'docs' AND json_extract(fields_json, '$.home') = 'company'
    ORDER BY key LIMIT 1`;
  yield* Docs.replaceBody(
    orgId,
    ownerWriter,
    {},
    { key: doc!.key },
    {
      body: "# Invented doc 1\n\nWhat was agreed, now with the venue's new date.\n",
      summary: "Rewritten",
      originKey: "wire-budget:doc:rewrite",
    },
  );
  const ticks: Array<KinRecords.Tick> = [];
  while (!ticks.some((tick) => tick.key === doc!.key)) ticks.push(...(yield* pull));
  for (const { name, session } of sessions) {
    const events = yield* session.burst(ticks);
    measured[`docs.${name}.rewrite.bytes`] = events.reduce(
      (sum, event) => sum + wireBytes(SCHEMAS.docsEvent, event),
      0,
    );
    measured[`docs.${name}.rewrite.reads`] = events.some(
      (event) => event.key !== undefined && event.row === undefined && event.unlisted !== true,
    )
      ? 1
      : 0;
  }
  return measured;
});

/**
 * A reconnect with nothing changed: each viewer's refresh revisions heard again. A topic that
 * reads differently is one their screens read again; the bytes are what resubscribing costs.
 */
const reconnect = Effect.fn("KinWireBudget.reconnect")(function* () {
  const measured: Record<string, number> = {};
  const heard = (personId: KinPersonId) =>
    Stream.runHead(subscribeRefreshes(as(personId), { orgId })).pipe(Effect.map(Option.getOrThrow));
  for (const [name, personId] of VIEWERS) {
    const before = yield* heard(personId);
    const again = yield* heard(personId);
    measured[`reconnect.${name}.topicsMoved`] =
      KIN_REFRESH_TOPICS.filter((topic) => before[topic] !== again[topic]).length +
      (before.boot === again.boot ? 0 : 1);
    measured[`reconnect.${name}.refreshBytes`] = wireBytes(SCHEMAS.refreshes, again);
  }
  return measured;
});

/**
 * One fact in Needs attention moves (a task due soon is done): what each viewer's home is sent
 * for it over `kin.pulse.subscribe`, and that the page folded from it is a fresh read's.
 */
const attentionMove = Effect.fn("KinWireBudget.attentionMove")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const measured: Record<string, number> = {};
  yield* KinPulse.tick(orgId, NOW);
  const page = { orgId, includeHandled: true, limit: 8 } as const;
  const about = (people: ReadonlyArray<PersonIdentity>) =>
    Pulse.read(people, page).pipe(
      Effect.map((read) => ("outline" in read ? (read.outline?.records ?? []) : [])),
    );
  // A task the member holds that needs attention, so every viewer's page moves.
  const named = new Set(yield* about(as(memberId)));
  const tasks = yield* sql<{ key: string; rev: number }>`SELECT key, rev FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'work' AND state = 'open'
      AND owner_id = ${memberId} ORDER BY key`;
  const soon = tasks.find((task) => named.has(task.key));
  if (soon === undefined)
    return yield* Effect.die(new Error("No task of the member's needs attention."));
  expect(yield* about(as(ownerId))).toContain(soon.key);
  const watching = yield* Effect.forEach(VIEWERS, ([name, personId]) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<KinPulseEvent>();
      yield* Pulse.subscribe(as(personId), page).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const first = yield* Queue.take(events);
      if (first._tag !== "snapshot") return yield* Effect.die(new Error("No first page."));
      return { name, personId, events, held: first.read };
    }),
  );
  yield* Work.update(as(ownerId), { orgId, key: soon.key, rev: soon.rev, state: "done" });
  yield* KinPulse.tick(orgId, NOW + 60_000);
  yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
  expect(yield* about(as(ownerId))).not.toContain(soon.key);
  for (const { name, personId, events, held } of watching) {
    const change = yield* Queue.take(events);
    if (change._tag !== "changed") return yield* Effect.die(new Error(`${name}: no change`));
    const folded: KinPulseScreenRead = kinPulseApply(held, change);
    const fresh = yield* Pulse.read(as(personId), page);
    expect({ ...folded, asOf: fresh.asOf }, `${name} folds to a fresh read`).toEqual(fresh);
    measured[`attention.${name}.reads`] = 0;
    measured[`attention.${name}.bytes`] = wireBytes(SCHEMAS.pulseEvent, change);
    // A new session that names the page held, nothing having moved since.
    const resumed = yield* Stream.runHead(
      Pulse.subscribe(as(personId), { ...page, held: change.hash }),
    ).pipe(Effect.map(Option.getOrThrow));
    expect(resumed._tag, `${name} resumes`).toBe("current");
    measured[`reconnect.${name}.pulseBytes`] = wireBytes(SCHEMAS.pulseEvent, resumed);
  }
  return measured;
});

/** Money's reads an open owner-level Money screen made again for each kind of change. */
const MONEY_REREADS: ReadonlyArray<{
  readonly name: string;
  readonly onTask: boolean;
  readonly schema: Schema.Top;
  readonly run: (people: ReadonlyArray<PersonIdentity>) => Effect.Effect<object, unknown, Services>;
}> = [
  // Money's screen counts tasks among what is coming up; its line (`workOwed`) doesn't.
  {
    name: "money",
    onTask: true,
    schema: SCHEMAS.money,
    run: (p) => Money.money(p, { orgId, upcomingRows: false }),
  },
  {
    name: "owed",
    onTask: false,
    schema: SCHEMAS.money,
    run: (p) => Money.money(p, { orgId, upcomingRows: false }),
  },
  {
    name: "cash",
    onTask: false,
    schema: successOf(KinMoneyAnswerRpcs, "kin.work.cash"),
    run: (p) => MoneyAnswers.cash(p, { orgId }),
  },
  {
    name: "outlook",
    onTask: false,
    schema: successOf(KinMoneyAnswerRpcs, "kin.work.outlook"),
    run: (p) => MoneyAnswers.outlook(p, { orgId }),
  },
  {
    name: "budgets",
    onTask: false,
    schema: successOf(KinMoneyAnswerRpcs, "kin.work.budgets"),
    run: (p) => MoneyAnswers.budgets(p, { orgId }),
  },
  {
    name: "receipts",
    onTask: true,
    schema: successOf(KinFinanceRpcs, "kin.work.receipts"),
    run: (p) => Money.receipts(p, { orgId }),
  },
  {
    name: "goals",
    onTask: true,
    schema: successOf(KinPulseRpcs, "kin.goals.list"),
    run: (p) => Goals.list(p, orgId),
  },
  { name: "lists", onTask: false, schema: SCHEMAS.lists, run: (p) => Money.lists(p, { orgId }) },
];
const MONEY_SCREENS: ReadonlyArray<ReadonlyArray<KinMoneyPart>> = [
  ["summary"],
  KIN_MONEY_PARTS.filter((part) => part !== "summary"),
];

/**
 * An invoice paid, then a task renamed, with Money open: what reading again cost each viewer, and
 * what `kin.money.subscribe` sends instead. A teammate is refused the stream and keeps their reads.
 */
const moneyChange = Effect.fn("KinWireBudget.moneyChange")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords.KinRecords;
  const pull = yield* Stream.toPull(records.changes(orgId));
  yield* pull;
  const measured: Record<string, number> = {};
  const viewers = yield* Effect.forEach(VIEWERS, ([name, personId]) =>
    Effect.gen(function* () {
      const sessions = yield* Effect.forEach(MONEY_SCREENS, (parts) =>
        Effect.result(makeMoneyStream(as(personId), { orgId, parts })),
      );
      if (sessions.some((one) => one._tag === "Failure")) {
        measured[`money.${name}.streamRefused`] = 1;
        return { name, personId, sessions: [] };
      }
      const open = yield* Effect.forEach(sessions, (one) =>
        one._tag === "Success" ? one.success.start() : Effect.die(new Error("unreachable")),
      );
      measured[`money.${name}.open.bytes`] = open.reduce(
        (sum, event) => sum + wireBytes(SCHEMAS.moneyEvent, event),
        0,
      );
      return {
        name,
        personId,
        sessions: sessions.flatMap((one) => (one._tag === "Success" ? [one.success] : [])),
      };
    }),
  );
  const feed = Effect.fn("KinWireBudget.moneyFeed")(function* (
    change: string,
    key: string,
    task: boolean,
  ) {
    const ticks: Array<KinRecords.Tick> = [];
    while (!ticks.some((tick) => tick.key === key)) ticks.push(...(yield* pull));
    const demand = new Set(ticks.flatMap((tick) => [...demandOfTick(tick)]));
    for (const { name, personId, sessions } of viewers) {
      let reads = 0;
      let rereadBytes = 0;
      for (const one of MONEY_REREADS.filter((read) => !task || read.onTask)) {
        reads += 1;
        const result = yield* Effect.result(one.run(as(personId)));
        if (result._tag === "Success") rereadBytes += wireBytes(one.schema, result.success);
      }
      measured[`money.${name}.${change}.before.reads`] = reads;
      measured[`money.${name}.${change}.before.bytes`] = rereadBytes;
      if (sessions.length === 0) {
        // Not on the stream: the same reads as before.
        measured[`money.${name}.${change}.after.reads`] = reads;
        continue;
      }
      const events = (yield* Effect.forEach(sessions, (session) => session.apply(demand))).flat();
      measured[`money.${name}.${change}.after.reads`] = 0;
      measured[`money.${name}.${change}.after.items`] = events.length;
      measured[`money.${name}.${change}.after.bytes`] = events.reduce(
        (sum, event) => sum + wireBytes(SCHEMAS.moneyEvent, event),
        0,
      );
    }
  });
  const [unpaid] = yield* sql<{ key: string; minor: number }>`SELECT key, amount_minor AS minor
    FROM kin_records WHERE org_id = ${orgId} AND register_id = 'invoices' AND state = 'waiting'
    ORDER BY key LIMIT 1`;
  yield* Money.recordPayment(as(ownerId), {
    orgId,
    key: unpaid!.key as never,
    amount: { minor: unpaid!.minor, currency: "INR" },
    paidOn: day(0),
    clientRequestId: "wire-budget-paid",
  });
  yield* feed("invoicePaid", unpaid!.key, false);
  const [task] = yield* sql<{ key: string; rev: number }>`SELECT key, rev FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'work' AND state = 'open' ORDER BY key LIMIT 1`;
  yield* Work.update(as(ownerId), {
    orgId,
    key: task!.key as never,
    rev: task!.rev,
    title: "Invented: check the logo files again",
  });
  yield* feed("taskChange", task!.key, true);
  return measured;
});

withLayer(layer)("Kin wire budget", (it) => {
  it.effect("hot reads and one change's stream match kinWireBudget.json", () =>
    Effect.gen(function* () {
      yield* seed(BASE_SIZE);
      const measured: Record<string, number> = {};
      const over: Array<string> = [];
      const rereadBytes = new Map<string, number>();
      for (const [name, personId] of VIEWERS) {
        let reread = 0;
        for (const one of READS) {
          const result = yield* Effect.result(one.run(as(personId), personId));
          if (result._tag === "Failure") {
            // A read the host refuses this viewer costs nothing to send but the refusal.
            measured[`${name}.${one.name}.refused`] = 1;
            continue;
          }
          const bytes = wireBytes(one.schema, result.success);
          measured[`${name}.${one.name}.bytes`] = bytes;
          measured[`${name}.${one.name}.rows`] = rowsOf(result.success, one.rows);
          if (!one.paged && bytes > UNPAGED_CEILING) over.push(`${name}.${one.name}: ${bytes}`);
          if (one.name === "taskPage" || one.name === "dueToday" || one.name === "summary")
            reread += bytes;
        }
        rereadBytes.set(name, reread);
      }
      Object.assign(measured, yield* oneChange(rereadBytes));
      Object.assign(measured, yield* Effect.scoped(rowsChange()));
      Object.assign(measured, yield* Effect.scoped(docChange()));
      Object.assign(measured, yield* reconnect());
      Object.assign(measured, yield* Effect.scoped(attentionMove()));
      Object.assign(measured, yield* Effect.scoped(moneyChange()));

      expect(over, `Unpaged Kin reads over ${UNPAGED_CEILING} bytes: page them.`).toEqual([]);
      expect(
        measured,
        "Set kinWireBudget.json to the measured values. Growth shows in review as that file's diff; say why in the PR.",
      ).toEqual(budget);
    }),
  );
});

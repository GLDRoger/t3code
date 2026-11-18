import { KinOrgId, KinPersonId, kinPulseFactRecord } from "@t3tools/contracts";
import { makeAsyncRotatingFileSink } from "@t3tools/shared/logging";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { isOwnerHimself, mayActAsOwner } from "../people/KinAccess.ts";
import * as KinOpen from "./KinOpen.ts";

/**
 * The open list in shadow: every 15 minutes, for every person, today's client composition rebuilt
 * from the same server reads beside `KinOpen`'s list, one NDJSON line each. Differences the new
 * rules intend are named; anything else is `unexplained`. It only reads, and never fails Kin.
 */

const EVERY_MS = 15 * 60_000;
/** What today's teammate badge reads (`useKinMyDueTasks`). */
const OLD_MINE_CAP = 20;
export const SHADOW_FILE = "kin-open-shadow.ndjson";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 2;

export type ShadowLevel = "owner" | "co_owner" | "member";

/** Both sides of one person's list, as id sets: what the comparison is a pure function of. */
export type ShadowInput = {
  readonly level: ShadowLevel;
  readonly old: {
    readonly facts: ReadonlyArray<string>;
    /** Facts' record keys (`outline.records`). */
    readonly records: ReadonlySet<string>;
    /** Record keys of the facts' records, per fact id. */
    readonly factRecords: ReadonlyMap<string, string>;
    readonly waiting: ReadonlyArray<string>;
    /** The first 20 due tasks, covered or not, by record key. */
    readonly mine: ReadonlyArray<string>;
    readonly owed: boolean;
    readonly briefWaiting: number;
  };
  readonly next: {
    readonly facts: ReadonlyArray<string>;
    readonly waiting: ReadonlyArray<string>;
    /** Every due task no fact stands for, by record key. */
    readonly mine: ReadonlyArray<string>;
    readonly owed: boolean;
    readonly needsYou: number;
    readonly waitingCount: number;
  };
  /** Waiting ids the new list leaves out, and why. */
  readonly settled: ReadonlyMap<string, KinOpen.WaitingSettled>;
};

const unexplained = (expected: ReadonlyArray<string>, next: ReadonlyArray<string>) => {
  const want = new Set(expected);
  const got = new Set(next);
  return [
    ...[...got].filter((id) => !want.has(id)).map((id) => `+${id}`),
    ...[...want].filter((id) => !got.has(id)).map((id) => `-${id}`),
  ].toSorted();
};

/** One person's comparison: old as today's clients total it, expected as the new rules say. */
export const compare = (input: ShadowInput) => {
  const { old, next, level } = input;
  const ownerLevel = level !== "member";
  const intendedWaiting = { approval_not_live: 0, send_not_open: 0, question_settled: 0 };
  for (const id of old.waiting) {
    const reason = input.settled.get(id);
    if (reason !== undefined) intendedWaiting[reason] += 1;
  }
  const oldMine = old.mine.filter((key) => !old.records.has(key));
  const shown = new Set(oldMine);
  const overCap = next.mine.filter((key) => !shown.has(key));
  const oldPane = old.facts.length + old.waiting.length + oldMine.length + (old.owed ? 1 : 0);
  const onMine = new Set(old.mine);
  const factsOnMine = old.facts.filter((id) => onMine.has(old.factRecords.get(id) ?? "")).length;
  const facts = {
    old: old.facts.length,
    new: next.facts.length,
    unexplained: unexplained(old.facts, next.facts),
  };
  const waiting = {
    old: old.waiting.length,
    new: next.waiting.length,
    intended: intendedWaiting,
    unexplained: unexplained(
      old.waiting.filter((id) => !input.settled.has(id)).map((id) => `waiting:${id}`),
      next.waiting.map((id) => `waiting:${id}`),
    ),
  };
  const mine = {
    old: oldMine.length,
    new: next.mine.length,
    intended: { over_cap: overCap.length },
    unexplained: unexplained(
      [...oldMine, ...overCap].map((key) => `task:${key}`),
      next.mine.map((key) => `task:${key}`),
    ),
  };
  const money = {
    old: old.owed ? 1 : 0,
    new: next.owed ? 1 : 0,
    unexplained: unexplained(old.owed ? ["money:overdue"] : [], next.owed ? ["money:overdue"] : []),
  };
  return {
    facts,
    waiting,
    mine,
    money,
    totals: {
      badge: [ownerLevel ? old.facts.length : old.mine.length, next.needsYou],
      pane: [oldPane, next.needsYou],
      tasksBlock: ownerLevel ? [oldPane - factsOnMine - oldMine.length, next.needsYou] : null,
      briefWaiting: level === "owner" ? [old.briefWaiting, next.waitingCount] : null,
    },
    ok: [facts, waiting, mine, money].every((bucket) => bucket.unexplained.length === 0),
  };
};

const roundMs = (duration: Duration.Duration) => Math.round(Duration.toMillis(duration) * 10) / 10;

/** Both sides for one person at `at`, in one read-only transaction. */
const personLine = Effect.fn("KinOpenShadow.person")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const { owner } = yield* KinIdentity;
  const ownerLevel = yield* mayActAsOwner(orgId, personId, owner);
  const level: ShadowLevel = isOwnerHimself(owner, personId)
    ? "owner"
    : ownerLevel
      ? "co_owner"
      : "member";
  return yield* Effect.gen(function* () {
    const [newMs, from] = yield* Effect.timed(
      KinOpen.sources({ orgId, viewer: { personId, ownerLevel }, at }),
    );
    // Every row, uncapped: the comparison is of what the list holds, not the page sent.
    const read = KinOpen.rowsOf(from, at, Number.POSITIVE_INFINITY);
    const [oldMs, extra] = yield* Effect.timed(
      Effect.gen(function* () {
        const mine = yield* KinOpen.ownTasks({
          orgId,
          personId,
          dayEnd: from.dayEnd,
          limit: OLD_MINE_CAP,
        });
        const [brief] =
          level === "owner"
            ? yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_waiting
                WHERE org_id = ${orgId} AND person_id = ${personId} AND resolved_at IS NULL`
            : [];
        return { mine: mine.map((task) => task.key), briefWaiting: brief?.n ?? 0 };
      }),
    );
    const factIds = from.facts.map((fact) => `fact:${fact.key}`);
    const factRecords = new Map(
      from.facts.flatMap((fact) => {
        const record = kinPulseFactRecord(fact);
        return record === null ? [] : [[`fact:${fact.key}`, record] as const];
      }),
    );
    const result = compare({
      level,
      old: {
        facts: factIds,
        records: from.covered,
        factRecords,
        waiting: from.waiting.map((item) => item.waitingId),
        mine: extra.mine,
        owed: from.overdue !== null && from.overdue > 0 && !from.invoiceFact,
        briefWaiting: extra.briefWaiting,
      },
      next: {
        facts: read.rows.filter((row) => row.item._tag === "fact").map((row) => row.id),
        waiting: read.rows.flatMap((row) =>
          row.item._tag === "waiting" ? [row.item.waiting.waitingId] : [],
        ),
        mine: read.rows.flatMap((row) => (row.item._tag === "task" ? [row.item.key] : [])),
        owed: read.rows.some((row) => row.item._tag === "money"),
        needsYou: read.counts.needsYou,
        waitingCount: read.counts.waiting,
      },
      settled: from.settled,
    });
    return {
      v: 1,
      at: DateTime.formatIso(DateTime.makeUnsafe(at)),
      org: orgId,
      viewer: personId,
      level,
      ms: { old: roundMs(oldMs), new: roundMs(newMs) },
      ...result,
    };
  }).pipe(sql.withTransaction, NodeSqliteClient.readOnly);
});

/** A shadow failure is logged and goes no further; only shutting down stops it. */
const quietly =
  (about: object) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCauseIf(
        (cause: Cause.Cause<E>) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("Kin open list shadow failed", { ...about, cause }),
      ),
    );

/** One pass over every person of every company, each line written as it is built. */
const pass = Effect.fn("KinOpenShadow.pass")(function* <E>(
  at: number,
  write: (line: string) => Effect.Effect<void, E>,
) {
  const sql = yield* SqlClient.SqlClient;
  // Scheduler maintenance scans organizations and their people; each line is one person's.
  const people = yield* sql<{ orgId: string; personId: string }>`SELECT p.org_id AS "orgId",
      p.person_id AS "personId"
    FROM kin_people p JOIN kin_orgs o ON o.org_id = p.org_id
    WHERE p.removed_at IS NULL ORDER BY p.org_id, p.person_id`.pipe(NodeSqliteClient.readOnly);
  for (const row of people) {
    const orgId = KinOrgId.make(row.orgId);
    const personId = KinPersonId.make(row.personId);
    yield* personLine(orgId, personId, at).pipe(
      Effect.tap((line) =>
        line.ok
          ? Effect.void
          : Effect.logWarning("Kin open list shadow differs", {
              orgId,
              viewer: personId,
              unexplained: {
                facts: line.facts.unexplained,
                waiting: line.waiting.unexplained,
                mine: line.mine.unexplained,
                money: line.money.unexplained,
              },
            }),
      ),
      Effect.flatMap((line) => write(`${JSON.stringify(line)}\n`)),
      quietly({ orgId, viewer: personId }),
    );
  }
});

/** Registered beside the pulse: a line per person every 15 minutes, beside the server trace. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { serverTracePath } = yield* ServerConfig;
    const path = yield* Path.Path;
    const ticks = yield* Scheduler.Scheduler;
    const sink = yield* makeAsyncRotatingFileSink({
      filePath: path.join(path.dirname(serverTracePath), SHADOW_FILE),
      maxBytes: MAX_BYTES,
      maxFiles: MAX_FILES,
    });
    let due = 0;
    yield* ticks.register(
      "kin-open-shadow",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now < due) return;
        due = now + EVERY_MS;
        yield* pass(now, sink.write);
      }).pipe(quietly({})),
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Kin open list shadow is off", { cause })),
  ),
);

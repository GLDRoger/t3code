import {
  KinChatError,
  type KinOrgId,
  type KinWatchDid,
  type KinWatchOutcome,
  type KinWatchWhy,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { DAY_MS, MINUTE_MS } from "../durations.ts";
import type { CodeOutcome, Evidence, Found, WatchKind, WatchRow } from "./kinds/kind.ts";
import { one, watchSeen, type WatchReader } from "./readRpcs.ts";

/**
 * The watch list and its log. Every write to `kin_watches` and `kin_watch_looks` is here, and each
 * moves the `watches` refresh topic (`KinRefreshHub.test.ts` holds that). No model runs here.
 */

/** The first look's interval; each look that finds nothing to close doubles it, up to a day. */
export const FIRST_INTERVAL_MS = 45 * MINUTE_MS;
const LONGEST_INTERVAL_MS = DAY_MS;
/** Looks are kept this long. */
const KEEP_LOOKS_MS = 30 * DAY_MS;
const PRUNE_BATCH = 5_000;

const shortHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
const watchIdOf = (orgId: string, kind: string, sourceKey: string) =>
  `w-${shortHash(`${orgId}\0${kind}\0${sourceKey}`)}`;

const encodeEvidence = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ kind: Schema.String, id: Schema.String }))),
);
const encodeCounts = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number)),
);

const notFound = new KinChatError({ reason: "not_found", message: "Kin isn't watching that." });

const watchColumns = (sql: SqlClient.SqlClient) => sql`w.watch_id AS "watchId", w.kind,
  w.source_key AS "sourceKey", w.record_id AS "recordId", w.subject_ref AS "subjectRef", w.about,
  w.agent_id AS "agentId", w.latest_by AS "latestBy", w.looked_at AS "lookedAt",
  w.created_at AS "createdAt", w.next_look_at AS "nextLookAt", w.interval_ms AS "intervalMs",
  w.asked_look_at AS "askedLookAt", w.aside, w.aside_until AS "asideUntil", w.source`;

export type OpenWatch = WatchRow & {
  readonly nextLookAt: number;
  readonly intervalMs: number;
  readonly askedLookAt: number | null;
  readonly aside: number;
  readonly asideUntil: number | null;
  readonly source: string;
};

/** New sources a kind found become watches, each due at once; a known source is left as it is. */
export const upsert = Effect.fn("KinWatches.upsert")(function* (input: {
  readonly orgId: KinOrgId;
  readonly at: number;
  readonly kind: Pick<WatchKind, "kind" | "source">;
  readonly found: ReadonlyArray<Found & { readonly latestBy?: number | null }>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = input;
  if (input.found.length === 0) return 0;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      let made = 0;
      for (const found of input.found) {
        // A record named here is checked against the org's own rows in this transaction.
        const inserted = yield* sql`INSERT INTO kin_watches (org_id, watch_id, kind, source,
            source_key, record_id, subject_ref, about, closes_when, agent_id, audience, why,
            set_by_kind, latest_by, next_look_at, interval_ms, state, created_at, updated_at)
          SELECT ${orgId}, ${watchIdOf(orgId, input.kind.kind, found.sourceKey)}, ${input.kind.kind},
            ${input.kind.source}, ${found.sourceKey}, ${found.recordId}, ${found.subjectRef},
            ${found.about.slice(0, 200)}, ${found.closesWhen.slice(0, 200)}, ${found.agentId},
            'owner', ${found.why.slice(0, 200)}, 'code', ${found.latestBy ?? null}, ${at},
            ${FIRST_INTERVAL_MS}, 'open', ${at}, ${at}
          WHERE ${found.recordId} IS NULL OR EXISTS (SELECT 1 FROM kin_records
            WHERE org_id = ${orgId} AND record_id = ${found.recordId})
          ON CONFLICT (org_id, kind, source_key) DO NOTHING RETURNING watch_id`;
        made += inserted.length;
      }
      if (made > 0) yield* (yield* KinRefreshObserver).touch(orgId, "watches");
      return made;
    }),
  );
});

/** Every open watch of the org, oldest next look first. */
export const openWatches = Effect.fn("KinWatches.open")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<OpenWatch>`SELECT ${watchColumns(sql)} FROM kin_watches w
    WHERE w.org_id = ${orgId} AND w.state = 'open'
    ORDER BY w.next_look_at, w.watch_id`;
});

/**
 * Before a round looks: watches whose subject moved are due at once with the back-off reset, and
 * set-aside ones sleep to when their hold ends (and wake when it does).
 */
export const settleClock = Effect.fn("KinWatches.settleClock")(function* (input: {
  readonly orgId: KinOrgId;
  readonly at: number;
  readonly moved: ReadonlySet<string>;
  readonly asleep: ReadonlyMap<string, number | null>;
  readonly watches: ReadonlyArray<OpenWatch>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = input;
  let changed = 0;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const watch of input.watches) {
        // Look now looks even while it is set aside.
        const asleep = input.asleep.has(watch.watchId) && watch.askedLookAt === null;
        if (asleep) {
          const until = input.asleep.get(watch.watchId) ?? null;
          // Asleep it is read again each first interval, so a hold lifted early wakes it.
          const next = Math.min(until ?? Infinity, at + FIRST_INTERVAL_MS);
          if (watch.aside === 1 && watch.asideUntil === until && watch.nextLookAt > at) continue;
          yield* sql`UPDATE kin_watches SET aside = 1, aside_until = ${until},
              next_look_at = ${next}, updated_at = ${at}
            WHERE org_id = ${orgId} AND watch_id = ${watch.watchId}`;
          changed += 1;
        } else if (watch.aside === 1 || input.moved.has(watch.watchId)) {
          yield* sql`UPDATE kin_watches SET aside = 0, aside_until = NULL, next_look_at = ${at},
              interval_ms = ${FIRST_INTERVAL_MS}, updated_at = ${at}
            WHERE org_id = ${orgId} AND watch_id = ${watch.watchId}`;
          changed += 1;
        }
      }
      if (changed > 0) yield* (yield* KinRefreshObserver).touch(orgId, "watches");
    }),
  );
  return changed;
});

/** One watch's look in a round, settled by code. */
export interface Look {
  readonly watch: OpenWatch;
  readonly why: KinWatchWhy;
  readonly outcome: Exclude<CodeOutcome, { readonly _tag: "read" }>;
  readonly checksWork: boolean;
}

const outcomeOf = (outcome: Look["outcome"]): KinWatchOutcome => outcome._tag;
const didOf = (look: Look): KinWatchDid =>
  look.outcome._tag === "closed"
    ? "closed"
    : look.outcome._tag === "problem"
      ? "problem"
      : look.checksWork
        ? "checked_work"
        : "nothing_new";
const lineOf = (outcome: Look["outcome"]) =>
  outcome._tag === "closed"
    ? outcome.how
    : outcome._tag === "nothing_new"
      ? "nothing new"
      : outcome.line;
const evidenceOf = (outcome: Look["outcome"]): Evidence =>
  "evidence" in outcome ? outcome.evidence : [];

/** The next look after one that didn't close it: the interval, never past its latest-by. */
const nextLook = (watch: Pick<OpenWatch, "intervalMs" | "latestBy">, at: number) => {
  const next = at + watch.intervalMs;
  return {
    nextLookAt:
      watch.latestBy !== null && watch.latestBy > at ? Math.min(next, watch.latestBy) : next,
    intervalMs: Math.min(watch.intervalMs * 2, LONGEST_INTERVAL_MS),
  };
};

/**
 * A round's looks, its summary row and each watch's new state, in one transaction. A closed look
 * closes its watch with the kind's words; any other sets the next look.
 */
export const recordRound = Effect.fn("KinWatches.recordRound")(function* (input: {
  readonly orgId: KinOrgId;
  readonly at: number;
  readonly looks: ReadonlyArray<Look>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = input;
  if (input.looks.length === 0) return undefined;
  const roundId = `r-${shortHash(`${orgId}\0${at}`)}`;
  const counts: Record<string, number> = {};
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const look of input.looks) {
        const { watch } = look;
        const outcome = outcomeOf(look.outcome);
        const line = lineOf(look.outcome).slice(0, 300);
        counts[outcome] = (counts[outcome] ?? 0) + 1;
        yield* sql`INSERT INTO kin_watch_looks (org_id, look_id, round_id, watch_id, at, why, by,
            outcome, did, line, evidence_json)
          VALUES (${orgId}, ${`l-${shortHash(`${roundId}\0${watch.watchId}`)}`}, ${roundId},
            ${watch.watchId}, ${at}, ${look.why}, 'code', ${outcome}, ${didOf(look)}, ${line},
            ${yield* encodeEvidence(evidenceOf(look.outcome))})
          ON CONFLICT (org_id, look_id) DO NOTHING`;
        if (look.outcome._tag === "closed")
          yield* sql`UPDATE kin_watches SET state = 'closed', closed_at = ${at},
              closed_how = ${look.outcome.how.slice(0, 200)}, closed_by_kind = 'code',
              closed_by_id = NULL, looked_at = ${at}, last_outcome = 'closed', last_line = ${line},
              asked_look_at = NULL, updated_at = ${at}
            WHERE org_id = ${orgId} AND watch_id = ${watch.watchId} AND state = 'open'`;
        else if (watch.askedLookAt !== null && watch.nextLookAt > at)
          // Look now keeps the round's clock: no back-off step, the next look stays when it was.
          yield* sql`UPDATE kin_watches SET looked_at = ${at}, last_outcome = ${outcome},
              last_line = ${line}, asked_look_at = NULL, updated_at = ${at}
            WHERE org_id = ${orgId} AND watch_id = ${watch.watchId} AND state = 'open'`;
        else {
          const next = nextLook(watch, at);
          yield* sql`UPDATE kin_watches SET looked_at = ${at}, last_outcome = ${outcome},
              last_line = ${line}, next_look_at = ${next.nextLookAt},
              interval_ms = ${next.intervalMs}, asked_look_at = NULL, updated_at = ${at}
            WHERE org_id = ${orgId} AND watch_id = ${watch.watchId} AND state = 'open'`;
        }
      }
      yield* sql`INSERT INTO kin_watch_looks (org_id, look_id, round_id, watch_id, at, counts_json)
        VALUES (${orgId}, ${`l-${roundId}`}, ${roundId}, NULL, ${at}, ${yield* encodeCounts(counts)})
        ON CONFLICT (org_id, look_id) DO NOTHING`;
      yield* (yield* KinRefreshObserver).touch(orgId, "watches");
    }),
  );
  return roundId;
});

/** One watch this reader may see, or `not_found` (another org's, or one they can't see). */
const seenWatch = Effect.fn("KinWatches.seen")(function* (
  orgId: KinOrgId,
  reader: WatchReader,
  watchId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    state: string;
    source: string;
    setByKind: string;
    setById: string | null;
  }>`SELECT w.state, w.source, w.set_by_kind AS "setByKind", w.set_by_id AS "setById"
    FROM kin_watches w
    WHERE w.org_id = ${orgId} AND w.watch_id = ${watchId} AND ${watchSeen(sql, reader)}`;
  if (row === undefined) return yield* notFound;
  return row;
});

/**
 * Look now: due at once, why "You asked", leaving the next routine look where it was. Asked again
 * before it ran, nothing more is queued.
 */
export const look = Effect.fn("KinWatches.look")(function* (
  orgId: KinOrgId,
  reader: WatchReader,
  watchId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const watch = yield* seenWatch(orgId, reader, watchId);
      if (watch.state !== "open")
        return yield* new KinChatError({
          reason: "invalid_state",
          message: "Kin isn't watching this now. Watch again first.",
        });
      const asked = yield* sql`UPDATE kin_watches SET asked_look_at = ${at}, updated_at = ${at}
        WHERE org_id = ${orgId} AND watch_id = ${watchId} AND asked_look_at IS NULL
        RETURNING watch_id`;
      if (asked.length > 0) yield* (yield* KinRefreshObserver).touch(orgId, "watches");
    }),
  );
  return { watch: yield* one(orgId, reader, watchId) };
});

/**
 * Stop watching. A watch a person asked for stops only on their own tap or the owner level's
 * (code evidence closes it otherwise).
 */
export const stop = Effect.fn("KinWatches.stop")(function* (
  orgId: KinOrgId,
  reader: WatchReader,
  watchId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const watch = yield* seenWatch(orgId, reader, watchId);
      if (watch.state !== "open")
        return yield* new KinChatError({
          reason: "invalid_state",
          message: "Kin isn't watching this now.",
        });
      if (
        reader.viewer._tag === "people" &&
        watch.source === "person" &&
        watch.setById !== reader.personId
      )
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "Only the person who asked for this watch, or an owner, can stop it.",
        });
      yield* sql`UPDATE kin_watches SET state = 'stopped', closed_at = ${at}, closed_how = NULL,
          closed_by_kind = 'person', closed_by_id = ${reader.personId}, asked_look_at = NULL,
          updated_at = ${at}
        WHERE org_id = ${orgId} AND watch_id = ${watchId} AND state = 'open'`;
      yield* (yield* KinRefreshObserver).touch(orgId, "watches");
    }),
  );
  return { watch: yield* one(orgId, reader, watchId) };
});

/** Watch again: open once more and due at once, as if just asked; the back-off starts over. */
export const again = Effect.fn("KinWatches.again")(function* (
  orgId: KinOrgId,
  reader: WatchReader,
  watchId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const watch = yield* seenWatch(orgId, reader, watchId);
      if (watch.state === "open") return;
      yield* sql`UPDATE kin_watches SET state = 'open', closed_at = NULL, closed_how = NULL,
          closed_by_kind = NULL, closed_by_id = NULL, aside = 0, aside_until = NULL,
          interval_ms = ${FIRST_INTERVAL_MS}, next_look_at = ${at}, asked_look_at = ${at},
          updated_at = ${at}
        WHERE org_id = ${orgId} AND watch_id = ${watchId} AND state <> 'open'`;
      yield* (yield* KinRefreshObserver).touch(orgId, "watches");
    }),
  );
  return { watch: yield* one(orgId, reader, watchId) };
});

/** Looks older than 30 days go; scanned over every org, bounded per pass. */
export const pruneLooks = Effect.fn("KinWatches.pruneLooks")(function* (at: number) {
  const sql = yield* SqlClient.SqlClient;
  const before = at - KEEP_LOOKS_MS;
  for (let batch = 0; batch < 20; batch++) {
    // Retention scans every org, bounded by the batch size.
    const gone = yield* sql`DELETE FROM kin_watch_looks WHERE rowid IN (
        SELECT rowid FROM kin_watch_looks WHERE at < ${before} ORDER BY rowid LIMIT ${PRUNE_BATCH})
      RETURNING 1`;
    if (gone.length < PRUNE_BATCH) break;
  }
});

import type { KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Scheduler from "../../scheduling/Scheduler.ts";
import { forkParked } from "../../serverActivation.ts";
import { HOUR_MS } from "../durations.ts";
import { KinHostCare } from "./KinHostCare.ts";

const OFFLINE_MS = 3 * HOUR_MS;

const pendingNotices = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      from: Schema.Int,
      to: Schema.Int,
      caughtUp: Schema.optionalKey(Schema.Int),
    }),
  ),
);
const decodeNotices = Schema.decodeEffect(pendingNotices);
const encodeNotices = Schema.encodeEffect(pendingNotices);

export const markStarted = Effect.fn("KinOfflineCatchUp.markStarted")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`UPDATE kin_org_state
    SET offline_notices_json = json_insert(offline_notices_json, '$[#]',
      json_object('from', last_alive_at, 'to', ${now}))
    WHERE last_alive_at < ${now - OFFLINE_MS}`.pipe(
    Effect.andThen(writeHeartbeat(now)),
    sql.withTransaction,
  );
});

const writeHeartbeat = Effect.fn("KinOfflineCatchUp.writeHeartbeat")(function* (now: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_org_state (org_id, last_alive_at, stop_managed)
    SELECT org_id, ${now}, 0 FROM kin_orgs WHERE 1
    ON CONFLICT (org_id) DO UPDATE SET last_alive_at = excluded.last_alive_at
    WHERE last_alive_at IS NULL OR last_alive_at < excluded.last_alive_at`;
});

const countCaughtUp = Effect.fn("KinOfflineCatchUp.countCaughtUp")(function* (
  orgId: KinOrgId,
  { from, to }: { readonly from: number; readonly to: number },
) {
  const sql = yield* SqlClient.SqlClient;
  const fromIso = DateTime.formatIso(DateTime.makeUnsafe(from));
  const toIso = DateTime.formatIso(DateTime.makeUnsafe(to));
  const [row] = yield* sql<{ total: number }>`
    WITH caught_chat(message_id) AS (
      SELECT json_extract(json, '$.messageId')
      FROM kin_events WHERE org_id = ${orgId} AND tag IN ('chat.message', 'widget.action')
        AND received_at > ${from} AND received_at <= ${to} AND queued_at >= ${to}
        AND state <> 'expired'
      UNION
      SELECT m.message_id FROM kin_discussions d
      JOIN kin_messages m ON m.org_id = d.org_id AND m.message_id = SUBSTR(d.open_key, 9)
      WHERE d.org_id = ${orgId} AND d.open_key LIKE 'message:%' AND d.created_at >= ${to}
        AND m.created_at > ${fromIso} AND m.created_at <= ${toIso}
    )
    SELECT (SELECT COUNT(message_id) FROM caught_chat)
      + (SELECT COUNT(*) FROM kin_arrivals
        WHERE org_id = ${orgId} AND received_at > ${from} AND received_at <= ${to}
          AND noticed_at >= ${to} AND class <> 'gap' AND state <> 'parked'
          AND reason IS NOT 'also recorded in another connected mailbox') AS total`;
  return row?.total ?? 0;
});

export const deliverPending = Effect.fn("KinOfflineCatchUp.deliverPending")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const care = yield* KinHostCare;
  const orgs = yield* sql<{ orgId: KinOrgId }>`SELECT org_id AS "orgId" FROM kin_org_state
    WHERE offline_notices_json <> '[]' ORDER BY org_id`;
  for (const { orgId } of orgs)
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ pending: string }>`SELECT offline_notices_json AS pending
          FROM kin_org_state WHERE org_id = ${orgId}`;
          if (row === undefined) return;
          const pending = yield* decodeNotices(row.pending);
          const stillPending = [];
          for (const notice of pending) {
            const caughtUp = notice.caughtUp ?? (yield* countCaughtUp(orgId, notice));
            if (!(yield* care.postOfflineNotice(orgId, { ...notice, caughtUp })))
              stillPending.push({ ...notice, caughtUp });
          }
          const next = yield* encodeNotices(stillPending);
          if (next !== row.pending)
            yield* sql`UPDATE kin_org_state SET offline_notices_json = ${next} WHERE org_id = ${orgId}`;
        }),
      )
      .pipe(
        Effect.catch((cause) => Effect.logWarning("Kin offline notice failed", { orgId, cause })),
      );
});

// Observe the existing passes without changing their scheduling or calling any of them twice.
const catchUpSources = new Set([
  "kin-triggers",
  "kin-deferrals",
  "kin-scheduled-tasks",
  "kin-arrivals",
]);

export class InitialPass extends Context.Reference<
  | {
      readonly started: Effect.Effect<void>;
      readonly chatDone: Effect.Effect<void>;
      readonly sourcesRegistered: (built: boolean) => Effect.Effect<void>;
      readonly observe: (
        scheduler: Scheduler.Scheduler["Service"],
      ) => Scheduler.Scheduler["Service"];
    }
  | undefined
>("t3/kin/host/OfflineCatchUp/InitialPass", { defaultValue: () => undefined }) {}

export const layer = Layer.effect(
  InitialPass,
  Effect.gen(function* () {
    const care = yield* Effect.serviceOption(KinHostCare);
    if (Option.isNone(care)) return undefined;

    const started = yield* Deferred.make<void>();
    const chatDone = yield* Deferred.make<void>();
    const sourcesRegistered = yield* Deferred.make<boolean>();
    const sources: Array<Deferred.Deferred<void>> = [];

    yield* Effect.gen(function* () {
      yield* markStarted().pipe(
        Effect.catch((cause) => Effect.logWarning("Kin offline window unavailable", { cause })),
        Effect.ensuring(Deferred.succeed(started, undefined)),
      );
      yield* Clock.currentTimeMillis.pipe(
        Effect.flatMap(writeHeartbeat),
        Effect.catch((cause) => Effect.logWarning("Kin liveness write failed", { cause })),
        Effect.schedule(Schedule.spaced("1 minute")),
        Effect.forkScoped,
      );
      yield* Deferred.await(chatDone);
      if (yield* Deferred.await(sourcesRegistered))
        yield* Effect.forEach(sources, Deferred.await, { discard: true });
      yield* deliverPending().pipe(
        Effect.provideService(KinHostCare, care.value),
        Effect.catch((cause) => Effect.logWarning("Kin offline notice scan failed", { cause })),
        Effect.repeat(Schedule.spaced("1 hour")),
      );
    }).pipe(forkParked);

    return {
      started: Deferred.await(started),
      chatDone: Deferred.succeed(chatDone, undefined).pipe(Effect.asVoid),
      sourcesRegistered: Effect.fn("KinOfflineCatchUp.sourcesRegistered")((built: boolean) =>
        Deferred.succeed(sourcesRegistered, built).pipe(Effect.asVoid),
      ),
      observe: (scheduler) =>
        Scheduler.Scheduler.of({
          register: Effect.fn("KinOfflineCatchUp.observePass")(function* (name, run) {
            if (!catchUpSources.has(name)) return yield* scheduler.register(name, run);
            const done = yield* Deferred.make<void>();
            sources.push(done);
            yield* scheduler.register(
              name,
              Deferred.await(started).pipe(
                Effect.andThen(run),
                Effect.ensuring(Deferred.succeed(done, undefined)),
              ),
            );
          }),
        }),
    };
  }),
);

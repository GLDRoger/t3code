import { KinEvent, type KinAgentId, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceSqlError, toPersistenceSqlError } from "../../persistence/Errors.ts";

const EventJson = Schema.fromJsonString(KinEvent);
const encodeEvent = Schema.encodeEffect(EventJson);
const decodeEvent = Schema.decodeEffect(EventJson);
const encodeEventIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

interface ClaimInput {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
  readonly model: string;
}

export class KinEventQueue extends Context.Service<
  KinEventQueue,
  {
    readonly enqueue: (
      event: KinEvent,
    ) => Effect.Effect<{ readonly duplicate: boolean }, PersistenceSqlError>;
    // Keep the scope open for the whole wake-up, including its terminal database write.
    readonly claim: (
      input: ClaimInput,
    ) => Effect.Effect<ReadonlyArray<KinEvent>, PersistenceSqlError, Scope.Scope>;
    // The runner must first confirm the provider run is no longer active.
    readonly requeueUnfinished: (
      orgId: KinOrgId,
      wakeupId: string,
    ) => Effect.Effect<number, PersistenceSqlError>;
  }
>()("t3/kin/lead/KinEventQueue") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const organizations = new Map<
    KinOrgId,
    { gate: Semaphore.Semaphore; changed: Deferred.Deferred<void> }
  >();

  const organization = (orgId: KinOrgId) => {
    const existing = organizations.get(orgId);
    if (existing !== undefined) return existing;
    const entry = { gate: Semaphore.makeUnsafe(1), changed: Deferred.makeUnsafe<void>() };
    organizations.set(orgId, entry);
    return entry;
  };

  const notify = Effect.fn("KinEventQueue.notify")(function* (orgId: KinOrgId) {
    const entry = organization(orgId);
    const changed = entry.changed;
    entry.changed = Deferred.makeUnsafe<void>();
    yield* Deferred.succeed(changed, undefined);
  });

  const enqueue = Effect.fn("KinEventQueue.enqueue")(
    function* (input: KinEvent) {
      const event = input._tag === "github" ? { ...input, dedupeKey: input.deliveryId } : input;
      let priority = "P2";
      switch (event._tag) {
        case "resume":
          priority = "P0";
          break;
        case "deferral.due":
        case "action.resolved":
        case "worker.report":
          priority = "P1";
          break;
        case "watchdog":
          priority = "P3";
          break;
        case "chat.message":
        case "widget.action":
          if (event.provenance._tag === "human") {
            const owners = yield* sql`
            SELECT 1 FROM kin_chat_members
            WHERE org_id = ${event.orgId} AND chat_id = ${event.chatId}
              AND member_id = ${event.provenance.memberId} AND person_id = ${event.provenance.personId}
              AND principal_kind = 'person' AND role = 'owner' AND left_at IS NULL
          `;
            if (owners.length > 0) priority = "P0";
          }
          break;
      }
      const json = yield* encodeEvent(event);
      const inserted = yield* sql`
      INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, dedupe_key, received_at)
      VALUES (${event.eventId}, ${event.orgId}, ${event.agentId}, ${event._tag}, ${priority},
        ${json}, ${event.dedupeKey}, ${DateTime.toEpochMillis(event.receivedAt)})
      ON CONFLICT (org_id, dedupe_key) DO NOTHING
      RETURNING event_id
    `;
      if (inserted.length > 0) yield* notify(event.orgId);
      return { duplicate: inserted.length === 0 };
    },
    Effect.mapError(toPersistenceSqlError("KinEventQueue.enqueue")),
    Effect.uninterruptible,
  );

  const awaitReady = Effect.fn("KinEventQueue.awaitReady")(function* (input: ClaimInput) {
    while (true) {
      const changed = organization(input.orgId).changed;
      const now = yield* Clock.currentTimeMillis;
      const [window] = yield* sql<{
        first_at: number | null;
        last_at: number | null;
        urgent_at: number | null;
        deferred_at: number | null;
      }>`
        SELECT
          MIN(CASE WHEN COALESCE(not_before, received_at) <= ${now}
            THEN received_at END) AS first_at,
          MAX(CASE WHEN COALESCE(not_before, received_at) <= ${now}
            THEN received_at END) AS last_at,
          MIN(CASE WHEN priority = 'P0' AND COALESCE(not_before, received_at) <= ${now}
            THEN received_at END) AS urgent_at,
          MIN(CASE WHEN not_before > ${now} THEN not_before END) AS deferred_at
        FROM kin_events
        WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND state = 'queued'
      `;
      const readyAt =
        window?.first_at != null && window.last_at !== null
          ? Math.min(
              window.last_at + 20_000,
              window.first_at + 120_000,
              window.urgent_at === null ? Infinity : window.urgent_at + 2_000,
            )
          : Infinity;
      if (readyAt <= now) return;
      const next = Math.min(readyAt, window?.deferred_at ?? Infinity);
      yield* Number.isFinite(next)
        ? Deferred.await(changed).pipe(
            Effect.timeoutOrElse({ duration: next - now, orElse: () => Effect.void }),
          )
        : Deferred.await(changed);
    }
  });

  const claim = Effect.fn("KinEventQueue.claim")(
    function* (input: ClaimInput) {
      yield* organization(input.orgId).gate.takeScoped(1);
      yield* awaitReady(input);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* sql`
        INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids)
        VALUES (${input.orgId}, ${input.wakeupId}, ${input.agentId}, ${input.model}, ${now}, 'running', '[]')
      `;
          const rows = yield* sql<{
            json: string;
            priority: string;
            received_at: number;
            event_id: string;
          }>`
        UPDATE kin_events SET state = 'claimed', wakeup_id = ${input.wakeupId}, attempts = attempts + 1
        WHERE event_id IN (
          SELECT event_id FROM kin_events
          WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND state = 'queued'
            AND (not_before IS NULL OR not_before <= ${now})
          ORDER BY priority, received_at, event_id LIMIT 50
        ) RETURNING json, priority, received_at, event_id
      `;
          const ordered = rows.toSorted(
            (a, b) =>
              a.priority.localeCompare(b.priority) ||
              a.received_at - b.received_at ||
              a.event_id.localeCompare(b.event_id),
          );
          const events = yield* Effect.forEach(ordered, (row) => decodeEvent(row.json));
          const eventIds = yield* encodeEventIds(events.map((event) => event.eventId));
          yield* sql`UPDATE kin_wakeups SET event_ids = ${eventIds}
        WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId}`;
          return events;
        }),
      );
    },
    Effect.mapError(toPersistenceSqlError("KinEventQueue.claim")),
  );

  const requeueUnfinished = Effect.fn("KinEventQueue.requeueUnfinished")(
    function* (orgId: KinOrgId, wakeupId: string) {
      const count = yield* organization(orgId).gate.withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const unfinished = yield* sql`
        UPDATE kin_wakeups SET status = 'interrupted', ended_at = ${now}
        WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND status = 'running' AND ended_at IS NULL
        RETURNING wakeup_id
      `;
            if (unfinished.length === 0) return 0;
            const rows = yield* sql`
        UPDATE kin_events SET state = 'queued', wakeup_id = NULL
        WHERE wakeup_id = ${wakeupId} AND org_id = ${orgId} AND state = 'claimed'
        RETURNING event_id
      `;
            return rows.length;
          }),
        ),
      );
      if (count > 0) yield* notify(orgId);
      return count;
    },
    Effect.mapError(toPersistenceSqlError("KinEventQueue.requeueUnfinished")),
  );

  return KinEventQueue.of({ enqueue, claim, requeueUnfinished });
});

export const layer = Layer.effect(KinEventQueue, make);

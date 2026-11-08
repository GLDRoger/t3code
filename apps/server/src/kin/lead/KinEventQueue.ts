import { ACTIVE_RUN_STATUSES } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  KinEvent,
  KinEventId,
  KinAgentId,
  KinOrgId,
  KinWakeupId,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
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

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";

const EventJson = Schema.fromJsonString(KinEvent);
const encodeEvent = Schema.encodeEffect(EventJson);
const decodeEvent = Schema.decodeEffect(EventJson);
const validateEvent = Schema.decodeEffect(Schema.toType(KinEvent));
const decodeOrgId = Schema.decodeEffect(KinOrgId);
const decodeWakeupId = Schema.decodeEffect(KinWakeupId);
const encodeEventIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const ClaimInput = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  wakeupId: KinWakeupId,
  model: TrimmedNonEmptyString,
});
type ClaimInput = typeof ClaimInput.Type;
const ReleaseFields = {
  budgetDeferred: Schema.optional(Schema.Boolean),
  orgId: KinOrgId,
  wakeupId: KinWakeupId,
  eventIds: Schema.optional(Schema.Array(KinEventId)),
};
const ReleaseInput = Schema.Union([
  Schema.Struct({
    ...ReleaseFields,
    countAttempt: Schema.Literal(false),
    notBefore: NonNegativeInt,
  }),
  Schema.Struct({
    ...ReleaseFields,
    countAttempt: Schema.Literal(true),
    notBefore: Schema.optional(NonNegativeInt),
  }),
]);
const FinishInput = Schema.Struct({
  orgId: KinOrgId,
  wakeupId: KinWakeupId,
  status: Schema.Literals(["completed", "failed", "timed_out"]),
});

const decodeClaimInput = Schema.decodeEffect(ClaimInput);
const decodeReleaseInput = Schema.decodeEffect(ReleaseInput);
const decodeFinishInput = Schema.decodeEffect(FinishInput);

export class KinEventQueueConflict extends Schema.TaggedError<KinEventQueueConflict>()(
  "KinEventQueueConflict",
  { orgId: KinOrgId, eventId: KinEventId },
) {}
export class KinEventQueueUnknownEvent extends Schema.TaggedError<KinEventQueueUnknownEvent>()(
  "KinEventQueueUnknownEvent",
  { orgId: KinOrgId, eventId: KinEventId },
) {}
export class KinEventQueueUnknownAgent extends Schema.TaggedError<KinEventQueueUnknownAgent>()(
  "KinEventQueueUnknownAgent",
  { orgId: KinOrgId, agentId: KinAgentId },
) {}
export class KinEventQueueRetiredAgent extends Schema.TaggedError<KinEventQueueRetiredAgent>()(
  "KinEventQueueRetiredAgent",
  { orgId: KinOrgId, agentId: KinAgentId },
) {}
const isRetiredAgent = Schema.is(KinEventQueueRetiredAgent);
export class KinEventQueueWakeupConflict extends Schema.TaggedError<KinEventQueueWakeupConflict>()(
  "KinEventQueueWakeupConflict",
  { orgId: KinOrgId, wakeupId: KinWakeupId },
) {}
export class KinEventQueueBusy extends Schema.TaggedError<KinEventQueueBusy>()(
  "KinEventQueueBusy",
  { orgId: KinOrgId },
) {}
const isUnknownAgent = Schema.is(KinEventQueueUnknownAgent);
const isWakeupConflict = Schema.is(KinEventQueueWakeupConflict);
const isConflict = Schema.is(KinEventQueueConflict);
const isUnknownEvent = Schema.is(KinEventQueueUnknownEvent);
const isBusy = Schema.is(KinEventQueueBusy);

function toQueuePersistenceError(operation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : toPersistenceSqlError(operation)(cause);
}
class NoClaimableEvents extends Schema.TaggedError<NoClaimableEvents>()("NoClaimableEvents", {}) {}

export class KinEventQueue extends Context.Service<
  KinEventQueue,
  {
    readonly enqueue: (
      event: KinEvent,
    ) => Effect.Effect<
      { readonly event: KinEvent; readonly duplicate: boolean },
      | PersistenceSqlError
      | PersistenceDecodeError
      | KinEventQueueConflict
      | KinEventQueueUnknownEvent
      | KinEventQueueUnknownAgent
      | KinEventQueueRetiredAgent
    >;
    readonly reconsiderBudget: (orgId: KinOrgId) => Effect.Effect<void, PersistenceSqlError>;
    readonly changes: (orgId: KinOrgId) => Effect.Effect<Effect.Effect<void>>;
    readonly nextReady: (
      orgId: KinOrgId,
    ) => Effect.Effect<
      { readonly agentId: KinAgentId; readonly readyAt: number } | undefined,
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly expireAgent: (
      orgId: KinOrgId,
      agentId: KinAgentId,
    ) => Effect.Effect<
      void,
      PersistenceSqlError | PersistenceDecodeError | KinEventQueueUnknownAgent
    >;
    // Scope closure releases only the permit; the runner owns wake-up finalization.
    readonly claim: (
      input: ClaimInput,
    ) => Effect.Effect<
      ReadonlyArray<KinEvent>,
      | PersistenceSqlError
      | PersistenceDecodeError
      | KinEventQueueBusy
      | KinEventQueueWakeupConflict,
      Scope.Scope
    >;
    readonly release: (
      input: typeof ReleaseInput.Type,
    ) => Effect.Effect<
      { readonly released: number; readonly failedEventIds: ReadonlyArray<KinEventId> },
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly finish: (
      input: typeof FinishInput.Type,
    ) => Effect.Effect<
      { readonly failedEventIds: ReadonlyArray<KinEventId> },
      PersistenceSqlError | PersistenceDecodeError
    >;
    // LEAD-5 startup recovery calls this only after confirming the provider run stopped.
    readonly requeueUnfinished: (
      orgId: KinOrgId,
      wakeupId: KinWakeupId,
    ) => Effect.Effect<number, PersistenceSqlError | PersistenceDecodeError>;
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
    const entry = organizations.get(orgId);
    if (entry === undefined) return;
    const changed = entry.changed;
    entry.changed = Deferred.makeUnsafe<void>();
    yield* Deferred.succeed(changed, undefined);
  });

  const enqueue = Effect.fn("KinEventQueue.enqueue")(
    function* (input: KinEvent) {
      yield* validateEvent(input);
      if (
        input._tag === "github" &&
        input.dedupeKey !== null &&
        input.dedupeKey !== input.deliveryId
      ) {
        return yield* new KinEventQueueConflict({ orgId: input.orgId, eventId: input.eventId });
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const agents = yield* sql<{
            retired_at: string | null;
          }>`SELECT a.retired_at FROM kin_leads l
            JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
            WHERE l.org_id = ${input.orgId} AND l.agent_id = ${input.agentId}`;
          if (agents.length === 0)
            return yield* new KinEventQueueUnknownAgent({
              orgId: input.orgId,
              agentId: input.agentId,
            });
          if (agents[0]?.retired_at !== null)
            return yield* new KinEventQueueRetiredAgent({
              orgId: input.orgId,
              agentId: input.agentId,
            });
          const event = input._tag === "github" ? { ...input, dedupeKey: input.deliveryId } : input;
          let priority: "P0" | "P1" | "P2" | "P3" = "P2";
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
              AND EXISTS (SELECT 1 FROM kin_agents
                WHERE org_id = ${event.orgId} AND agent_id = ${event.agentId}
                  AND owner_person_id = ${event.provenance.personId} AND retired_at IS NULL)
              AND EXISTS (SELECT 1 FROM kin_chat_members
                WHERE org_id = ${event.orgId} AND chat_id = ${event.chatId}
                  AND principal_kind = 'agent' AND agent_id = ${event.agentId} AND left_at IS NULL)
          `;
                if (owners.length > 0) priority = "P0";
              }
              break;
          }
          const json = yield* encodeEvent(event);
          const now = yield* Clock.currentTimeMillis;
          const inserted = yield* sql`
      INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, dedupe_key, received_at, queued_at)
      VALUES (${event.eventId}, ${event.orgId}, ${event.agentId}, ${event._tag}, ${priority},
        ${json}, ${event.dedupeKey}, ${DateTime.toEpochMillis(event.receivedAt)}, ${now})
      ON CONFLICT DO NOTHING
      RETURNING event_id
    `;
          if (inserted.length > 0) {
            yield* sql.afterCommit(notify(event.orgId));
            return { event, duplicate: false };
          }
          const rows = yield* sql<{ json: string }>`SELECT json FROM kin_events
        WHERE org_id = ${event.orgId} AND (event_id = ${event.eventId}
          OR (dedupe_key IS NOT NULL AND dedupe_key = ${event.dedupeKey}))
        ORDER BY event_id`;
          let stored: KinEvent | undefined;
          for (const row of rows) {
            const candidate = yield* decodeEvent(row.json);
            if (
              candidate.eventId === event.eventId
                ? (yield* encodeEvent(candidate)) !== json
                : candidate.agentId !== event.agentId || candidate._tag !== event._tag
            ) {
              return yield* new KinEventQueueConflict({
                orgId: event.orgId,
                eventId: event.eventId,
              });
            }
            stored = candidate;
          }
          if (stored === undefined) {
            return yield* new KinEventQueueUnknownEvent({
              orgId: event.orgId,
              eventId: event.eventId,
            });
          }
          return { event: stored, duplicate: true };
        }),
      );
    },
    Effect.mapError((cause) =>
      isConflict(cause) || isUnknownEvent(cause) || isUnknownAgent(cause) || isRetiredAgent(cause)
        ? cause
        : toQueuePersistenceError("KinEventQueue.enqueue")(cause),
    ),
    Effect.uninterruptible,
  );

  const readiness = Effect.fn("KinEventQueue.readiness")(function* (
    input: Pick<ClaimInput, "orgId" | "agentId">,
    now: number,
  ) {
    const [window] = yield* sql<{
      first_at: number | null;
      last_at: number | null;
      urgent_at: number | null;
      deferred_at: number | null;
    }>`
      SELECT
        MIN(CASE WHEN COALESCE(not_before, queued_at) <= ${now} THEN queued_at END) AS first_at,
        MAX(CASE WHEN COALESCE(not_before, queued_at) <= ${now} THEN queued_at END) AS last_at,
        MIN(CASE WHEN priority = 'P0' AND COALESCE(not_before, queued_at) <= ${now}
          THEN queued_at END) AS urgent_at,
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
    return { readyAt, next: Math.min(readyAt, window?.deferred_at ?? Infinity) };
  });

  const claim = Effect.fn("KinEventQueue.claim")(
    function* (input: ClaimInput) {
      yield* decodeClaimInput(input);
      const entry = organization(input.orgId);
      return yield* Effect.acquireRelease(
        Effect.interruptible(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              while (true) {
                const changed = entry.changed;
                const now = yield* Clock.currentTimeMillis;
                const { readyAt, next } = yield* readiness(input, now);
                if (readyAt > now) {
                  yield* restore(
                    Number.isFinite(next)
                      ? Deferred.await(changed).pipe(
                          Effect.timeoutOrElse({ duration: next - now, orElse: () => Effect.void }),
                        )
                      : Deferred.await(changed),
                  );
                  continue;
                }
                yield* restore(entry.gate.take(1));
                const events = yield* sql
                  .withTransaction(
                    Effect.gen(function* () {
                      const now = yield* Clock.currentTimeMillis;
                      if ((yield* readiness(input, now)).readyAt > now)
                        return yield* new NoClaimableEvents({});
                      const collision =
                        yield* sql`SELECT 1 FROM kin_wakeups WHERE wakeup_id = ${input.wakeupId}`;
                      if (collision.length > 0)
                        return yield* new KinEventQueueWakeupConflict({
                          orgId: input.orgId,
                          wakeupId: input.wakeupId,
                        });
                      // Cross-process exclusion rests on idx_kin_wakeups_running_org.
                      const started = yield* sql`
                INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids)
                VALUES (${input.orgId}, ${input.wakeupId}, ${input.agentId}, ${input.model}, ${now}, 'running', '[]')
                ON CONFLICT (org_id) WHERE status = 'running' DO NOTHING RETURNING wakeup_id`;
                      if (started.length === 0)
                        return yield* new KinEventQueueBusy({ orgId: input.orgId });
                      const rows = yield* sql<{
                        json: string;
                        priority: string;
                        received_at: number;
                        event_id: string;
                      }>`
                UPDATE kin_events SET state = 'claimed', wakeup_id = ${input.wakeupId}, budget_deferred = 0
                WHERE org_id = ${input.orgId} AND event_id IN (
                  SELECT event_id FROM kin_events
                  WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND state = 'queued'
                    AND (not_before IS NULL OR not_before <= ${now})
                  ORDER BY priority, received_at, event_id LIMIT 50
                ) RETURNING json, priority, received_at, event_id`;
                      if (rows.length === 0) return yield* new NoClaimableEvents({});
                      const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
                      const ordered = rows.toSorted(
                        (a, b) =>
                          compare(a.priority, b.priority) ||
                          a.received_at - b.received_at ||
                          compare(a.event_id, b.event_id),
                      );
                      const events = yield* Effect.forEach(ordered, (row) => decodeEvent(row.json));
                      const eventIds = yield* encodeEventIds(events.map((event) => event.eventId));
                      yield* sql`UPDATE kin_wakeups SET event_ids = ${eventIds}
                WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId}`;
                      return events;
                    }),
                  )
                  .pipe(
                    Effect.onError(() => entry.gate.release(1)),
                    Effect.catchTags({ NoClaimableEvents: () => Effect.undefined }),
                  );
                if (events !== undefined) return events;
              }
            }),
          ),
        ),
        () => entry.gate.release(1),
      );
    },
    Effect.mapError((cause) =>
      isBusy(cause) || isWakeupConflict(cause)
        ? cause
        : toQueuePersistenceError("KinEventQueue.claim")(cause),
    ),
  );

  const release = Effect.fn("KinEventQueue.release")(
    function* (input: typeof ReleaseInput.Type) {
      yield* decodeReleaseInput(input);
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const notBefore = input.notBefore ?? now + 300_000;
          const ids =
            input.eventIds === undefined ? undefined : yield* encodeEventIds(input.eventIds);
          const rows = yield* sql<{ event_id: string; state: string }>`
          UPDATE kin_events SET attempts = attempts + ${input.countAttempt ? 1 : 0},
            state = CASE WHEN attempts + ${input.countAttempt ? 1 : 0} >= 3 THEN 'failed' ELSE 'queued' END,
            wakeup_id = NULL, not_before = ${notBefore}, budget_deferred = ${input.budgetDeferred === true ? 1 : 0}
          WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND state = 'claimed'
            AND (${ids ?? null} IS NULL OR event_id IN (SELECT value FROM json_each(${ids ?? null})))
            AND EXISTS (SELECT 1 FROM kin_wakeups WHERE org_id = ${input.orgId}
              AND wakeup_id = ${input.wakeupId} AND status = 'running')
          RETURNING event_id, state`;
          yield* sql`UPDATE kin_wakeups SET status = ${input.countAttempt ? "failed" : "released"}, ended_at = ${now}
          WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND status = 'running'
            AND NOT EXISTS (SELECT 1 FROM kin_events WHERE org_id = ${input.orgId}
              AND wakeup_id = ${input.wakeupId} AND state = 'claimed')`;
          return {
            released: rows.length,
            failedEventIds: rows
              .filter((row) => row.state === "failed")
              .map((row) => KinEventId.make(row.event_id))
              .sort(),
          };
        }),
      );
      if (result.released > 0) yield* notify(input.orgId);
      return result;
    },
    Effect.mapError(toQueuePersistenceError("KinEventQueue.release")),
    Effect.uninterruptible,
  );

  const finish = Effect.fn("KinEventQueue.finish")(
    function* (input: typeof FinishInput.Type) {
      yield* decodeFinishInput(input);
      const failedEventIds = yield* sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const closed =
            yield* sql`UPDATE kin_wakeups SET status = ${input.status}, ended_at = ${now}
          WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND status = 'running'
          RETURNING wakeup_id`;
          if (closed.length === 0) return [];
          if (input.status === "completed") {
            yield* sql`UPDATE kin_events SET state = 'done'
            WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND state = 'claimed'`;
          } else {
            const rows = yield* sql<{
              event_id: string;
              state: string;
            }>`UPDATE kin_events SET attempts = attempts + 1,
            state = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'queued' END,
            wakeup_id = NULL, not_before = ${now + 300_000}
            WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND state = 'claimed' RETURNING event_id, state`;
            return rows
              .filter((row) => row.state === "failed")
              .map((row) => KinEventId.make(row.event_id))
              .sort();
          }
          return [];
        }),
      );
      yield* notify(input.orgId);
      return { failedEventIds };
    },
    Effect.mapError(toQueuePersistenceError("KinEventQueue.finish")),
    Effect.uninterruptible,
  );

  const requeueUnfinished = Effect.fn("KinEventQueue.requeueUnfinished")(
    function* (orgId: KinOrgId, wakeupId: KinWakeupId) {
      yield* decodeOrgId(orgId);
      yield* decodeWakeupId(wakeupId);
      const count = yield* sql.withTransaction(
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
      );
      if (count > 0) yield* notify(orgId);
      return count;
    },
    Effect.mapError(toQueuePersistenceError("KinEventQueue.requeueUnfinished")),
  );

  const changes = Effect.fn("KinEventQueue.changes")((orgId: KinOrgId) =>
    Effect.sync(() => Deferred.await(organization(orgId).changed)),
  );
  const expireAgent = Effect.fn("KinEventQueue.expireAgent")(
    function* (orgId: KinOrgId, agentId: KinAgentId) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const leads =
            yield* sql`SELECT 1 FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
          if (leads.length === 0) return yield* new KinEventQueueUnknownAgent({ orgId, agentId });
          yield* sql`UPDATE kin_events SET state = 'expired' WHERE org_id = ${orgId} AND agent_id = ${agentId} AND state = 'queued'`;
        }),
      );
      yield* notify(orgId);
    },
    Effect.mapError((cause) =>
      isUnknownAgent(cause) ? cause : toQueuePersistenceError("KinEventQueue.expireAgent")(cause),
    ),
  );
  const nextReady = Effect.fn("KinEventQueue.nextReady")(
    function* (orgId: KinOrgId) {
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{ agent_id: string }>`SELECT e.agent_id
        FROM kin_events e JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
        WHERE e.org_id = ${orgId} AND e.state = 'queued' AND a.retired_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM kin_leads l
            WHERE l.org_id = e.org_id AND l.agent_id = e.agent_id AND (
              EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r
                WHERE r.thread_id = l.thread_id AND r.status IN ${sql.in(["queued", ...ACTIVE_RUN_STATUSES])})
              OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_turns t
                WHERE t.thread_id = l.thread_id AND t.completed_at IS NULL)
            )
          )
        GROUP BY e.agent_id ORDER BY e.agent_id`;
      const candidates = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const input = {
            orgId,
            agentId: KinAgentId.make(row.agent_id),
          };
          const window = yield* readiness(input, now);
          return {
            agentId: input.agentId,
            readyAt: Math.min(window.readyAt, window.next > now ? window.next : Infinity),
          };
        }),
      );
      return candidates.toSorted(
        (a, b) => a.readyAt - b.readyAt || a.agentId.localeCompare(b.agentId),
      )[0];
    },
    Effect.mapError(toQueuePersistenceError("KinEventQueue.nextReady")),
  );
  return KinEventQueue.of({
    reconsiderBudget: Effect.fn("KinEventQueue.reconsiderBudget")(function* (orgId) {
      yield* sql`UPDATE kin_events SET not_before = NULL, budget_deferred = 0
        WHERE org_id = ${orgId} AND state = 'queued' AND budget_deferred = 1`.pipe(
        Effect.mapError(toPersistenceSqlError("KinEventQueue.reconsiderBudget")),
      );
      yield* sql.afterCommit(notify(orgId));
    }),
    enqueue,
    claim,
    release,
    finish,
    requeueUnfinished,
    changes,
    expireAgent,
    nextReady,
  });
});

export const layer = Layer.effect(KinEventQueue, make);

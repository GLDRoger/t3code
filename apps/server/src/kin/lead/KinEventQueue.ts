import { ACTIVE_RUN_STATUSES } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  KinEvent,
  KinEventId,
  KinAgentId,
  KinChatId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { ownerLevelSql } from "../people/KinAccess.ts";
import { settleReviews } from "../github/askedFor.ts";
import * as Reach from "./Reach.ts";

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
  /**
   * A failure whose cause the server knows and is waiting out (`KinHostCare`): a start that showed
   * nothing goes back to the queue until then without spending an attempt, so nothing is lost.
   */
  holdUntil: Schema.optional(NonNegativeInt),
});

const SteerInput = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  wakeupId: KinWakeupId,
});

/**
 * An event's lane, the chat a wake-up answers: a message's, tap's or task's asking chat, else the
 * lead's owner chat. A due deferral from another chat, each GitHub trigger, each approved draft
 * and each follow-up woken for one person (`draftWake.ts`) get their own lane, so a level, a
 * stranger's text or one approval never mixes with anything else. From stored rows, not model text.
 */
const LANE_OF = `CASE WHEN e.tag = 'github' AND json_extract(e.json, '$.trigger.key') IS NOT NULL
  THEN 'github:' || json_extract(e.json, '$.trigger.key')
  WHEN e.tag = 'deferral.due' AND json_extract(e.json, '$.subject.approved') IS NOT NULL
  THEN 'approved:' || json_extract(e.json, '$.subject.questionId')
  WHEN e.tag IN ('chat.message', 'widget.action', 'chat.reaction')
  THEN json_extract(e.json, '$.chatId')
  WHEN e.tag IN ('record.changed', 'task.finished')
    AND json_extract(e.json, '$.chatId') IS NOT NULL
  THEN json_extract(e.json, '$.chatId')
  WHEN e.tag = 'pulse' AND json_extract(e.json, '$.chatId') IS NOT NULL
  THEN 'draft:' || json_extract(e.json, '$.chatId') || ':' || json_extract(e.json, '$.factKeys[0]')
  WHEN e.tag = 'deferral.due' AND json_extract(e.json, '$.origin.chatId') IS NOT NULL
  THEN 'origin:' || json_extract(e.json, '$.origin.agentId') || ':' || json_extract(e.json, '$.origin.chatId')
    || ':' || COALESCE(json_extract(e.json, '$.origin.personId'), '')
  ELSE l.owner_chat_id END`;

/**
 * Event `e` is the morning or weekly brief, whose turn ends as Kin's page (`KinReplyBridge`): it
 * never shares a turn with someone's message, so its reply is the page and nothing else.
 */
const MORNING_PAGE = `(e.tag = 'pulse'
  AND json_extract(e.json, '$.checkIn.scheduleId') IN ('checkin-morning', 'checkin-weekly'))`;

/** Who asked by event `e`: its stored message (a tap's own tap row) or the server's reaction. */
const STORED_AUTHOR = `LEFT JOIN kin_messages m ON m.org_id = e.org_id
  AND e.tag IN ('chat.message', 'widget.action') AND m.message_id = json_extract(e.json, '$.messageId')
  AND m.chat_id = json_extract(e.json, '$.chatId') AND m.author_kind = 'human'
  AND (m.kind = 'widget_action') = (e.tag = 'widget.action')`;
const AUTHOR_OF = `COALESCE(m.author_person_id,
  CASE WHEN e.tag = 'chat.reaction' THEN json_extract(e.json, '$.provenance.personId') END)`;

/** A person's message waits only for the rest of its burst, and never longer than the cap. */
/**
 * The lead row aliased `lead` has a turn going on its thread (a queued or active run, or an
 * unfinished provider turn) that no wake-up may claim into yet: the run T3 started for a finished
 * task is the one exception, and waits for the wake-up that takes it over.
 */
export const leadThreadBusy = (sql: SqlClient.SqlClient, lead: string) => {
  const thread = sql.literal(`${lead}.thread_id`);
  return sql`(EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r
        WHERE r.thread_id = ${thread} AND r.status IN ${sql.in(["queued", ...ACTIVE_RUN_STATUSES])})
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_turns t
        WHERE t.thread_id = ${thread} AND t.completed_at IS NULL))
    AND NOT EXISTS (SELECT 1 FROM kin_events f WHERE f.org_id = ${sql.literal(`${lead}.org_id`)}
      AND f.agent_id = ${sql.literal(`${lead}.agent_id`)} AND f.tag = 'task.finished'
      AND f.state = 'queued' AND json_extract(f.json, '$.threadId') = ${thread})`;
};

const OWNER_BURST_MS = 300;
const OWNER_WINDOW_MS = 2_000;

const decodeClaimInput = Schema.decodeEffect(ClaimInput);
const decodeSteerInput = Schema.decodeEffect(SteerInput);
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
  { orgId: KinOrgId, agentId: KinAgentId },
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
    /** `notBefore` holds a new event until then (a loose check-in's minute); a duplicate keeps its own. */
    readonly enqueue: (
      event: KinEvent,
      options?: { readonly notBefore?: number },
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
    /** Wakes the runner to look again, such as after an agent is resumed. */
    readonly nudge: (orgId: KinOrgId) => Effect.Effect<void>;
    readonly changes: (orgId: KinOrgId) => Effect.Effect<Effect.Effect<void>>;
    /** Ends when work is queued for an org no one awaits `changes` of yet: a brand-new company. */
    readonly unwatched: Effect.Effect<Effect.Effect<void>>;
    /** Every lead with queued events, earliest first; a lead is claimable once `readyAt` passes. */
    readonly readyLeads: (
      orgId: KinOrgId,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly agentId: KinAgentId; readonly readyAt: number }>,
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
      ReadonlyArray<KinEvent & { readonly priority: "P0" | "P1" | "P2" | "P3" }>,
      | PersistenceSqlError
      | PersistenceDecodeError
      | KinEventQueueBusy
      | KinEventQueueWakeupConflict,
      Scope.Scope
    >;
    /**
     * Claims queued human messages, card taps and soft reactions in a running wake-up's lane into that
     * wake-up, unchanged, so the runner can steer them into its live session.
     */
    readonly steer: (
      input: typeof SteerInput.Type,
    ) => Effect.Effect<
      ReadonlyArray<KinEvent & { readonly priority: "P0" | "P1" | "P2" | "P3" }>,
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly release: (
      input: typeof ReleaseInput.Type,
    ) => Effect.Effect<
      { readonly released: number; readonly failedEventIds: ReadonlyArray<KinEventId> },
      PersistenceSqlError | PersistenceDecodeError
    >;
    /**
     * A failed wake-up's events retry only when it showed nothing. Of the rest, `stranded`
     * had no reply (the chat is owed a notice) and `replied` were already answered; `retried`
     * counts requeued events, `retryInMs` the longest wait before one runs again, and
     * `failedEventIds` those that used their last try. `heldEventIds` are those `holdUntil` kept.
     */
    readonly finish: (input: typeof FinishInput.Type) => Effect.Effect<
      {
        readonly failedEventIds: ReadonlyArray<KinEventId>;
        readonly heldEventIds?: ReadonlyArray<KinEventId>;
        readonly stranded: number;
        readonly replied: number;
        readonly retried: number;
        readonly retryInMs: number;
      },
      PersistenceSqlError | PersistenceDecodeError
    >;
    /**
     * Runs these events now: held ones at once, and ones that used their last try with their tries
     * back (a person's Try again). Claimed or done ones are left alone. Returns how many moved.
     */
    readonly wake: (
      orgId: KinOrgId,
      eventIds: ReadonlyArray<KinEventId>,
    ) => Effect.Effect<number, PersistenceSqlError | PersistenceDecodeError>;
    // LEAD-5 startup recovery calls this only after confirming the provider run stopped.
    readonly requeueUnfinished: (
      orgId: KinOrgId,
      wakeupId: KinWakeupId,
    ) => Effect.Effect<number, PersistenceSqlError | PersistenceDecodeError>;
  }
>()("t3/kin/lead/KinEventQueue") {}

/**
 * A failed start that showed nothing retries soon, so the owner's "trying again" is true, and
 * once more a quarter of an hour on, so a provider down for minutes doesn't lose the request.
 */
export const FIRST_RETRY_MS = 15_000;
const LATER_RETRY_MS = 60_000;
export const LAST_RETRY_MS = 900_000;
const RUN_ATTEMPTS = 4;

/**
 * Every passed route to this agent whose wake-up expired, for any reason, settles as stale, and
 * the teammate is told once in the chat they asked it in. Claim and revoke both call it in their
 * own transaction, and the notice id is the event's, so together they still tell once.
 */
export const tellStaleRoutes = Effect.fn("KinEventQueue.tellStaleRoutes")(function* (
  deps: {
    readonly repo: Option.Option<KinChatRepository["Service"]>;
    readonly hub: Option.Option<KinChatHub["Service"]>;
  },
  orgId: KinOrgId,
  agentId: KinAgentId,
) {
  const sql = yield* SqlClient.SqlClient;
  const told = yield* sql<{ eventId: string; messageId: string }>`UPDATE kin_handoffs
    SET route_state = 'stale'
    WHERE org_id = ${orgId} AND to_agent_id = ${agentId} AND route_state = 'passed'
      AND EXISTS (SELECT 1 FROM kin_events e WHERE e.org_id = kin_handoffs.org_id
        AND e.event_id = kin_handoffs.event_id AND e.state = 'expired')
    RETURNING event_id AS "eventId", message_id AS "messageId"`;
  if (Option.isNone(deps.repo)) return;
  for (const row of told.toSorted((a, b) => (a.eventId < b.eventId ? -1 : 1))) {
    const [where] = yield* sql<{ chatId: string; name: string | null }>`SELECT
        m.chat_id AS "chatId", l.name FROM kin_messages m
      LEFT JOIN kin_leads l ON l.org_id = m.org_id AND l.agent_id = ${agentId}
      WHERE m.org_id = ${orgId} AND m.message_id = ${row.messageId}`;
    if (where === undefined) continue;
    const notice = yield* deps.repo.value
      .insertMessage({
        orgId,
        chatId: KinChatId.make(where.chatId),
        // Fixed words about their own request, said where they asked it.
        audience: "chat",
        messageId: KinMessageId.make(`kin-forward-stale:${row.eventId}`),
        author: { _tag: "system" },
        kind: "system",
        body: `The request passed on to ${where.name ?? "that agent"} was cancelled, so ${where.name ?? "that agent"} won't answer it.`,
        intent: null,
        mentions: [],
        replyTo: null,
        widgetId: null,
        floorRunId: null,
        status: "posted",
        sentBy: null,
        clientMessageId: null,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        editedAt: null,
      })
      .pipe(Effect.option);
    if (Option.isSome(notice) && Option.isSome(deps.hub))
      yield* sql.afterCommit(
        deps.hub.value.publish({ type: "message.posted", orgId, message: notice.value }),
      );
  }
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Effect.serviceOption(KinChatRepository);
  const hub = yield* Effect.serviceOption(KinChatHub);
  const settled = (orgId: KinOrgId, eventIds: ReadonlyArray<string>) =>
    settleReviews({ repo, hub }, orgId, eventIds).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  const laneOf = sql.literal(LANE_OF);
  const retryAlone = sql.literal("json_extract(e.json, '$._retryAlone') IS 1");
  const storedAuthor = sql.literal(STORED_AUTHOR);
  const authorOf = sql.literal(AUTHOR_OF);
  const organizations = new Map<KinOrgId, { changed: Deferred.Deferred<void> }>();
  // One running wake-up per lead: the in-process gate is keyed like the claim index.
  const gates = new Map<string, Semaphore.Semaphore>();

  const organization = (orgId: KinOrgId) => {
    const existing = organizations.get(orgId);
    if (existing !== undefined) return existing;
    const entry = { changed: Deferred.makeUnsafe<void>() };
    organizations.set(orgId, entry);
    return entry;
  };
  const gateFor = (orgId: KinOrgId, agentId: KinAgentId) => {
    const key = `${orgId}\u0000${agentId}`;
    const existing = gates.get(key);
    if (existing !== undefined) return existing;
    const gate = Semaphore.makeUnsafe(1);
    gates.set(key, gate);
    return gate;
  };

  let unwatchedWork = Deferred.makeUnsafe<void>();
  const notify = Effect.fn("KinEventQueue.notify")(function* (orgId: KinOrgId) {
    const entry = organizations.get(orgId);
    if (entry === undefined) {
      const signal = unwatchedWork;
      unwatchedWork = Deferred.makeUnsafe<void>();
      return yield* Deferred.succeed(signal, undefined);
    }
    const changed = entry.changed;
    entry.changed = Deferred.makeUnsafe<void>();
    yield* Deferred.succeed(changed, undefined);
  });

  const enqueue = Effect.fn("KinEventQueue.enqueue")(
    function* (input: KinEvent, options?: { readonly notBefore?: number }) {
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
            case "task.finished":
              priority = "P1";
              break;
            case "routine":
              if (event.routine === "owner_check") priority = "P3";
              break;
            case "watchdog":
              priority = "P3";
              break;
            case "chat.message":
            case "widget.action":
            case "chat.reaction":
              // The owner's request, passed on by another lead: it waits its turn as a due
              // reminder does, and never jumps the budget as the owner's own message would.
              if (event._tag === "chat.message" && event.origin !== undefined) priority = "P1";
              // A Team-room turn that must argue or end it goes ahead of a pitch-in, a chair
              // check or an objection, which are speak-or-pass checks.
              else if (
                event._tag === "chat.message" &&
                /^team:.*:(named|decider|closing)$/.test(event.dedupeKey ?? "")
              )
                priority = "P1";
              else if (event.provenance._tag === "human") {
                const owners = yield* sql`
            SELECT 1 FROM kin_chat_members
            WHERE org_id = ${event.orgId} AND chat_id = ${event.chatId}
              AND member_id = ${event.provenance.memberId} AND person_id = ${event.provenance.personId}
              AND principal_kind = 'person' AND left_at IS NULL
              AND EXISTS (SELECT 1 FROM kin_agents
                WHERE org_id = ${event.orgId} AND agent_id = ${event.agentId} AND retired_at IS NULL
                  AND ((kin_chat_members.role = 'owner'
                      AND owner_person_id = ${event.provenance.personId})
                    -- A co-owner's own direct chat is owner-level.
                    OR (kin_chat_members.role = 'member'
                      AND ${sql.literal(ownerLevelSql("kin_chat_members.org_id", "kin_chat_members.person_id"))}
                      AND EXISTS (SELECT 1 FROM kin_chats c WHERE c.org_id = ${event.orgId}
                        AND c.chat_id = ${event.chatId} AND c.kind = 'direct'))))
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
      INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, dedupe_key, received_at, queued_at, not_before)
      VALUES (${event.eventId}, ${event.orgId}, ${event.agentId}, ${event._tag}, ${priority},
        ${json}, ${event.dedupeKey}, ${DateTime.toEpochMillis(event.receivedAt)}, ${now},
        ${options?.notBefore !== undefined && options.notBefore > now ? options.notBefore : null})
      ON CONFLICT DO NOTHING
      RETURNING event_id
    `;
          if (inserted.length > 0) {
            // A new message brings forward a failed start still backing off in this chat.
            if (
              (event._tag === "chat.message" || event._tag === "widget.action") &&
              event.provenance._tag === "human"
            )
              yield* sql`UPDATE kin_events AS e SET not_before = NULL
                WHERE org_id = ${event.orgId} AND agent_id = ${event.agentId} AND state = 'queued'
                  AND (attempts > 0 OR ${retryAlone}) AND budget_deferred = 0 AND not_before > ${now}
                  AND tag IN ('chat.message', 'widget.action', 'chat.reaction')
                  AND json_extract(json, '$.chatId') = ${event.chatId}`;
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
        -- A finished task's run is already going, and a person is waiting on what they wrote:
        -- neither waits out the batch window. A person's place in the budget stays their priority.
        MIN(CASE WHEN (priority = 'P0' OR tag = 'task.finished'
            OR (tag IN ('chat.message', 'widget.action')
              AND json_extract(json, '$.provenance._tag') = 'human'))
          AND COALESCE(not_before, queued_at) <= ${now} THEN queued_at END) AS urgent_at,
        MIN(CASE WHEN not_before > ${now} THEN not_before END) AS deferred_at
      FROM kin_events
      WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND state = 'queued'
        AND EXISTS (SELECT 1 FROM kin_agents a WHERE a.org_id = kin_events.org_id
          AND a.agent_id = kin_events.agent_id AND a.retired_at IS NULL)
    `;
    const readyAt =
      window?.first_at != null && window.last_at !== null
        ? Math.min(
            window.last_at + 20_000,
            window.first_at + 120_000,
            window.urgent_at === null
              ? Infinity
              : Math.min(window.urgent_at + OWNER_WINDOW_MS, window.last_at + OWNER_BURST_MS),
          )
        : Infinity;
    return { readyAt, next: Math.min(readyAt, window?.deferred_at ?? Infinity) };
  });

  /**
   * A teammate's request Kin passed on (`routeCard.forward`) starts only while they may still
   * message the agent (`Reach`) and their own message still stands; otherwise it expires. One that expired
   * for any reason is told once, in the chat they asked it in.
   */
  const expireStaleRoutes = Effect.fn("KinEventQueue.expireStaleRoutes")(function* (
    orgId: KinOrgId,
    agentId: KinAgentId,
  ) {
    const queued = yield* sql<{ eventId: string; personId: string; live: number | null }>`SELECT
        e.event_id AS "eventId", json_extract(e.json, '$.origin.personId') AS "personId",
        (SELECT 1 FROM kin_messages o WHERE o.org_id = c.org_id
          AND o.message_id = json_extract(c.origin_json, '$.messageId')
          AND o.chat_id = json_extract(c.origin_json, '$.chatId') AND o.status = 'posted') AS live
      FROM kin_events e
      JOIN kin_messages c ON c.org_id = e.org_id
        AND c.message_id = json_extract(e.json, '$.messageId') AND c.origin_json IS NOT NULL
      WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND e.state = 'queued'
        AND e.tag = 'chat.message' AND json_extract(e.json, '$.origin.personId') IS NOT NULL
      ORDER BY e.event_id`;
    for (const row of queued) {
      const personId = KinPersonId.make(row.personId);
      if (
        row.live !== 1 ||
        !(yield* Reach.reaches(orgId, Reach.person(personId), Reach.agent(agentId)).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        ))
      )
        yield* sql`UPDATE kin_events SET state = 'expired'
          WHERE org_id = ${orgId} AND event_id = ${row.eventId} AND state = 'queued'`;
    }
    yield* tellStaleRoutes({ repo, hub }, orgId, agentId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  });

  const claim = Effect.fn("KinEventQueue.claim")(
    function* (input: ClaimInput) {
      yield* decodeClaimInput(input);
      const entry = organization(input.orgId);
      const gate = gateFor(input.orgId, input.agentId);
      return yield* Effect.acquireRelease(
        Effect.interruptible(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              while (true) {
                const changed = entry.changed;
                yield* sql.withTransaction(expireStaleRoutes(input.orgId, input.agentId));
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
                yield* restore(gate.take(1));
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
                      // Cross-process exclusion rests on idx_kin_wakeups_running_lead.
                      const started = yield* sql`
                INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids)
                VALUES (${input.orgId}, ${input.wakeupId}, ${input.agentId}, ${input.model}, ${now}, 'running', '[]')
                ON CONFLICT (org_id, agent_id) WHERE status = 'running' DO NOTHING RETURNING wakeup_id`;
                      if (started.length === 0)
                        return yield* new KinEventQueueBusy({
                          orgId: input.orgId,
                          agentId: input.agentId,
                        });
                      const rows = yield* sql<{
                        json: string;
                        priority: "P0" | "P1" | "P2" | "P3";
                        received_at: number;
                        queued_at: number;
                        event_id: string;
                      }>`
                WITH eligible AS (
                  SELECT e.event_id, e.priority, e.received_at, ${laneOf} AS lane,
                    ${retryAlone} AS solo, ${sql.literal(MORNING_PAGE)} AS page,
                    e.tag IN ('chat.message', 'widget.action', 'chat.reaction') AS asked,
                    MAX(e.queued_at, COALESCE(e.not_before, 0)) AS due
                  FROM kin_events e JOIN kin_leads l ON l.org_id = e.org_id AND l.agent_id = e.agent_id
                  -- Queued before a retirement, it never runs after it.
                  JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
                    AND a.retired_at IS NULL
                  WHERE e.org_id = ${input.orgId} AND e.agent_id = ${input.agentId} AND e.state = 'queued'
                    AND (e.not_before IS NULL OR e.not_before <= ${now})
                ), first AS (
                  SELECT event_id, lane, solo FROM eligible ORDER BY priority, received_at, event_id LIMIT 1
                ), selected AS (
                  SELECT e.* FROM eligible e JOIN first f
                    ON CASE WHEN f.solo THEN e.event_id = f.event_id ELSE e.lane = f.lane AND NOT e.solo END
                ), brief AS (
                  -- The morning page is a turn of its own. It waits for one turn on the messages
                  -- already waiting when it came due; then it runs, and later ones wait for it.
                  SELECT EXISTS (SELECT 1 FROM selected p WHERE p.page = 1
                    AND NOT EXISTS (SELECT 1 FROM selected h
                      WHERE h.asked = 1 AND h.received_at <= p.due)) AS alone
                )
                UPDATE kin_events SET state = 'claimed', wakeup_id = ${input.wakeupId}, budget_deferred = 0
                WHERE org_id = ${input.orgId} AND event_id IN (
                  SELECT event_id FROM selected o
                  WHERE CASE WHEN (SELECT alone FROM brief) THEN o.asked = 0 ELSE o.page IS NOT 1 END
                  ORDER BY priority, received_at, event_id LIMIT 50
                ) RETURNING json, priority, received_at, queued_at, event_id`;
                      if (rows.length === 0) return yield* new NoClaimableEvents({});
                      const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
                      const ordered = rows.toSorted(
                        (a, b) =>
                          compare(a.priority, b.priority) ||
                          a.received_at - b.received_at ||
                          compare(a.event_id, b.event_id),
                      );
                      const events = yield* Effect.forEach(ordered, (row) =>
                        decodeEvent(row.json).pipe(
                          Effect.map((event) => ({ ...event, priority: row.priority })),
                        ),
                      );
                      const eventIds = yield* encodeEventIds(events.map((event) => event.eventId));
                      const enqueuedAt = Math.min(...rows.map((row) => row.queued_at));
                      yield* sql`UPDATE kin_wakeups SET event_ids = ${eventIds}, enqueued_at = ${enqueuedAt}
                WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId}`;
                      return events;
                    }),
                  )
                  .pipe(
                    Effect.onError(() => gate.release(1)),
                    Effect.catchTags({ NoClaimableEvents: () => Effect.undefined }),
                  );
                if (events !== undefined) return events;
              }
            }),
          ),
        ),
        () => gate.release(1),
      );
    },
    Effect.mapError((cause) =>
      isBusy(cause) || isWakeupConflict(cause)
        ? cause
        : toQueuePersistenceError("KinEventQueue.claim")(cause),
    ),
  );

  const steer = Effect.fn("KinEventQueue.steer")(
    function* (input: typeof SteerInput.Type) {
      yield* decodeSteerInput(input);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          // The lane is the claimed events' (one per wake-up); human messages in it join. Authors
          // come from stored rows, as `KinLevels.askers` reads them: the owner's always join, and
          // anyone else's only once someone besides the owner asked this turn, so it already runs
          // at their level. Passed-on requests and messages no longer stored never join.
          const rows = yield* sql<{
            json: string;
            priority: "P0" | "P1" | "P2" | "P3";
            received_at: number;
            event_id: string;
          }>`
          WITH wakeup AS (
            SELECT w.org_id, w.agent_id, w.wakeup_id FROM kin_wakeups w
            WHERE w.org_id = ${input.orgId} AND w.agent_id = ${input.agentId}
              AND w.wakeup_id = ${input.wakeupId} AND w.status = 'running' AND w.run_id IS NOT NULL
              AND w.aborted_at IS NULL
              AND EXISTS (SELECT 1 FROM kin_agents a WHERE a.org_id = w.org_id
                AND a.agent_id = w.agent_id AND a.retired_at IS NULL)
              AND NOT EXISTS (SELECT 1 FROM kin_events e WHERE e.org_id = w.org_id
                AND e.wakeup_id = w.wakeup_id AND (${sql.literal(MORNING_PAGE)} OR ${retryAlone}))
          ), lane AS (
            SELECT ${laneOf} AS chat_id FROM wakeup w
            JOIN kin_events e ON e.org_id = w.org_id AND e.agent_id = w.agent_id AND e.wakeup_id = w.wakeup_id
            JOIN kin_leads l ON l.org_id = e.org_id AND l.agent_id = e.agent_id
            ORDER BY e.priority, e.received_at, e.event_id LIMIT 1
          ), owner AS (
            SELECT owner_person_id AS person_id FROM kin_agents
            WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId}
          ), others_asked AS (
            SELECT 1 FROM kin_events e ${storedAuthor}
            WHERE e.org_id = ${input.orgId} AND e.wakeup_id = ${input.wakeupId}
              AND e.tag IN ('chat.message', 'widget.action', 'chat.reaction')
              AND ${authorOf} <> (SELECT person_id FROM owner)
            LIMIT 1
          )
          UPDATE kin_events SET state = 'claimed', wakeup_id = ${input.wakeupId}, budget_deferred = 0
          WHERE org_id = ${input.orgId} AND event_id IN (
            SELECT e.event_id FROM kin_events e JOIN wakeup w ON w.org_id = e.org_id AND w.agent_id = e.agent_id
            ${storedAuthor}
            WHERE e.org_id = ${input.orgId} AND e.state = 'queued'
              AND NOT (${retryAlone})
              AND e.tag IN ('chat.message', 'widget.action', 'chat.reaction')
              AND json_extract(e.json, '$.provenance._tag') = 'human'
              AND json_extract(e.json, '$.chatId') = (SELECT chat_id FROM lane)
              AND json_extract(e.json, '$.origin') IS NULL
              AND (e.not_before IS NULL OR e.not_before <= ${now})
              AND (${authorOf} = (SELECT person_id FROM owner)
                OR (${authorOf} IS NOT NULL AND EXISTS (SELECT 1 FROM others_asked)))
            ORDER BY e.priority, e.received_at, e.event_id LIMIT 50
          ) RETURNING json, priority, received_at, event_id`;
          if (rows.length === 0) return [];
          const ordered = rows.toSorted(
            (a, b) => a.received_at - b.received_at || (a.event_id < b.event_id ? -1 : 1),
          );
          const events = yield* Effect.forEach(ordered, (row) =>
            decodeEvent(row.json).pipe(
              Effect.map((event) => ({ ...event, priority: row.priority })),
            ),
          );
          const added = yield* encodeEventIds(events.map((event) => event.eventId));
          yield* sql`UPDATE kin_wakeups SET event_ids = (
              SELECT json_group_array(value) FROM (
                SELECT value FROM json_each(event_ids) UNION ALL SELECT value FROM json_each(${added})))
            WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND status = 'running'`;
          return events;
        }),
      );
    },
    Effect.mapError(toQueuePersistenceError("KinEventQueue.steer")),
    Effect.uninterruptible,
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
            state = CASE WHEN replied_at IS NOT NULL THEN 'done'
              WHEN attempts + ${input.countAttempt ? 1 : 0} >= 3 THEN 'failed' ELSE 'queued' END,
            wakeup_id = CASE WHEN replied_at IS NULL THEN NULL ELSE wakeup_id END,
            not_before = ${notBefore}, budget_deferred = ${input.budgetDeferred === true ? 1 : 0}
          WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND state = 'claimed'
            AND (${ids ?? null} IS NULL OR event_id IN (SELECT value FROM json_each(${ids ?? null})))
            AND EXISTS (SELECT 1 FROM kin_wakeups WHERE org_id = ${input.orgId}
              AND wakeup_id = ${input.wakeupId} AND status = 'running')
          RETURNING event_id, state`;
          yield* settled(
            input.orgId,
            rows.filter((row) => row.state !== "queued").map((row) => row.event_id),
          );
          yield* sql`UPDATE kin_wakeups SET status = ${input.countAttempt ? "failed" : "released"}, ended_at = ${now}
          WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND status = 'running'
            AND NOT EXISTS (SELECT 1 FROM kin_events WHERE org_id = ${input.orgId}
              AND wakeup_id = ${input.wakeupId} AND state = 'claimed')`;
          return {
            released: rows.filter((row) => row.state !== "done").length,
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
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const none = { failedEventIds: [], stranded: 0, replied: 0, retried: 0, retryInMs: 0 };
          // Aborted for its audience (`abortChatTurns`): whatever it ran to, a fresh
          // wake-up answers its events, without spending an attempt or telling anyone.
          const requeued = yield* sql`UPDATE kin_wakeups SET status = 'released', ended_at = ${now}
            WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND status = 'running'
              AND aborted_at IS NOT NULL
            RETURNING wakeup_id`;
          if (requeued.length > 0) {
            yield* sql`UPDATE kin_events SET state = 'queued', wakeup_id = NULL, not_before = ${now}
              WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND state = 'claimed'`;
            return none;
          }
          // Read before the row closes; every subquery stays inside this wake-up's org.
          const [visible] =
            input.status === "completed"
              ? [undefined]
              : yield* sql`SELECT 1 FROM kin_wakeups w
            WHERE w.org_id = ${input.orgId} AND w.wakeup_id = ${input.wakeupId} AND w.status = 'running' AND (
              EXISTS (SELECT 1 FROM kin_messages m WHERE m.org_id = w.org_id AND m.author_kind = 'agent'
                AND m.author_agent_id = w.agent_id AND m.author_thread_id = w.thread_id
                AND m.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', w.started_at / 1000.0, 'unixepoch'))
              OR EXISTS (SELECT 1 FROM kin_lead_tool_calls c WHERE c.org_id = w.org_id
                AND c.wakeup_id = w.wakeup_id AND c.call_key != 'end')
              OR EXISTS (SELECT 1 FROM kin_pending_actions p WHERE p.org_id = w.org_id
                AND p.requested_by_agent_id = w.agent_id AND p.requested_by_thread_id = w.thread_id
                AND p.created_at >= w.started_at))
            ORDER BY w.wakeup_id LIMIT 1`;
          const closed =
            yield* sql`UPDATE kin_wakeups SET status = ${input.status}, ended_at = ${now}
          WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND status = 'running'
          RETURNING wakeup_id`;
          if (closed.length === 0) return none;
          // A review someone asked for is told how it ended, in this same step.
          const settle = (ended: ReadonlyArray<{ readonly event_id: string }>) =>
            settled(
              input.orgId,
              ended.map((row) => row.event_id),
            );
          if (input.status === "completed") {
            yield* settle(
              yield* sql<{ event_id: string }>`UPDATE kin_events SET state = 'done'
            WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND state = 'claimed'
            RETURNING event_id`,
            );
            return none;
          }
          if (visible !== undefined) {
            // A message whose reply posted is answered, whatever failed after.
            const rows = yield* sql<{
              event_id: string;
              replied: number;
            }>`UPDATE kin_events SET attempts = attempts + 1,
              state = CASE WHEN replied_at IS NULL THEN 'failed' ELSE 'done' END
            WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND state = 'claimed'
            RETURNING event_id, replied_at IS NOT NULL AS replied`;
            yield* settle(rows);
            const replied = rows.filter((row) => row.replied === 1).length;
            return {
              failedEventIds: [],
              stranded: rows.length - replied,
              replied,
              retried: 0,
              retryInMs: 0,
            };
          }
          if (input.holdUntil !== undefined) {
            const held = yield* sql<{ event_id: string }>`UPDATE kin_events
              SET state = 'queued', wakeup_id = NULL, not_before = ${input.holdUntil}
              WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND state = 'claimed'
              RETURNING event_id`;
            return {
              failedEventIds: [],
              heldEventIds: held.map((row) => KinEventId.make(row.event_id)).sort(),
              stranded: 0,
              replied: 0,
              retried: held.length,
              retryInMs: Math.max(0, input.holdUntil - now),
            };
          }
          // A silent batch failure cannot be attributed until each event runs on its own.
          const [batch] = yield* sql<{ split: number }>`SELECT EXISTS (
            SELECT 1 FROM kin_events WHERE org_id = ${input.orgId}
              AND wakeup_id = ${input.wakeupId} AND state = 'claimed' LIMIT 1 OFFSET 1
          ) AS split`;
          const split = batch?.split === 1;
          const rows = yield* sql<{
            event_id: string;
            state: string;
            not_before: number;
          }>`UPDATE kin_events SET attempts = attempts + ${split ? 0 : 1},
            state = CASE WHEN NOT ${split} AND attempts + 1 >= ${RUN_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
            json = CASE WHEN ${split} THEN json_set(json, '$._retryAlone', 1) ELSE json END,
            wakeup_id = NULL,
            not_before = ${now} + CASE WHEN ${split} OR attempts = 0 THEN ${FIRST_RETRY_MS}
              WHEN attempts = 1 THEN ${LATER_RETRY_MS} ELSE ${LAST_RETRY_MS} END
            WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND state = 'claimed' RETURNING event_id, state, not_before`;
          yield* settle(rows.filter((row) => row.state === "failed"));
          return {
            failedEventIds: rows
              .filter((row) => row.state === "failed")
              .map((row) => KinEventId.make(row.event_id))
              .sort(),
            stranded: 0,
            replied: 0,
            retried: rows.filter((row) => row.state === "queued").length,
            retryInMs: Math.max(
              0,
              ...rows.filter((row) => row.state === "queued").map((row) => row.not_before - now),
            ),
          };
        }),
      );
      yield* notify(input.orgId);
      return result;
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
          // A message whose reply already posted is done: it is never answered twice.
          yield* settled(
            orgId,
            (yield* sql<{ event_id: string }>`UPDATE kin_events SET state = 'done'
        WHERE wakeup_id = ${wakeupId} AND org_id = ${orgId} AND state = 'claimed'
          AND replied_at IS NOT NULL RETURNING event_id`).map((row) => row.event_id),
          );
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
  const unwatched = Effect.sync(() => Deferred.await(unwatchedWork));
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
  const readyLeads = Effect.fn("KinEventQueue.readyLeads")(
    function* (orgId: KinOrgId) {
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{ agent_id: string }>`SELECT e.agent_id
        FROM kin_events e JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
        WHERE e.org_id = ${orgId} AND e.state = 'queued' AND a.retired_at IS NULL
          AND a.paused_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM kin_leads l
            WHERE l.org_id = e.org_id AND l.agent_id = e.agent_id AND ${leadThreadBusy(sql, "l")})
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
      );
    },
    Effect.mapError(toQueuePersistenceError("KinEventQueue.readyLeads")),
  );
  const wake = Effect.fn("KinEventQueue.wake")(
    function* (orgId: KinOrgId, eventIds: ReadonlyArray<KinEventId>) {
      if (eventIds.length === 0) return 0;
      const ids = yield* encodeEventIds(eventIds);
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql`UPDATE kin_events SET state = 'queued', wakeup_id = NULL,
          not_before = ${now}, attempts = CASE WHEN state = 'failed' THEN 0 ELSE attempts END
        WHERE org_id = ${orgId} AND state IN ('queued', 'failed') AND budget_deferred = 0
          -- Already due: waking it again changes nothing, and counts nothing.
          AND (state = 'failed' OR not_before > ${now})
          AND event_id IN (SELECT value FROM json_each(${ids}))
        RETURNING event_id`;
      if (rows.length > 0) yield* notify(orgId);
      return rows.length;
    },
    Effect.mapError(toQueuePersistenceError("KinEventQueue.wake")),
  );

  return KinEventQueue.of({
    wake,
    reconsiderBudget: Effect.fn("KinEventQueue.reconsiderBudget")(function* (orgId) {
      yield* sql`UPDATE kin_events SET not_before = NULL, budget_deferred = 0
        WHERE org_id = ${orgId} AND state = 'queued' AND budget_deferred = 1`.pipe(
        Effect.mapError(toPersistenceSqlError("KinEventQueue.reconsiderBudget")),
      );
      yield* sql.afterCommit(notify(orgId));
    }),
    nudge: Effect.fn("KinEventQueue.nudge")(function* (orgId) {
      yield* notify(orgId);
    }),
    enqueue,
    claim,
    steer,
    release,
    finish,
    requeueUnfinished,
    changes,
    unwatched,
    expireAgent,
    readyLeads,
  });
});

export const layer = Layer.effect(KinEventQueue, make);

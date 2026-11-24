import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinEvent,
  KinMessageId,
  KinOrgState,
  ThreadId,
  type KinMessage,
  type KinOrgId,
  type KinOrgPauseInput,
  type KinOrgResumeInput,
  type KinLeadInterruptInput,
  type KinLeadInterruptResult,
  type KinWakeupId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  CommandId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { PersistenceSqlError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as Hub from "../chat/KinChatHub.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import * as Chat from "../chat/KinChatRepository.ts";
import { chatShared } from "../chat/sharing.ts";
import { KinPresence, syncQueued } from "../reply/KinPresence.ts";
import type * as Routines from "../triggers/routines.ts";
import { KinHostCare } from "../host/KinHostCare.ts";
import { checkLeadNoticeNow } from "../hostBackup.ts";
import { laneFor } from "../reply/replyLane.ts";
import * as Queue from "./KinEventQueue.ts";
import { hashedEventId } from "./eventIds.ts";
import { isOrgOwner, isOrgPaused, STOP_REASON } from "./orgState.ts";

/** A claim that races a pause returns its events for this long, so a paused org does not spin. */
export const PAUSE_POLL_INTERVAL_MS = 5_000;
/** Resume expires events queued longer ago than this instead of replaying them. */
const PAUSE_EXPIRY_MS = 24 * 60 * 60 * 1_000;
export const PAUSED_NOTICE = "Kin is paused. Nothing runs until you resume.";
const resumedNotice = (expired: number) =>
  expired === 0
    ? "Kin resumed."
    : `Kin resumed. ${expired} queued ${expired === 1 ? "event" : "events"} expired.`;
const EXPIRED_LISTED = 50;
const EXPIRED_IN_NOTICE = 10;
const noticeName = (value: string) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");

export class KinStopFanOutError extends Schema.TaggedError<KinStopFanOutError>()(
  "KinStopFanOutError",
  { orgId: Schema.String, cause: Schema.Defect() },
) {}
/** Interrupts work in the lead runtime, which owns the thread services the WS side cannot reach. */
export type KinStopFanOut = {
  readonly pause: (orgId: KinOrgId, pausedAt: number) => Effect.Effect<void, KinStopFanOutError>;
  readonly resume: (orgId: KinOrgId) => Effect.Effect<void>;
  /** Stops one running wake-up; false when it already ended. */
  readonly interrupt?: (
    orgId: KinOrgId,
    wakeupId: KinWakeupId,
  ) => Effect.Effect<boolean, KinStopFanOutError>;
  /** Stops a wake-up aborted for its audience, dropping its draft; its runner requeues its events. */
  readonly abort?: (orgId: KinOrgId, wakeupId: KinWakeupId) => Effect.Effect<void>;
};
type StopError = KinChatError | PersistenceSqlError;

const notFound = new KinChatError({ reason: "not_found", message: "Kin organization not found." });
const notAllowed = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner can stop or resume Kin.",
});
const invalid = new KinChatError({ reason: "invalid_state", message: "Invalid Kin stop data." });
const unavailable = new KinChatError({
  reason: "unavailable",
  message: "Kin is paused, but some running work could not be stopped. Try again.",
});
const isChatError = Schema.is(KinChatError);
const isPersistenceError = Schema.is(PersistenceSqlError);
const mapError = (cause: unknown): StopError =>
  isSqlError(cause)
    ? toPersistenceSqlError("KinStop")(cause)
    : isChatError(cause) || isPersistenceError(cause)
      ? cause
      : invalid;
const decodeState = Schema.decodeUnknownEffect(KinOrgState);
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

export class KinStop extends Context.Service<
  KinStop,
  {
    readonly isPaused: (orgId: KinOrgId) => Effect.Effect<boolean, PersistenceSqlError>;
    readonly view: (
      people: ReadonlyArray<PersonIdentity>,
      orgId: KinOrgId,
    ) => Effect.Effect<KinOrgState, StopError>;
    /** Owner only. Repeating a pause keeps the first pause and retries the fan-out. */
    readonly pause: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinOrgPauseInput,
    ) => Effect.Effect<KinOrgState, StopError>;
    /** Owner only. Resuming an org that is not paused changes nothing. */
    readonly resume: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinOrgResumeInput,
    ) => Effect.Effect<KinOrgState, StopError>;
    readonly attach: (fanOut: KinStopFanOut) => Effect.Effect<void, never, Scope.Scope>;
    /**
     * After the commit that marked them (`abortChatTurns`): stops each wake-up's run without
     * showing anything. Its events wait for a fresh wake-up; no person's authority is involved.
     */
    readonly abortTurns: (
      orgId: KinOrgId,
      wakeupIds: ReadonlyArray<KinWakeupId>,
    ) => Effect.Effect<void>;
    /** Owner only: the presence line's Stop on one wake-up. Its events are not retried. */
    readonly interrupt: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinLeadInterruptInput,
    ) => Effect.Effect<KinLeadInterruptResult, StopError>;
  }
>()("t3/kin/lead/KinStop") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const presence = yield* Effect.serviceOption(KinPresence);
  const queue = yield* Queue.KinEventQueue;
  const chat = yield* Chat.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
  let attached: KinStopFanOut | undefined;
  // Pause plus its fan-out and resume plus resumeAll run one at a time per org, so the last
  // routine write always matches the stop switch.
  const locks = new Map<KinOrgId, Semaphore.Semaphore>();
  const withOrgLock = <A, E, R>(orgId: KinOrgId, effect: Effect.Effect<A, E, R>) => {
    let lock = locks.get(orgId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(orgId, lock);
    }
    return lock.withPermits(1)(effect);
  };

  const state = Effect.fn("KinStop.state")(function* (orgId: KinOrgId) {
    const [row] = yield* sql<{
      paused: number;
      pausedAt: number | null;
      pausedBy: string | null;
      reason: string | null;
    }>`SELECT paused, paused_at AS "pausedAt", paused_by AS "pausedBy", reason
      FROM kin_org_state WHERE org_id = ${orgId} ORDER BY org_id`;
    return yield* decodeState(
      row === undefined || row.paused === 0 || row.pausedAt === null
        ? { orgId, paused: false, pausedAt: null, pausedBy: null, reason: null }
        : {
            orgId,
            paused: true,
            pausedAt: iso(row.pausedAt),
            pausedBy: row.pausedBy,
            reason: row.reason,
          },
    );
  });
  const member = Effect.fn("KinStop.member")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    const person = people.find((candidate) => candidate.orgId === orgId);
    if (person === undefined) return yield* notFound;
    const rows =
      yield* sql`SELECT 1 FROM kin_people WHERE org_id = ${orgId} AND person_id = ${person.personId} ORDER BY person_id`;
    if (rows.length === 0) return yield* notFound;
    return person;
  });
  const owner = Effect.fn("KinStop.owner")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    const person = yield* member(people, orgId);
    const allowed = yield* isOrgOwner(orgId, person.personId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    if (!allowed) return yield* notAllowed;
    return person;
  });
  const notice = Effect.fn("KinStop.notice")(function* (
    orgId: KinOrgId,
    now: number,
    kind: "pause" | "resume",
    body: string,
    privateBody = body,
  ) {
    const chats = yield* sql<{
      chatId: string;
    }>`SELECT DISTINCT l.owner_chat_id AS "chatId" FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id AND a.retired_at IS NULL
      WHERE l.org_id = ${orgId} ORDER BY l.owner_chat_id`;
    return yield* Effect.forEach(chats, (row) =>
      Effect.gen(function* () {
        const chatId = KinChatId.make(row.chatId);
        const showNames = body !== privateBody && !(yield* chatShared(sql, { orgId, chatId }));
        return yield* chat.insertMessage({
          orgId,
          chatId,
          audience: showNames ? "owner" : "chat",
          messageId: KinMessageId.make(`kin-${kind}:${now}:${row.chatId}`),
          author: { _tag: "system" },
          kind: "text",
          body: showNames ? privateBody : body,
          intent: null,
          mentions: [],
          replyTo: null,
          widgetId: null,
          floorRunId: null,
          status: "posted",
          sentBy: null,
          clientMessageId: null,
          createdAt: iso(now),
          editedAt: null,
        });
      }),
    );
  });

  const expiredNames = Effect.fn("KinStop.expiredNames")(function* (
    orgId: KinOrgId,
    ids: ReadonlyArray<string>,
  ) {
    if (ids.length === 0) return [];
    const names = yield* sql<{ chat: string; from: string }>`SELECT
        COALESCE(c.title, CASE c.kind WHEN 'direct' THEN l.name ELSE 'Group' END, 'Kin') AS chat,
        COALESCE(p.display_name, a.display_name, 'Kin') AS "from"
      FROM kin_events e
      LEFT JOIN kin_leads l ON l.org_id = e.org_id AND l.agent_id = e.agent_id
      LEFT JOIN kin_chats c ON c.org_id = e.org_id AND c.chat_id = COALESCE(
        json_extract(e.json, '$.origin.chatId'), json_extract(e.json, '$.chatId'), l.owner_chat_id)
      LEFT JOIN kin_messages m ON m.org_id = e.org_id AND m.chat_id = c.chat_id
        AND m.message_id = json_extract(e.json, '$.messageId')
      LEFT JOIN kin_people p ON p.org_id = e.org_id AND p.person_id = COALESCE(
        m.author_person_id, json_extract(e.json, '$.origin.personId'),
        json_extract(e.json, '$.provenance.personId'), json_extract(e.json, '$.askedBy'))
      LEFT JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = COALESCE(
        m.author_agent_id, json_extract(e.json, '$.provenance.agentId'))
      WHERE e.org_id = ${orgId} AND e.event_id IN ${sql.in(ids)}
      ORDER BY e.received_at, e.event_id`;
    return names.map((row) => `${noticeName(row.chat)} (from ${noticeName(row.from)})`);
  });

  /** Where a wake-up answers, and as whom, for the line saying it was stopped. */
  const stoppedLane = Effect.fn("KinStop.stoppedLane")(function* (
    orgId: KinOrgId,
    wakeupId: KinWakeupId,
  ) {
    const [wake] = yield* sql<{ agentId: string }>`SELECT agent_id AS "agentId" FROM kin_wakeups
      WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND status = 'running'
      ORDER BY wakeup_id`;
    if (wake === undefined) return yield* heldLane(orgId, wakeupId);
    const lane = yield* laneFor({ orgId, agentId: KinAgentId.make(wake.agentId), wakeupId }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    return Option.getOrUndefined(lane);
  });
  /** A turn a trouble holds has no running wake-up: its line goes where its first message asked. */
  const heldLane = Effect.fn("KinStop.heldLane")(function* (
    orgId: KinOrgId,
    wakeupId: KinWakeupId,
  ) {
    const [held] = yield* sql<{ chatId: string | null; leadName: string }>`
      SELECT COALESCE(json_extract(e.json, '$.chatId'), l.owner_chat_id) AS "chatId",
        l.name AS "leadName"
      FROM kin_events e JOIN kin_leads l ON l.org_id = e.org_id AND l.agent_id = e.agent_id
      WHERE e.org_id = ${orgId} AND e.state = 'queued'
        AND json_extract(e.json, '$._heldFrom') = ${wakeupId}
      ORDER BY e.priority, e.received_at, e.event_id LIMIT 1`;
    return held === undefined || held.chatId === null
      ? undefined
      : { chatId: KinChatId.make(held.chatId), leadName: held.leadName };
  });
  /** One quiet line where the stopped turn would have answered: who stopped which agent. */
  const tellStopped = Effect.fn("KinStop.tellStopped")(function* (
    orgId: KinOrgId,
    wakeupId: KinWakeupId,
    lane: { readonly chatId: KinChatId; readonly leadName: string },
    person: PersonIdentity,
  ) {
    const [who] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
      WHERE org_id = ${orgId} AND person_id = ${person.personId} ORDER BY person_id`;
    if (who === undefined) return;
    const message = yield* chat.insertMessage({
      orgId,
      chatId: lane.chatId,
      audience: "chat",
      messageId: KinMessageId.make(`kin-stopped:${wakeupId}`),
      author: { _tag: "system" },
      kind: "text",
      body: `${who.name} stopped ${lane.leadName}.`,
      intent: null,
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: iso(yield* Clock.currentTimeMillis),
      editedAt: null,
    });
    yield* publish(orgId, [message]);
  });

  const fanOut = Effect.fn("KinStop.fanOut")(function* (orgId: KinOrgId, pausedAt: number) {
    if (attached === undefined) return;
    yield* attached.pause(orgId, pausedAt).pipe(
      Effect.tapCause((cause) => Effect.logError("Kin stop fan-out failed", { orgId, cause })),
      Effect.mapError(() => unavailable),
    );
  });

  const publish = Effect.fn("KinStop.publish")(function* (
    orgId: KinOrgId,
    messages: ReadonlyArray<KinMessage>,
  ) {
    for (const message of messages) yield* hub.publish({ type: "message.posted", orgId, message });
  });

  const pause = Effect.fn("KinStop.pause")(function* (
    people: ReadonlyArray<PersonIdentity>,
    input: KinOrgPauseInput,
  ) {
    return yield* withOrgLock(input.orgId, pauseLocked(people, input));
  }, Effect.mapError(mapError));
  const pauseLocked = Effect.fn("KinStop.pauseLocked")(function* (
    people: ReadonlyArray<PersonIdentity>,
    input: KinOrgPauseInput,
  ) {
    const result = yield* sql.withTransaction(
      Effect.gen(function* () {
        const person = yield* owner(people, input.orgId);
        const now = yield* Clock.currentTimeMillis;
        const reason = input.reason ?? null;
        const inserted =
          yield* sql`INSERT INTO kin_org_state (org_id, paused, paused_at, paused_by, reason)
            VALUES (${input.orgId}, 1, ${now}, ${person.personId}, ${reason})
            ON CONFLICT DO NOTHING RETURNING org_id`;
        const changed =
          inserted.length > 0
            ? inserted
            : yield* sql`UPDATE kin_org_state SET stop_managed = 1, paused = 1, paused_at = ${now},
                paused_by = ${person.personId}, reason = ${reason}
              WHERE org_id = ${input.orgId} AND paused = 0 RETURNING org_id`;
        if (changed.length > 0) yield* (yield* KinRefreshObserver).touch(input.orgId, "stop");
        const messages: ReadonlyArray<KinMessage> =
          changed.length === 0 ? [] : yield* notice(input.orgId, now, "pause", PAUSED_NOTICE);
        return { state: yield* state(input.orgId), messages };
      }),
    );
    yield* publish(input.orgId, result.messages);
    yield* checkLeadNoticeNow(input.orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    if (result.state.paused)
      yield* fanOut(
        input.orgId,
        DateTime.toEpochMillis(DateTime.makeUnsafe(result.state.pausedAt)),
      );
    return result.state;
  });

  const resume = Effect.fn("KinStop.resume")(function* (
    people: ReadonlyArray<PersonIdentity>,
    input: KinOrgResumeInput,
  ) {
    return yield* withOrgLock(input.orgId, resumeLocked(people, input));
  }, Effect.mapError(mapError));
  const resumeLocked = Effect.fn("KinStop.resumeLocked")(function* (
    people: ReadonlyArray<PersonIdentity>,
    input: KinOrgResumeInput,
  ) {
    const resumed = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* owner(people, input.orgId);
        const [cleared] = yield* sql<{ pausedAt: number }>`SELECT paused_at AS "pausedAt"
          FROM kin_org_state WHERE org_id = ${input.orgId} AND paused = 1 ORDER BY org_id`;
        if (cleared === undefined) return undefined;
        yield* sql`UPDATE kin_org_state SET paused = 0, paused_at = NULL, paused_by = NULL, reason = NULL
          WHERE org_id = ${input.orgId} AND paused = 1`;
        yield* (yield* KinRefreshObserver).touch(input.orgId, "stop");
        const now = yield* Clock.currentTimeMillis;
        const expiredRows = yield* sql<{
          eventId: string;
          agentId: string;
          tag: string;
          receivedAt: number;
        }>`UPDATE kin_events AS e SET state = 'expired'
          WHERE org_id = ${input.orgId} AND state = 'queued' AND queued_at <= ${now - PAUSE_EXPIRY_MS}
            AND NOT (e.tag = 'chat.message' AND EXISTS (
              SELECT 1 FROM kin_messages m
              JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
                AND c.kind = 'direct' AND c.archived_at IS NULL
              JOIN kin_chat_members cm ON cm.org_id = c.org_id AND cm.chat_id = c.chat_id
                AND cm.principal_kind = 'agent' AND cm.agent_id = e.agent_id AND cm.left_at IS NULL
              WHERE m.org_id = e.org_id AND m.message_id = json_extract(e.json, '$.messageId')
                AND m.chat_id = json_extract(e.json, '$.chatId')
                AND m.author_kind = 'human' AND m.kind = 'text' AND m.status = 'posted'
                AND m.origin_json IS NULL
                AND NOT EXISTS (SELECT 1 FROM kin_messages r
                  WHERE r.org_id = m.org_id AND r.chat_id = m.chat_id AND r.seq > m.seq
                    AND r.author_kind = 'agent' AND r.author_agent_id = e.agent_id
                    AND r.status = 'posted' AND r.relay_json IS NULL
                    AND (r.reply_to IS NULL OR r.reply_to = m.message_id))))
          RETURNING event_id AS "eventId", agent_id AS "agentId", tag, received_at AS "receivedAt"`;
        const expired = expiredRows.toSorted(
          (a, b) =>
            a.receivedAt - b.receivedAt ||
            (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
        );
        const leads = yield* sql<{
          agentId: string;
        }>`SELECT l.agent_id AS "agentId" FROM kin_leads l
          JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
          WHERE l.org_id = ${input.orgId} AND a.retired_at IS NULL ORDER BY l.agent_id`;
        for (const lead of leads) {
          const mine = expired.filter((row) => row.agentId === lead.agentId);
          const dedupeKey = `resume:${cleared.pausedAt}:${lead.agentId}`;
          const eventId = hashedEventId("resume", dedupeKey);
          yield* queue.enqueue(
            yield* decodeEvent({
              _tag: "resume",
              orgId: input.orgId,
              agentId: lead.agentId,
              eventId,
              receivedAt: iso(now),
              dedupeKey,
              provenance: { _tag: "system" },
              pausedAt: iso(cleared.pausedAt),
              expired: {
                count: mine.length,
                events: mine.slice(0, EXPIRED_LISTED).map((row) => ({
                  eventId: row.eventId,
                  tag: row.tag,
                  receivedAt: iso(row.receivedAt),
                })),
              },
            }),
          );
        }
        const body = resumedNotice(expired.length);
        const names = yield* expiredNames(
          input.orgId,
          expired.slice(0, EXPIRED_IN_NOTICE).map((row) => row.eventId),
        );
        const more = expired.length - names.length;
        if (more > 0) names.push(`and ${more} more`);
        return yield* notice(input.orgId, now, "resume", body, [body, ...names].join("\n"));
      }),
    );
    if (resumed !== undefined) {
      yield* publish(input.orgId, resumed);
      // Messages the pause expired no longer wait, so their working line goes too.
      if (Option.isSome(presence))
        for (const lead of yield* sql<{ agentId: string }>`SELECT agent_id AS "agentId"
          FROM kin_leads WHERE org_id = ${input.orgId} ORDER BY agent_id`)
          yield* syncQueued(presence.value, input.orgId, KinAgentId.make(lead.agentId)).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
      if (attached !== undefined) yield* attached.resume(input.orgId);
      yield* checkLeadNoticeNow(input.orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    }
    return yield* state(input.orgId);
  });

  return KinStop.of({
    isPaused: Effect.fn("KinStop.isPaused")((orgId) =>
      isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    ),
    view: Effect.fn("KinStop.view")(function* (people, orgId) {
      const person = yield* member(people, orgId);
      const current = yield* state(orgId);
      // Any member sees whether Kin is stopped; why, in the owner's words, is his.
      const ownsOrg = yield* isOrgOwner(orgId, person.personId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      return ownsOrg || current.reason === null ? current : { ...current, reason: null };
    }, Effect.mapError(mapError)),
    pause,
    resume,
    abortTurns: Effect.fn("KinStop.abortTurns")(function* (orgId, wakeupIds) {
      const abort = attached?.abort;
      // Without the lead runtime nothing runs them; its recovery finds the mark.
      if (abort === undefined) return;
      yield* Effect.forEach(
        wakeupIds,
        (wakeupId) =>
          abort(orgId, wakeupId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Kin could not stop an aborted wake-up", {
                orgId,
                wakeupId,
                cause,
              }),
            ),
          ),
        { discard: true },
      );
    }),
    interrupt: Effect.fn("KinStop.interrupt")(function* (people, input) {
      const person = yield* owner(people, input.orgId);
      if (attached?.interrupt === undefined) return yield* unavailable;
      // Read before the stop marks the wake-up's events done.
      const lane = yield* stoppedLane(input.orgId, input.wakeupId);
      const interrupted = yield* attached
        .interrupt(input.orgId, input.wakeupId)
        .pipe(Effect.mapError(() => unavailable));
      if (interrupted && lane !== undefined)
        yield* tellStopped(input.orgId, input.wakeupId, lane, person).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Kin stop line failed", { cause })),
        );
      return { interrupted };
    }, Effect.mapError(mapError)),
    attach: Effect.fn("KinStop.attach")(function* (next) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          attached = next;
        }),
        () =>
          Effect.sync(() => {
            if (attached === next) attached = undefined;
          }),
      );
      // A pause from before a restart still owes its fan-out to work recovered since, and a
      // resume that ran detached or failed its resumeAll still owes the routines theirs.
      const orgs = yield* sql<{
        orgId: KinOrgId;
        // Startup scan across orgs on purpose; each org is then handled under its own lock.
      }>`SELECT org_id AS "orgId" FROM kin_org_state WHERE stop_managed = 1 ORDER BY org_id`.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Kin stop catch-up unavailable", { cause }).pipe(Effect.as([])),
        ),
      );
      for (const { orgId } of orgs)
        yield* withOrgLock(
          orgId,
          Effect.gen(function* () {
            const current = yield* state(orgId);
            if (current.pausedAt !== null)
              yield* fanOut(orgId, DateTime.toEpochMillis(current.pausedAt)).pipe(Effect.ignore);
            else yield* next.resume(orgId);
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Kin stop catch-up failed", { orgId, cause }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(KinStop, make);

const isLive = (run: OrchestrationV2Run) =>
  run.status === "queued" || ThreadManagement.isActiveRun(run);
type ThreadRuns = Pick<OrchestrationV2ThreadProjection, "thread" | "runs">;
const liveRun = (projection: ThreadRuns) => projection.runs.findLast(isLive);
/** Interrupts the thread's live run and stops its delegated tasks; true when a run was live. */
const stopThreadTree = Effect.fn("KinStop.stopThreadTree")(function* (
  threads: ThreadManagement.ThreadManagementService["Service"],
  input: {
    readonly projection: ThreadRuns;
    readonly prefix: string;
    readonly tag: string;
    readonly reason: string;
  },
) {
  const { projection, prefix, tag, reason } = input;
  const active = liveRun(projection);
  if (active !== undefined)
    yield* threads.interruptThread({
      projectId: projection.thread.projectId,
      threadId: projection.thread.id,
      runId: active.id,
      commandId: CommandId.make(`${prefix}:${tag}`),
      reason,
    });
  yield* threads.stopDelegatedTasks({
    threadId: projection.thread.id,
    commandId: CommandId.make(`${prefix}-tasks:${tag}`),
    reason,
  });
  return active !== undefined;
});

const isMissingThread = (error: { readonly _tag: string; readonly cause?: unknown }) =>
  error._tag === "OrchestratorProjectionError" &&
  typeof error.cause === "object" &&
  error.cause !== null &&
  (error.cause as { readonly _tag?: unknown })._tag === "ProjectionStoreThreadNotFoundError";

/** The lead runtime's fan-out: agent and dream runs and their delegated tasks, then routines. */
export const makeFanOut = Effect.fn("KinStop.makeFanOut")(function* (
  routines: Option.Option<Routines.KinRoutines["Service"]>,
) {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const queue = yield* Queue.KinEventQueue;
  const care = yield* Effect.serviceOption(KinHostCare);
  // Recovery keeps run ids across a restart, so a replay must not dedupe on a pre-crash receipt.
  const boot = (yield* Random.nextInt).toString(36);
  return {
    pause: Effect.fn("KinStop.fanOut.pause")(function* (orgId: KinOrgId, pausedAt: number) {
      const failed = (cause: unknown) => new KinStopFanOutError({ orgId, cause });
      // Routines and agent runs stop side by side.
      const routinesPaused = Option.isSome(routines)
        ? Effect.exit(routines.value.pauseAll(orgId))
        : Effect.succeed(Exit.void);
      const leadsStopped = Effect.gen(function* () {
        const rows = yield* sql<{ threadId: string }>`
          SELECT thread_id AS "threadId" FROM kin_leads WHERE org_id = ${orgId} AND thread_id IS NOT NULL
          UNION SELECT thread_id FROM kin_dream_runs
            WHERE org_id = ${orgId} AND status = 'running' AND thread_id IS NOT NULL
          UNION SELECT thread_id FROM kin_agent_threads WHERE org_id = ${orgId} AND ended_at IS NULL
          ORDER BY 1`.pipe(Effect.mapError(failed), Effect.exit);
        if (Exit.isFailure(rows)) return [rows];
        return yield* Effect.forEach(
          rows.value,
          (row) =>
            Effect.gen(function* () {
              const threadId = ThreadId.make(row.threadId);
              // A thread that doesn't exist yet has nothing to stop; any other failure counts.
              const projection = yield* threads.getThreadProjection(threadId).pipe(
                Effect.asSome,
                Effect.catchIf(isMissingThread, () => Effect.succeedNone),
              );
              if (Option.isNone(projection)) return;
              const run = projection.value.runs.at(-1)?.id ?? "idle";
              yield* stopThreadTree(threads, {
                projection: projection.value,
                prefix: "kin-stop",
                tag: `${threadId}:${pausedAt}:${run}:${boot}`,
                reason: STOP_REASON,
              });
            }).pipe(Effect.exit),
          { concurrency: "unbounded" },
        );
      });
      const [routineExit, leadExits] = yield* Effect.all([routinesPaused, leadsStopped], {
        concurrency: "unbounded",
      });
      const failures: Array<Cause.Cause<unknown>> = [];
      const exits: ReadonlyArray<Exit.Exit<unknown, unknown>> = [routineExit, ...leadExits];
      for (const exit of exits) if (Exit.isFailure(exit)) failures.push(exit.cause);
      if (failures.length > 0)
        return yield* failed(failures.reduce((all, cause) => Cause.combine(all, cause)));
    }),
    interrupt: Effect.fn("KinStop.fanOut.interrupt")(function* (
      orgId: KinOrgId,
      wakeupId: KinWakeupId,
    ) {
      const failed = (cause: unknown) => new KinStopFanOutError({ orgId, cause });
      const [row] = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId" FROM kin_wakeups
        WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND status = 'running'
          AND thread_id IS NOT NULL ORDER BY wakeup_id`.pipe(Effect.mapError(failed));
      if (row === undefined) {
        // Not running: a turn a trouble holds for later is dropped instead, and its notice redrawn.
        const dropped = yield* queue.dropHeld(orgId, wakeupId).pipe(Effect.mapError(failed));
        if (dropped > 0 && Option.isSome(care)) yield* care.value.refresh(orgId);
        return dropped > 0;
      }
      // The owner chose to stop: the run's failure must not requeue its events. A stop that
      // finds none left is a repeat of one still winding the run down.
      const released = yield* sql`UPDATE kin_events SET state = 'done'
        WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND state = 'claimed'
        RETURNING event_id`.pipe(Effect.mapError(failed));
      if (released.length === 0) return false;
      const threadId = ThreadId.make(row.threadId);
      const projection = yield* threads.getThreadProjection(threadId).pipe(Effect.mapError(failed));
      const run = projection.runs.at(-1);
      if (run === undefined) return false;
      yield* threads
        .interruptThread({
          projectId: projection.thread.projectId,
          threadId,
          runId: run.id,
          commandId: CommandId.make(`kin-owner-stop:${wakeupId}:${run.id}`),
        })
        .pipe(Effect.mapError(failed));
      return true;
    }),
    resume: Effect.fn("KinStop.fanOut.resume")(function* (orgId: KinOrgId) {
      if (Option.isSome(routines))
        yield* routines.value
          .resumeAll(orgId)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Kin routines could not resume", { orgId, cause }),
            ),
          );
    }),
  } satisfies KinStopFanOut;
});

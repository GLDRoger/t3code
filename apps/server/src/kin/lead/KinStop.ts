import {
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
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import * as Chat from "../chat/KinChatRepository.ts";
import type * as Routines from "../triggers/routines.ts";
import * as Queue from "./KinEventQueue.ts";
import { isOrgOwner, isOrgPaused, STOP_REASON } from "./orgState.ts";
import { stopThreadTree } from "./Workers.ts";

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

export class KinStopFanOutError extends Schema.TaggedError<KinStopFanOutError>()(
  "KinStopFanOutError",
  { orgId: Schema.String, cause: Schema.Defect() },
) {}
/** Interrupts work in the lead runtime, which owns the thread services the WS side cannot reach. */
export type KinStopFanOut = {
  readonly pause: (orgId: KinOrgId, pausedAt: number) => Effect.Effect<void, KinStopFanOutError>;
  readonly resume: (orgId: KinOrgId) => Effect.Effect<void>;
};
type StopError = KinChatError | PersistenceSqlError;

const notFound = new KinChatError({ reason: "not_found", message: "Kin organization not found." });
const notAllowed = new KinChatError({
  reason: "not_allowed",
  message: "Only the organization owner can stop or resume Kin.",
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
  }
>()("t3/kin/lead/KinStop") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
  ) {
    const chats = yield* sql<{
      chatId: string;
    }>`SELECT DISTINCT owner_chat_id AS "chatId" FROM kin_leads WHERE org_id = ${orgId} ORDER BY owner_chat_id`;
    return yield* Effect.forEach(chats, (row) =>
      chat.insertMessage({
        orgId,
        chatId: KinChatId.make(row.chatId),
        messageId: KinMessageId.make(`kin-${kind}:${now}:${row.chatId}`),
        author: { _tag: "system" },
        kind: "text",
        body,
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
      }),
    );
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
            : yield* sql`UPDATE kin_org_state SET paused = 1, paused_at = ${now},
                paused_by = ${person.personId}, reason = ${reason}
              WHERE org_id = ${input.orgId} AND paused = 0 RETURNING org_id`;
        const messages: ReadonlyArray<KinMessage> =
          changed.length === 0 ? [] : yield* notice(input.orgId, now, "pause", PAUSED_NOTICE);
        return { state: yield* state(input.orgId), messages };
      }),
    );
    yield* publish(input.orgId, result.messages);
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
        const now = yield* Clock.currentTimeMillis;
        const expired = yield* sql<{
          eventId: string;
          agentId: string;
          tag: string;
          receivedAt: number;
        }>`UPDATE kin_events SET state = 'expired'
          WHERE org_id = ${input.orgId} AND state = 'queued' AND queued_at <= ${now - PAUSE_EXPIRY_MS}
          RETURNING event_id AS "eventId", agent_id AS "agentId", tag, received_at AS "receivedAt"`;
        const leads = yield* sql<{
          agentId: string;
        }>`SELECT l.agent_id AS "agentId" FROM kin_leads l
          JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
          WHERE l.org_id = ${input.orgId} AND a.retired_at IS NULL ORDER BY l.agent_id`;
        for (const lead of leads) {
          const mine = expired
            .filter((row) => row.agentId === lead.agentId)
            .toSorted(
              (a, b) =>
                a.receivedAt - b.receivedAt ||
                (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
            );
          const eventId = `resume:${cleared.pausedAt}:${lead.agentId}`;
          yield* queue.enqueue(
            yield* decodeEvent({
              _tag: "resume",
              orgId: input.orgId,
              agentId: lead.agentId,
              eventId,
              receivedAt: iso(now),
              dedupeKey: eventId,
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
        return yield* notice(input.orgId, now, "resume", resumedNotice(expired.length));
      }),
    );
    if (resumed !== undefined) {
      yield* publish(input.orgId, resumed);
      if (attached !== undefined) yield* attached.resume(input.orgId);
    }
    return yield* state(input.orgId);
  });

  return KinStop.of({
    isPaused: Effect.fn("KinStop.isPaused")((orgId) =>
      isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    ),
    view: Effect.fn("KinStop.view")(function* (people, orgId) {
      yield* member(people, orgId);
      return yield* state(orgId);
    }, Effect.mapError(mapError)),
    pause,
    resume,
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
      }>`SELECT org_id AS "orgId" FROM kin_org_state ORDER BY org_id`.pipe(
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

/** The lead runtime's fan-out: lead, worker and dream runs and their delegated tasks, then routines. */
const isMissingThread = (error: { readonly _tag: string; readonly cause?: unknown }) =>
  error._tag === "OrchestratorProjectionError" &&
  typeof error.cause === "object" &&
  error.cause !== null &&
  (error.cause as { readonly _tag?: unknown })._tag === "ProjectionStoreThreadNotFoundError";

export const makeFanOut = Effect.fn("KinStop.makeFanOut")(function* (
  routines: Option.Option<Routines.KinRoutines["Service"]>,
) {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // Recovery keeps run ids across a restart, so a replay must not dedupe on a pre-crash receipt.
  const boot = (yield* Random.nextInt).toString(36);
  return {
    pause: Effect.fn("KinStop.fanOut.pause")(function* (orgId: KinOrgId, pausedAt: number) {
      const failed = (cause: unknown) => new KinStopFanOutError({ orgId, cause });
      const rows = yield* sql<{ threadId: string }>`
        SELECT thread_id AS "threadId" FROM kin_leads WHERE org_id = ${orgId} AND thread_id IS NOT NULL
        UNION SELECT thread_id FROM kin_workers WHERE org_id = ${orgId} AND ended_at IS NULL
        UNION SELECT thread_id FROM kin_dream_runs
          WHERE org_id = ${orgId} AND status = 'running' AND thread_id IS NOT NULL
        ORDER BY 1`.pipe(Effect.mapError(failed), Effect.exit);
      const exits = yield* Effect.forEach(
        Exit.isSuccess(rows) ? rows.value : [],
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
      const routineExit = Option.isSome(routines)
        ? yield* Effect.exit(routines.value.pauseAll(orgId))
        : Exit.void;
      const failures: Array<Cause.Cause<unknown>> = [];
      if (Exit.isFailure(rows)) failures.push(rows.cause);
      for (const exit of exits) if (Exit.isFailure(exit)) failures.push(exit.cause);
      if (Exit.isFailure(routineExit)) failures.push(routineExit.cause);
      if (failures.length > 0)
        return yield* failed(failures.reduce((all, cause) => Cause.combine(all, cause)));
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

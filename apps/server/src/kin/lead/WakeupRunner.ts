// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous diagnostic hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  KinAgentId,
  KinEventId,
  type KinEvent,
  KinLead,
  KinMessageId,
  KinOrgId,
  type KinPersonId,
  KinWakeupId,
  MessageId,
  ModelSelection,
  NodeId,
  ProjectId,
  RunAttemptId,
  RunId,
  ThreadId,
  type TurnTokenUsage,
  kinCharacterSeat,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { noticeState } from "./TaskWake.ts";
import * as KinIdentity from "../chat/KinIdentity.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import * as HostBackup from "../hostBackup.ts";
import { ServerConfig } from "../../config.ts";
import * as Floor from "../floor/KinFloor.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as Memory from "../memory/Memory.ts";
import * as Routines from "../triggers/routines.ts";
import * as OwnerCheck from "../triggers/ownerCheck.ts";
import * as KinSchedules from "../triggers/kinSchedules.ts";
import { dueTurnText } from "../questions/openQuestions.ts";
import { dismissalGone } from "../questions/dismissed.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import * as KinBudget from "./KinBudget.ts";
import * as KinLeadRegistry from "./KinLeadRegistry.ts";
import {
  SHARED_THREAD_PREFIX,
  ownerAlone,
  aborted,
  audienceChanged,
  effectiveAudience,
  recordedAudience,
  turnChat,
} from "./Audience.ts";
import { REVIEW_THREAD_PREFIX, outsideReview } from "./outsideReview.ts";
import { KinLeadPrompt, STEER_CLOSING } from "./LeadPrompt.ts";
import { KinTurnContent } from "./turn/content.ts";
import {
  chooseLeadModel,
  companyDefaultModel,
  isDevServer,
  leadModelProblem,
  driverOf,
  leadProviderProblem,
  modelNotOffered,
} from "./leadModels.ts";
import { KinRefusedModels } from "./refusedModels.ts";
import { leadThreadInstructions } from "./turn/session.ts";
import { isEngineeringDomain } from "./t3Tools.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { bootstrapLeadProject } from "./leadProject.ts";
import * as RoutineContent from "./RoutineContent.ts";
import * as LeadDelivery from "./LeadDelivery.ts";
import { PAUSE_POLL_INTERVAL_MS } from "./KinStop.ts";
import { isOrgPaused } from "./orgState.ts";
import { isEveningCheckIn, isMorningCheckIn } from "../pulse/weekly.ts";
import { dayIn } from "../work/money.ts";
import { ownerZone } from "../work/recordRows.ts";
import { KinReplyBridge } from "../reply/KinReplyBridge.ts";
import { setupFailureIn, type SetupFailure } from "../reply/classify.ts";
import { HOLD_MS, KinHostCare } from "../host/KinHostCare.ts";
import {
  HELD_CAUSES,
  providerFailureIn,
  providerResetAt,
  troubleCause,
  troubleDetail,
} from "../host/troubleCauses.ts";
import { ownerLevelPeople } from "../people/KinAccess.ts";
import { KinTeam } from "../team/KinTeam.ts";
import { KinHandoff } from "./Handoff.ts";
import * as WorkFor from "./workFor.ts";
import { noticeRecords, runsFrom, turnRecords } from "./wakeupRuns.ts";
import { RUN_SILENCE_MS, activityAt, waitWhileActive } from "./runSilence.ts";

const isSteerRun = (wakeupId: KinWakeupId, run: { readonly userMessageId: string }) =>
  KinIdentity.isAdoptedRunMessage(wakeupId, run.userMessageId) &&
  run.userMessageId !== KinIdentity.rescueMessageId(wakeupId);
/** A running lead never shortens the org loop's wait; its finish wakes the loop instead. */
const orgLoopWaitMs = (
  ready: ReadonlyArray<{ readonly agentId: KinAgentId; readonly readyAt: number }>,
  active: ReadonlySet<KinAgentId>,
  now: number,
) => {
  const next = ready.find((candidate) => !active.has(candidate.agentId));
  return next === undefined ? 60_000 : Math.min(60_000, Math.max(1, next.readyAt - now));
};

export class KinWakeupError extends Schema.TaggedError<KinWakeupError>()("KinWakeupError", {
  orgId: KinOrgId,
  agentId: KinAgentId,
  cause: Schema.Defect(),
}) {}

export class KinWakeupHooks extends Context.Service<
  KinWakeupHooks,
  {
    readonly memoryCheckoutInvalid: (error: Memory.MemoryCheckoutInvalid) => Effect.Effect<void>;
  }
>()("t3/kin/lead/WakeupRunner/KinWakeupHooks") {}

export class WakeupRunner extends Context.Service<
  WakeupRunner,
  {
    readonly runOnce: (orgId: KinOrgId, agentId: KinAgentId) => Effect.Effect<void, KinWakeupError>;
    /** Stops a wake-up `abortChatTurns` marked: its line and draft go, then its run. */
    readonly abort: (orgId: KinOrgId, wakeupId: KinWakeupId) => Effect.Effect<void>;
    readonly recover: Effect.Effect<void, KinWakeupError>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/kin/lead/WakeupRunner") {}

const runnerCause = (cause: unknown) =>
  isSqlError(cause) ? toPersistenceSqlError("WakeupRunner")(cause) : cause;
const isWakeupError = Schema.is(KinWakeupError);
const LeadRow = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  name: Schema.String,
  level: KinLead.fields.level,
  threadId: Schema.NullOr(ThreadId),
  model: Schema.fromJsonString(ModelSelection),
  orgName: Schema.String,
  retiredAt: Schema.NullOr(Schema.String),
});
const RunningRow = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  wakeupId: KinWakeupId,
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  startedAt: Schema.Number,
});
const decodeLead = Schema.decodeUnknownEffect(LeadRow);
const decodeRunning = Schema.decodeUnknownEffect(RunningRow);
const decodeTaskIds = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const ulid = Effect.gen(function* () {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let timestamp = yield* Clock.currentTimeMillis;
  let value = "";
  for (let i = 0; i < 10; i++) {
    value = alphabet.charAt(timestamp % 32) + value;
    timestamp = Math.floor(timestamp / 32);
  }
  for (let i = 0; i < 16; i++) value += alphabet.charAt(yield* Random.nextIntBetween(0, 31));
  return value;
});

const make = Effect.gen(function* () {
  const ownerCheck = yield* Effect.serviceOption(OwnerCheck.OwnerCheck);
  const care = yield* Effect.serviceOption(KinHostCare);
  const refusals = yield* Effect.serviceOption(KinRefusedModels);
  const claimedEvents = Effect.fn("WakeupRunner.claimedEvents")(function* (
    row: typeof RunningRow.Type,
  ) {
    const [wakeup] = yield* sql<{ eventIds: string }>`SELECT event_ids AS "eventIds"
      FROM kin_wakeups WHERE org_id = ${row.orgId} AND wakeup_id = ${row.wakeupId}`;
    return Option.getOrElse(
      Option.flatMap(Option.fromNullishOr(wakeup?.eventIds), decodeTaskIds),
      () => [],
    ).map((id) => KinEventId.make(id));
  });
  const bridge = yield* Effect.serviceOption(KinReplyBridge);
  const team = yield* Effect.serviceOption(KinTeam);
  const handoff = yield* Effect.serviceOption(KinHandoff);
  const endReply = (row: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly wakeupId: KinWakeupId;
  }) => (Option.isSome(bridge) ? bridge.value.end(row) : Effect.void);
  const finishWakeup = Effect.fn("WakeupRunner.finishWakeup")(function* (
    row: typeof RunningRow.Type,
    status: "completed" | "failed" | "timed_out",
    setup: SetupFailure | null = null,
    failure: unknown = null,
  ) {
    // Read first: finishing returns retried events to the queue, which drops their lane.
    const lane =
      status === "completed" || Option.isNone(bridge)
        ? Option.none()
        : yield* bridge.value.lane(row);
    const owed = status !== "completed" || Option.isNone(handoff) ? [] : yield* workOwed(row);
    // Why it failed, from the error itself; a time-out has none and keeps the plain retries.
    const cause =
      status !== "failed" || Option.isNone(care) ? undefined : (setup ?? troubleCause(failure));
    const claimed = cause === undefined ? [] : yield* claimedEvents(row);
    const now = yield* Clock.currentTimeMillis;
    let holdUntil: number | undefined;
    // A full disk: the trouble's one automatic clean, then one more try at once, telling nobody.
    let quiet = false;
    if (
      cause === "space" &&
      Option.isSome(care) &&
      (yield* care.value.spaceFailed(row.orgId, row.agentId))
    ) {
      holdUntil = yield* Clock.currentTimeMillis;
      quiet = true;
    }
    const resetAt = providerResetAt(failure);
    if (holdUntil === undefined && cause !== undefined && HELD_CAUSES.has(cause))
      holdUntil =
        cause === "usage_limit" && resetAt !== undefined
          ? Math.max(now + 60_000, Date.parse(resetAt) + 60_000)
          : now + (HOLD_MS[cause] ?? KinEventQueue.LAST_RETRY_MS);
    const finished = yield* queue.finish({
      orgId: row.orgId,
      wakeupId: row.wakeupId,
      status,
      ...(holdUntil === undefined ? {} : { holdUntil }),
    });
    // Quiet only when the turn really went back to wait, untouched: after something visible,
    // its unanswered events stopped instead, and that is said.
    if (quiet && (finished.stranded > 0 || finished.replied > 0)) quiet = false;
    let told = false;
    if (Option.isSome(care)) {
      if (status === "completed") yield* care.value.succeeded(row.orgId, row.agentId);
      const held = finished.heldEventIds ?? [];
      // Kin holds the turns of a cause it waits out; others tell once their first retry failed too.
      const tell =
        cause !== undefined &&
        !quiet &&
        (HELD_CAUSES.has(cause)
          ? held.length > 0 || finished.stranded > 0
          : finished.failedEventIds.length > 0 ||
            finished.retryInMs > KinEventQueue.FIRST_RETRY_MS);
      if (tell)
        told = yield* care.value.failed({
          orgId: row.orgId,
          agentId: row.agentId,
          cause,
          eventIds: held.length > 0 ? held : claimed,
          detail: troubleDetail(failure),
          resetAt,
        });
    }
    // A Team-room turn that said nothing passed; a hand-off's answer goes back to who asked.
    if (Option.isSome(team)) yield* team.value.wakeupEnded(row);
    if (Option.isSome(handoff)) {
      yield* handoff.value.reportBack(row);
      if (owed.length > 0) yield* handoff.value.workDone({ ...row, owed });
    }
    if (Option.isNone(bridge) || Option.isNone(lane)) return;
    // Something visible already happened, so a silent retry could repeat it; say so instead.
    // Otherwise the person waiting hears at once that it is retrying, or has stopped. A run
    // nobody waits on (a check-in, a reminder) retries quietly, but never fails silently.
    // Every message already replied to: one message, one answer, unless the reply's promise broke.
    const outcome = quiet
      ? undefined
      : finished.stranded > 0
        ? "partway"
        : finished.replied > 0
          ? "replied"
          : (finished.heldEventIds?.length ?? 0) > 0
            ? lane.value.owed
              ? "held"
              : undefined
            : setup !== null
              ? setup
              : finished.failedEventIds.length > 0
                ? "gave_up"
                : finished.retried > 0 && lane.value.owed
                  ? finished.retryInMs >= KinEventQueue.LAST_RETRY_MS
                    ? "retrying_later"
                    : "retrying"
                  : undefined;
    if (outcome !== undefined)
      yield* bridge.value.failed({
        orgId: row.orgId,
        wakeupId: row.wakeupId,
        lane: lane.value,
        outcome,
        told,
        ...(cause === undefined ? {} : { cause }),
      });
  });
  const routineContent = yield* Effect.serviceOption(RoutineContent.KinRoutineContent);
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue.KinEventQueue;
  const budget = yield* KinBudget.KinBudget;
  /**
   * The budget's say on claimed events, by priority and by who asked: a teammate's request
   * counts against the teammates' limit, never as the owner's.
   */
  const admitEvents = Effect.fn("WakeupRunner.admitEvents")(function* <
    E extends KinEvent & { readonly priority: "P0" | "P1" | "P2" | "P3" },
  >(orgId: KinOrgId, agentId: KinAgentId, events: ReadonlyArray<E>) {
    const [agent] = yield* sql<{ owner: string }>`SELECT owner_person_id AS owner
      FROM kin_agents WHERE org_id = ${orgId} AND agent_id = ${agentId} ORDER BY agent_id`;
    const ownerLevel = new Set(
      yield* ownerLevelPeople(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    );
    if (agent !== undefined) ownerLevel.add(agent.owner);
    const groups = new Map<string, Array<E>>();
    for (const event of events) {
      const asker = KinBudget.askedByTeammate(event, ownerLevel) ? "teammate" : "owner";
      const key = `${event.priority}:${asker}`;
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    const atLimit: Array<boolean> = [];
    const held: Array<{
      readonly events: ReadonlyArray<E>;
      readonly heldBy: KinBudget.HeldBy;
      readonly nextReset: number;
    }> = [];
    for (const [key, group] of groups) {
      const [priority, asker] = key.split(":") as ["P0" | "P1" | "P2" | "P3", "owner" | "teammate"];
      const admission = yield* budget.admit(orgId, priority, asker);
      if (admission.allowed) atLimit.push(admission.atLimit);
      else
        held.push({
          events: group,
          heldBy: admission.heldBy ?? "org",
          nextReset: admission.nextReset,
        });
    }
    // At the limit only when all its work is: a teammate's spending never counts as the owner's.
    return { atLimit: atLimit.length > 0 && atLimit.every(Boolean), held };
  });
  const memory = yield* Memory.Memory;
  const writer = yield* Effect.serviceOption(Writer.MemoryWriter);
  const hooks = yield* Effect.serviceOption(KinWakeupHooks);
  const chat = yield* Effect.serviceOption(KinChatService);
  const spaceFolders = Option.map(yield* Effect.serviceOption(ServerConfig), (config) =>
    HostBackup.spaceFolders(config.baseDir),
  );
  // Before it is full: agents' commands fail one by one for a while before a wake-up does, so a
  // low disk is cleared at once and the owner hears only when that was not enough.
  const lowOnSpace = (orgId: KinOrgId) =>
    Option.isNone(spaceFolders) || Option.isNone(chat)
      ? Effect.void
      : HostBackup.warnIfLowOnSpace(
          orgId,
          spaceFolders.value,
          HostBackup.readSpace,
          Option.isSome(care) ? care.value.clean("low_on_space") : undefined,
        ).pipe(
          Effect.provideService(KinChatService, chat.value),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin host space notice failed", { orgId, cause }),
          ),
        );
  // While the out-of-space notice stands, it is the one word on space.
  const warnIfLowOnSpace = Effect.fn("WakeupRunner.warnIfLowOnSpace")(function* (orgId: KinOrgId) {
    if (Option.isSome(care) && (yield* care.value.troubleOpen(orgId, "space"))) return;
    yield* lowOnSpace(orgId);
  });
  const prompt = yield* KinLeadPrompt;
  const turnContent = yield* KinTurnContent;
  const identity = yield* KinIdentity.KinIdentity;
  const floor = yield* Floor.KinFloor;
  const registry = yield* KinLeadRegistry.KinLeadRegistry;
  const projects = yield* ProjectService.ProjectService;
  const launch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  /** What on a lead's thread can free it or change what it is owed: a run update, a turn's end. */
  const isLeadActivity = (event: Stream.Success<typeof threads.streamDomainEvents>) =>
    event.type === "run.updated" ||
    (event.type === "provider-turn.updated" && event.payload.completedAt !== null);
  // One subscription to T3's events serves every wait below; each would otherwise open its own.
  const runActivity = yield* PubSub.unbounded<string>();
  /** When the provider last worked on each waited-on wake-up's thread, by the event's own time. */
  const lastWork = new Map<string, number>();
  yield* threads.streamDomainEvents.pipe(
    Stream.runForEach((event) => {
      const at = lastWork.has(event.threadId) ? activityAt(event) : undefined;
      if (at !== undefined)
        lastWork.set(event.threadId, Math.max(at, lastWork.get(event.threadId) ?? at));
      return isLeadActivity(event) ? PubSub.publish(runActivity, event.threadId) : Effect.void;
    }),
    Effect.catchCause((cause) =>
      Effect.logError("Kin run activity watch failed", { cause }).pipe(
        Effect.andThen(Effect.sleep("1 second")),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  /** Who each finished-task event's work was for (`WorkFor.workFor`), by event id. */
  const finishedFor = Effect.fn("WakeupRunner.finishedFor")(function* (
    orgId: KinOrgId,
    agentId: KinAgentId,
    events: ReadonlyArray<{
      readonly eventId: string;
      readonly threadId: ThreadId;
      readonly taskIds: ReadonlyArray<string>;
    }>,
  ) {
    const found = new Map<string, ReadonlyArray<{ personId: KinPersonId; name: string }>>();
    for (const event of events) {
      const { subagents } = yield* threads.getThreadRecords(event.threadId, ["subagents"], {
        subagentIds: event.taskIds.map((taskId) => NodeId.make(taskId)),
      });
      const runIds = subagents.flatMap((task) =>
        event.taskIds.includes(task.id) && task.runId !== null ? [task.runId] : [],
      );
      const people = yield* WorkFor.workFor({ orgId, agentId, runIds }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      if (people.length > 0) found.set(event.eventId, people);
    }
    return found;
  });
  /** The people a completed wake-up's finished work was for, each by the event that brought it. */
  const workOwed = Effect.fn("WakeupRunner.workOwed")(
    function* (row: typeof RunningRow.Type) {
      const rows = yield* sql<{ eventId: string; threadId: string; taskIds: string }>`SELECT
          event_id AS "eventId", json_extract(json, '$.threadId') AS "threadId",
          json_extract(json, '$.taskIds') AS "taskIds"
        FROM kin_events WHERE org_id = ${row.orgId} AND agent_id = ${row.agentId}
          AND wakeup_id = ${row.wakeupId} AND tag = 'task.finished'
        ORDER BY event_id`;
      const found = yield* finishedFor(
        row.orgId,
        row.agentId,
        rows.map((one) => ({
          eventId: one.eventId,
          threadId: ThreadId.make(one.threadId),
          taskIds: Option.getOrElse(decodeTaskIds(one.taskIds), () => []),
        })),
      );
      return [...found].flatMap(([eventId, people]) =>
        people.map((one) => ({ eventId, personId: one.personId })),
      );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin finished-work owners unavailable", { cause }).pipe(
        Effect.as<ReadonlyArray<{ eventId: string; personId: KinPersonId }>>([]),
      ),
    ),
  );
  /**
   * A due run of a scheduled task that no longer exists, or a question with nothing left to take:
   * every prompt answers it with NO_REPLY (`KinLeadPrompt`), so it starts no turn. A failed read
   * keeps the event for the turn.
   */
  const goneBeforeTurn = Effect.fn("WakeupRunner.goneBeforeTurn")(
    function* (orgId: KinOrgId, event: KinEvent) {
      if (event._tag !== "deferral.due") return false;
      const subject = event.subject;
      if (subject.type === "scheduled_task") {
        const schedule = yield* KinSchedules.readSchedule(sql, orgId, subject.itemId);
        if (schedule !== undefined)
          return (yield* KinSchedules.readNativeTask(sql, schedule.taskId)) === undefined;
        return yield* memory
          .readItemQuietly(orgId, subject.itemId, "triggers")
          .pipe(Effect.as(false), Effect.catchTags({ MemoryNotFound: () => Effect.succeed(true) }));
      }
      if (subject.type !== "question" || subject.undone === true || subject.answered === true)
        return false;
      if (subject.dismissed === true) return yield* dismissalGone(orgId, subject);
      const due = yield* dueTurnText(orgId, subject.questionId, yield* Clock.currentTimeMillis);
      return due === undefined;
    },
    (effect) =>
      effect.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orElseSucceed(() => false),
      ),
  );
  const settings = yield* ServerSettingsService;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  const paused = (orgId: KinOrgId) =>
    isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const provideSql = Effect.provideService(SqlClient.SqlClient, sql);
  const sharedTurn = (row: typeof RunningRow.Type) =>
    effectiveAudience(row).pipe(
      provideSql,
      Effect.map((audience) => audience === "shared"),
    );
  const isAborted = (row: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly wakeupId: KinWakeupId;
  }) => aborted(row).pipe(provideSql);
  const leadThreadIds = Effect.fn("WakeupRunner.leadThreadIds")(function* (orgId: KinOrgId) {
    const rows = yield* sql<{
      threadId: string;
    }>`SELECT thread_id AS "threadId" FROM kin_leads WHERE org_id = ${orgId} AND thread_id IS NOT NULL ORDER BY thread_id`;
    return new Set(rows.map((row) => row.threadId));
  });
  const threadActivity = Effect.fn("WakeupRunner.threadActivity")(function* (orgId: KinOrgId) {
    const leadThreads = yield* leadThreadIds(orgId);
    return yield* Stream.fromPubSub(runActivity).pipe(
      Stream.filter((threadId) => leadThreads.has(threadId)),
      Stream.runHead,
    );
  });

  const lead = Effect.fn("WakeupRunner.lead")(function* (orgId: KinOrgId, agentId: KinAgentId) {
    const [row] = yield* sql`SELECT l.org_id AS "orgId", l.agent_id AS "agentId", l.name,
      l.level, l.thread_id AS "threadId", l.models_json AS model, o.name AS "orgName", a.retired_at AS "retiredAt"
      FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      JOIN kin_orgs o ON o.org_id = l.org_id WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId}`;
    return yield* decodeLead(row);
  });
  // One pass per retirement; a lead restored and retired again gets another.
  const retired = new Set<string>();
  const retire = Effect.fn("WakeupRunner.retire")(function* (record: typeof LeadRow.Type) {
    if (record.retiredAt === null) return;
    const pass = `${record.agentId}:${record.retiredAt}`;
    if (retired.has(pass)) return;
    yield* queue.expireAgent(record.orgId, record.agentId);
    // The owner's thread and every chat's.
    const live = yield* sql<{ threadId: ThreadId }>`SELECT thread_id AS "threadId"
      FROM kin_agent_threads WHERE org_id = ${record.orgId} AND agent_id = ${record.agentId}
        AND ended_at IS NULL ORDER BY thread_id`;
    for (const threadId of new Set([
      ...(record.threadId === null ? [] : [record.threadId]),
      ...live.map((row) => row.threadId),
    ])) {
      yield* threads
        .stopDelegatedTasks({
          threadId,
          commandId: CommandId.make(`kin-retired:${threadId}:${record.retiredAt}`),
          reason: "This agent was retired.",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin could not stop a retired agent's tasks", { threadId, cause }),
          ),
        );
      const stopped = yield* threads.forceStopThread({ threadId });
      if (stopped.outcome === "releasing") return;
      yield* identity
        .endAgentThread({ orgId: record.orgId, threadId })
        .pipe(Effect.catchTags({ KinChatError: () => Effect.succeed(false) }));
    }
    retired.add(pass);
  });
  const capture = Effect.fn("WakeupRunner.capture")(function* (row: typeof RunningRow.Type) {
    if (row.threadId === null || row.runId === null) return;
    const runIds = new Set([row.runId]);
    for (const run of yield* runsFrom(threads, row.threadId, row.runId)) {
      if (
        KinIdentity.isAdoptedRunMessage(row.wakeupId, run.userMessageId) ||
        (run.restartContinuationOfRunId !== undefined &&
          runIds.has(run.restartContinuationOfRunId)) ||
        (run.usageLimitContinuationOfRunId !== undefined &&
          runIds.has(run.usageLimitContinuationOfRunId))
      )
        runIds.add(run.id);
    }
    // Every attempt of those runs, retries and steering restarts included, by T3's run index.
    const attempts = yield* sql<{ attemptId: string }>`SELECT attempt_id AS "attemptId"
      FROM orchestration_v2_projection_run_attempts
      WHERE thread_id = ${row.threadId} AND run_id IN ${sql.in([...runIds])} ORDER BY attempt_id`;
    const { thread, providerTurns } = yield* threads.getThreadRecords(
      row.threadId,
      ["providerTurns"],
      {
        providerTurnAttemptIds: attempts.map((attempt) => RunAttemptId.make(attempt.attemptId)),
      },
    );
    const usage = providerTurns.map((turn) => ({
      providerTurnId: turn.id,
      ...(turn.turnTokenUsage === undefined ? {} : { turnTokenUsage: turn.turnTokenUsage }),
      ...(turn.tokenUsage === undefined ? {} : { tokenUsage: turn.tokenUsage }),
      usedTokens: turn.tokenUsage?.usedTokens,
    }));
    yield* budget.charge({ orgId: row.orgId, wakeupId: row.wakeupId, usage });
    // What the session carried and what the provider read from or wrote to its prompt cache; the
    // endpoint's "Kin endpoint tool list." line has the tool list's hash for the same thread.
    const threadId = row.threadId;
    yield* Effect.gen(function* () {
      const driver = driverOf(yield* settings.getSettings, thread.modelSelection);
      const [lead] = yield* sql<{ domain: string }>`SELECT domain FROM kin_leads
        WHERE org_id = ${row.orgId} AND agent_id = ${row.agentId} ORDER BY agent_id`;
      const tokens = (pick: (usage: TurnTokenUsage) => number | undefined) =>
        providerTurns.reduce(
          (total, turn) =>
            total + (turn.turnTokenUsage === undefined ? 0 : (pick(turn.turnTokenUsage) ?? 0)),
          0,
        );
      yield* Effect.logInfo("Kin wake-up context.", {
        agentId: row.agentId,
        wakeupId: row.wakeupId,
        threadId,
        threadKind: threadId.startsWith(REVIEW_THREAD_PREFIX)
          ? "review"
          : threadId.startsWith(SHARED_THREAD_PREFIX)
            ? "shared"
            : "owner",
        seat:
          lead === undefined
            ? null
            : isEngineeringDomain(lead.domain)
              ? "engineering"
              : (kinCharacterSeat(lead.domain) ?? "custom"),
        driver: driver ?? null,
        model: thread.modelSelection.model,
        instructionsSha256:
          driver === undefined
            ? null
            : NodeCrypto.createHash("sha256")
                .update(leadThreadInstructions(threadId, driver))
                .digest("hex"),
        providerTurns: providerTurns.length,
        inputTokens: tokens((usage) => usage.inputTokens),
        cacheReadTokens: tokens((usage) => usage.cachedInputTokens),
        cacheWriteTokens: tokens((usage) => usage.cacheCreationTokens),
      });
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Kin wake-up context log failed", { cause })),
    );
  });
  const wait = Effect.fn("WakeupRunner.wait")(
    function* (row: typeof RunningRow.Type, projectId: ProjectId) {
      if (row.threadId === null || row.runId === null) return;
      const threadId = row.threadId;
      const runId = row.runId;
      const { orgId, agentId, wakeupId } = row;
      // Recovery resumes the count from the thread, so steer ids stay stable. T3's table has no
      // org; the thread is this wake-up's own.
      const steerPrefix = KinIdentity.steerMessagePrefix(wakeupId);
      const [landedSteers] = yield* sql<{ steers: number }>`SELECT COUNT(*) AS steers
        FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}
          AND substr(message_id, 1, ${steerPrefix.length}) = ${steerPrefix}`;
      const landed = landedSteers?.steers ?? 0;
      const steered =
        landed === 0
          ? []
          : (yield* threads.getThreadRecords(threadId, ["messages"], {
              messageIds: Array.from({ length: landed }, (_, index) =>
                MessageId.make(KinIdentity.steerMessageId(wakeupId, index + 1)),
              ),
            })).messages;
      const steering = {
        open: true,
        steers: landed,
        // The session holds a steer's framing once it read one; a taken run's first steer is the
        // whole prompt, which has none.
        framed: steered.some((message) => message.text.includes(STEER_CLOSING)),
        lock: yield* Semaphore.make(1),
      };
      const waitingSince = yield* Clock.currentTimeMillis;
      lastWork.set(threadId, waitingSince);
      /** When the wake-up is ended if its run shows nothing more. */
      const quietUntil = () => (lastWork.get(threadId) ?? waitingSince) + RUN_SILENCE_MS;
      // The grant lasts as long as the wake-up may run, so a slow first reply still lands.
      const holdFloor = Effect.gen(function* () {
        const claimed = yield* sql<{ messageId: string }>`
          SELECT json_extract(json, '$.messageId') AS "messageId" FROM kin_events
          WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND state = 'claimed'
            AND tag IN ('chat.message', 'widget.action', 'chat.reaction') ORDER BY event_id`;
        yield* floor.renew({
          orgId,
          agentId,
          until: quietUntil(),
          messageIds: claimed.map((event) => KinMessageId.make(event.messageId)),
        });
      });
      const keepFloor = holdFloor.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin could not hold a working wake-up's floor", {
            orgId,
            wakeupId,
            cause,
          }),
        ),
      );
      const steer = Effect.fn("WakeupRunner.steer")(function* () {
        if (!steering.open) return;
        let events = yield* queue.steer({ orgId, agentId, wakeupId });
        for (const group of (yield* admitEvents(orgId, agentId, events)).held) {
          const ids = new Set(group.events.map((event) => event.eventId));
          yield* budget.defer({ orgId, agentId, wakeupId, ...group });
          events = events.filter((event) => !ids.has(event.eventId));
        }
        if (events.length === 0) return;
        // An owner-only turn takes no message that would let someone else read its reply, and a
        // turn a join or clear aborted after the claim takes none: those wait for the next
        // wake-up, and this one stops taking more.
        if (
          (yield* isAborted(row)) ||
          (yield* audienceChanged({ orgId, agentId, wakeupId }).pipe(provideSql))
        ) {
          steering.open = false;
          yield* queue.release({
            orgId,
            wakeupId,
            eventIds: events.map((event) => event.eventId),
            notBefore: yield* Clock.currentTimeMillis,
            countAttempt: false,
          });
          return;
        }
        steering.steers++;
        const n = steering.steers;
        const messageId = MessageId.make(KinIdentity.steerMessageId(wakeupId, n));
        const first = !steering.framed;
        steering.framed = true;
        const deliver = Effect.gen(function* () {
          const { text, attachments } = yield* turnContent.prepare({
            text: yield* prompt.steer({
              orgId,
              agentId,
              wakeupId,
              events,
              first,
            }),
            attachments: yield* prompt.attachments({ orgId, events }),
          });
          yield* holdFloor;
          if (Option.isSome(bridge))
            yield* bridge.value.steered(orgId, wakeupId, {
              n,
              eventIds: events.map((event) => event.eventId),
            });
          const send = (mode: "steer" | "queue") =>
            threads.sendToThread({
              commandId: CommandId.make(`kin-steer:${wakeupId}:${n}:${mode}`),
              projectId,
              threadId,
              messageId,
              text,
              attachments,
              mode,
              createdBy: "system",
              creationSource: "server",
            });
          // Past its turn, the steer starts a run this wake-up adopts.
          yield* send("steer").pipe(
            Effect.catchTags({ ThreadManagementNoSteerableRunError: () => send("queue") }),
          );
        });
        // A steer that may have landed is never re-sent; one that did not goes back to the queue.
        yield* deliver.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const landed =
                (yield* threads.getThreadRecords(threadId, ["messages"], {
                  messageIds: [messageId],
                })).messages.length > 0;
              if (landed) return;
              steering.steers--;
              steering.framed = !first;
              yield* Effect.logWarning("Kin steer failed; its messages wait", {
                orgId,
                wakeupId,
                errorTag: error._tag,
              });
              yield* queue.release({
                orgId,
                wakeupId,
                eventIds: events.map((event) => event.eventId),
                notBefore: yield* Clock.currentTimeMillis,
                countAttempt: false,
              });
            }),
          ),
        );
      });
      const steerer = yield* Effect.gen(function* () {
        while (true) {
          const changed = yield* queue.changes(orgId);
          yield* steering.lock.withPermits(1)(
            steer().pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Kin steer failed", { orgId, wakeupId, cause }),
              ),
            ),
          );
          yield* changed;
        }
      }).pipe(Effect.forkChild);
      let current = runId;
      let result: Effect.Success<ReturnType<typeof threads.waitForThread>>;
      while (true) {
        result = yield* waitWhileActive(
          threads,
          { projectId, threadId, runId: current },
          () => lastWork.get(threadId) ?? waitingSince,
          keepFloor,
        );
        // Under the steer lock, so no steer lands once the wake-up stops waiting.
        const next = yield* steering.lock.withPermits(1)(
          Effect.gen(function* () {
            const after =
              (yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [current] })).runs[0]
                ?.ordinal ?? 0;
            const adopted =
              result.timedOut || (yield* isAborted(row))
                ? undefined
                : (yield* threads.getThreadRecords(threadId, ["runs"], {
                    runStatuses: ["queued", ...ThreadManagementService.ACTIVE_RUN_STATUSES],
                  })).runs
                    .filter(
                      (run) =>
                        run.ordinal > after &&
                        isSteerRun(wakeupId, run) &&
                        // A provider failure holds the queue: a held run never starts by itself.
                        ((run.status === "queued" && run.queueHeld !== true) ||
                          ThreadManagementService.isActiveRun(run)),
                    )
                    .toSorted((a, b) => a.ordinal - b.ordinal)[0];
            if (adopted === undefined) steering.open = false;
            return adopted;
          }),
        );
        if (next === undefined) break;
        current = next.id;
      }
      yield* Fiber.interrupt(steerer);
      // Its steers still queued would start with no wake-up to own them, or hold the lead's
      // queue for good; they go, and their messages return with the rest of its events.
      const final = yield* turnRecords(threads, threadId, runId, {
        turnItemTypes: ["error"],
        turnItemStatuses: ["failed"],
      });
      for (const leftover of final.runs) {
        if (leftover.status !== "queued" || !isSteerRun(wakeupId, leftover)) continue;
        yield* threads
          .dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`kin-steer-cancel:${wakeupId}:${leftover.id}`),
            threadId,
            runId: leftover.id,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Kin could not cancel a queued steer", { orgId, wakeupId, cause }),
            ),
          );
      }
      const status = result.timedOut
        ? "timed_out"
        : result.run?.status === "completed"
          ? "completed"
          : "failed";
      const setup = status === "failed" ? setupFailureIn(final, runId) : null;
      const failure = status === "failed" ? providerFailureIn(final, runId) : null;
      const ranOn = final.runs.find((run) => run.id === runId)?.modelSelection;
      if (
        setup === "model" &&
        failure !== null &&
        ranOn !== undefined &&
        Option.isSome(refusals) &&
        modelNotOffered(failure, ranOn.model)
      )
        yield* refusals.value.refused({ orgId: row.orgId, selection: ranOn });
      // The stop switch interrupted this run: hand its events back without spending an attempt.
      const stopped = status === "failed" && (yield* paused(row.orgId));
      // Someone besides the owner joined while it worked: it says nothing more, and a fresh
      // wake-up answers its events (`KinEventQueue.finish`).
      let abandoned = yield* isAborted(row);
      yield* Effect.gen(function* () {
        if (result.timedOut) {
          yield* threads.interruptThread({
            projectId,
            threadId,
            runId: result.run?.id ?? current,
            commandId: CommandId.make(`kin-timeout:${row.wakeupId}`),
          });
          const settled = yield* threads.waitForThread({
            projectId,
            threadId,
            runId: current,
            timeoutMs: 30_000,
          });
          if (settled.timedOut)
            yield* Effect.logWarning("Kin timed-out run may continue after interrupt", {
              orgId: row.orgId,
              wakeupId: row.wakeupId,
              runId: current,
            });
        }
        // The reply lands before memory commits, while the wake-up still owns its lane. Its run
        // just ended, so the floor's grant counts from now; a rescue turn that keeps working
        // keeps it a window at a time, as the run did, and one gone silent lets it lapse.
        if (Option.isSome(bridge) && !stopped && !abandoned) {
          const completing = bridge.value.complete({
            orgId: row.orgId,
            wakeupId: row.wakeupId,
            projectId,
            rootRunId: runId,
            rescue: status === "completed",
          });
          if (status === "completed") {
            lastWork.set(threadId, yield* Clock.currentTimeMillis);
            yield* keepFloor;
            const holdingFloor = Effect.gen(function* () {
              while (true) {
                const left = quietUntil() - (yield* Clock.currentTimeMillis);
                if (left <= 0) return yield* Effect.never;
                yield* Effect.sleep(left);
                yield* keepFloor;
              }
            });
            yield* Effect.raceFirst(completing, holdingFloor);
          } else yield* completing;
        }
        // Settled unless a join aborted it first; a join after this has nothing to abort.
        if (!abandoned)
          abandoned =
            (yield* sql`UPDATE kin_wakeups SET settled_at = ${yield* Clock.currentTimeMillis}
              WHERE org_id = ${row.orgId} AND wakeup_id = ${row.wakeupId} AND aborted_at IS NULL
              RETURNING wakeup_id`).length === 0;
        if (abandoned) yield* Effect.logInfo("Kin wake-up aborted for its audience", row);
        // A turn someone else could read keeps only what it saved as the team's (`LeadMemory`),
        // and only when its prompt was built for them: one that turned shared midway, or was
        // aborted, leaves nothing. With nothing saved it leaves no journal entry either.
        const shared = Option.isSome(writer) && !abandoned && (yield* sharedTurn(row));
        const keeps =
          shared &&
          Option.isSome(writer) &&
          (yield* recordedAudience(row).pipe(provideSql)) === "shared" &&
          (yield* writer.value
            .staged(row.orgId, row.wakeupId)
            .pipe(Effect.orElseSucceed(() => false)));
        if (Option.isSome(writer) && (abandoned || (shared && !keeps)))
          yield* writer.value.discard(row.orgId, row.wakeupId);
        else if (Option.isSome(writer)) {
          const { commit } = yield* writer.value.commitWakeup(
            row.orgId,
            row.wakeupId,
            status === "completed" ? "completed" : "failed",
          );
          yield* sql`UPDATE kin_wakeups SET memory_commit = ${commit} WHERE org_id = ${row.orgId} AND wakeup_id = ${row.wakeupId}`;
        }
        yield* capture(row);
        if (stopped)
          yield* queue.release({
            orgId: row.orgId,
            wakeupId: row.wakeupId,
            countAttempt: false,
            notBefore: (yield* Clock.currentTimeMillis) + PAUSE_POLL_INTERVAL_MS,
          });
        else yield* finishWakeup(row, status, setup, failure);
      }).pipe(
        Effect.onExit((exit) =>
          result.timedOut && Exit.isFailure(exit)
            ? queue
                .finish({ orgId: row.orgId, wakeupId: row.wakeupId, status: "timed_out" })
                .pipe(Effect.ignore)
            : Effect.void,
        ),
      );
      if (status === "completed" && !abandoned)
        yield* threads.settleThread({
          threadId: row.threadId,
          commandId: CommandId.make(`kin-settle:${row.wakeupId}`),
          byOwnAgent: true,
        });
      return status;
    },
    (effect, row) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && Option.isSome(writer)
            ? writer.value.discard(row.orgId, row.wakeupId).pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.ensuring(endReply(row)),
        Effect.ensuring(
          Effect.sync(() => {
            if (row.threadId !== null) lastWork.delete(row.threadId);
          }),
        ),
      ),
  );
  const clearMissingThread = Effect.fn("WakeupRunner.clearMissingThread")(function* (
    row: typeof RunningRow.Type,
  ) {
    if (row.threadId === null) return;
    const threadId = row.threadId;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing =
          yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
        if (existing.length > 0) return;
        const registered =
          yield* sql`SELECT 1 FROM kin_agent_threads WHERE org_id = ${row.orgId} AND agent_id = ${row.agentId} AND thread_id = ${threadId} AND ended_at IS NULL`;
        if (registered.length > 0) yield* identity.endAgentThread({ orgId: row.orgId, threadId });
        yield* sql`UPDATE kin_leads SET thread_id = NULL WHERE org_id = ${row.orgId} AND agent_id = ${row.agentId} AND thread_id = ${threadId}`;
      }),
    );
  });
  const cleanup = Effect.fn("WakeupRunner.cleanup")(function* (
    row: typeof RunningRow.Type,
    interrupted = false,
    failure: unknown = null,
  ) {
    // Only a stopping server interrupts a wake-up: what it staged lands then, as the agent may
    // already have said it saved it, and its events may be done. Otherwise it is dropped.
    if (Option.isSome(writer)) {
      const memory = writer.value;
      const landed =
        interrupted &&
        (yield* memory.staged(row.orgId, row.wakeupId).pipe(Effect.orElseSucceed(() => false)))
          ? yield* memory.commitWakeup(row.orgId, row.wakeupId, "completed").pipe(
              Effect.tap(
                ({ commit }) =>
                  sql`UPDATE kin_wakeups SET memory_commit = ${commit} WHERE org_id = ${row.orgId} AND wakeup_id = ${row.wakeupId}`,
              ),
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logError("Kin couldn't land a stopped wake-up's memory", {
                  wakeupId: row.wakeupId,
                  cause,
                }).pipe(Effect.as(false)),
              ),
            )
          : false;
      if (!landed) yield* memory.discard(row.orgId, row.wakeupId).pipe(Effect.ignore);
    }
    yield* endReply(row);
    const [running] =
      yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = ${row.orgId} AND wakeup_id = ${row.wakeupId} AND status = 'running'`;
    if (running === undefined) return;
    if (row.threadId !== null) {
      const projection = yield* threads.getThreadRecords(row.threadId, []).pipe(Effect.option);
      if (Option.isSome(projection))
        yield* threads
          .interruptThread({
            projectId: projection.value.thread.projectId,
            threadId: row.threadId,
            commandId: CommandId.make(`kin-exit:${row.wakeupId}`),
          })
          .pipe(Effect.ignore);
    }
    yield* clearMissingThread(row).pipe(Effect.ignore);
    yield* capture(row).pipe(Effect.ignore);
    if (interrupted) yield* queue.requeueUnfinished(row.orgId, row.wakeupId);
    else yield* finishWakeup(row, "failed", null, failure);
  });

  /** One line per wake-up: each stage's ms since the first claimed event was queued. */
  const logLatency = Effect.fn("WakeupRunner.logLatency")(
    function* (orgId: KinOrgId, wakeupId: KinWakeupId) {
      const [row] = yield* sql<{
        status: string;
        enqueuedAt: number | null;
        claimedAt: number;
        preparedAt: number | null;
        launchedAt: number | null;
        firstTokenAt: number | null;
        postedAt: number | null;
      }>`SELECT status, enqueued_at AS "enqueuedAt", started_at AS "claimedAt",
          prepared_at AS "preparedAt", launched_at AS "launchedAt",
          first_token_at AS "firstTokenAt", posted_at AS "postedAt"
        FROM kin_wakeups WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId}
        ORDER BY wakeup_id`.pipe(Effect.mapError(toPersistenceSqlError("WakeupRunner.logLatency")));
      const enqueuedAt = row?.enqueuedAt;
      if (row === undefined || enqueuedAt == null) return;
      const since = (at: number | null) => (at === null ? null : at - enqueuedAt);
      yield* Effect.logInfo("Kin wake-up latency", {
        orgId,
        wakeupId,
        status: row.status,
        claimedMs: since(row.claimedAt),
        preparedMs: since(row.preparedAt),
        launchedMs: since(row.launchedAt),
        firstTokenMs: since(row.firstTokenAt),
        postedMs: since(row.postedAt),
      });
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin wake-up latency log failed", { cause })),
  );

  const runOnce = Effect.fn("WakeupRunner.runOnce")(
    function* (orgId: KinOrgId, agentId: KinAgentId) {
      if (Option.isSome(care)) yield* care.value.storageRecovered(orgId);
      const record = yield* lead(orgId, agentId);
      if (record.retiredAt !== null) return yield* retire(record);
      if (yield* paused(orgId)) return;
      if (record.threadId !== null) {
        const busy = yield* sql`SELECT 1 FROM kin_leads l
          WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId}
            AND ${KinEventQueue.leadThreadBusy(sql, "l")}`;
        if (busy.length > 0) {
          yield* Effect.raceFirst(yield* queue.changes(orgId), threadActivity(orgId)).pipe(
            Effect.timeoutOrElse({ duration: 60_000, orElse: () => Effect.void }),
          );
          return;
        }
      }
      const wakeupId = KinWakeupId.make(yield* ulid);
      const startedAt = yield* Clock.currentTimeMillis;
      yield* warnIfLowOnSpace(orgId);
      let row: typeof RunningRow.Type = {
        orgId,
        agentId,
        wakeupId,
        threadId: null,
        runId: null,
        startedAt,
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          let events = yield* Effect.acquireRelease(
            queue.claim({ orgId, agentId, wakeupId, model: record.model.model }).pipe(
              // Storage full before a turn could start: nothing was claimed; clean, once.
              Effect.tapCause((cause) =>
                Option.isSome(care) && troubleCause(cause) === "space"
                  ? care.value.storageFailed(orgId)
                  : Effect.void,
              ),
            ),
            (_, exit) =>
              cleanup(row, Exit.hasInterrupts(exit), Exit.isFailure(exit) ? exit.cause : null).pipe(
                Effect.catch((error) =>
                  Effect.logError("Kin wake-up finalizer failed", {
                    orgId,
                    wakeupId,
                    errorTag: error._tag,
                  }),
                ),
              ),
          );
          row = { ...row, startedAt: yield* Clock.currentTimeMillis };
          if (Option.isSome(care)) yield* care.value.devFullDisk;
          yield* Effect.gen(function* () {
            if (yield* paused(orgId)) {
              yield* queue.release({
                orgId,
                wakeupId,
                countAttempt: false,
                notBefore: (yield* Clock.currentTimeMillis) + PAUSE_POLL_INTERVAL_MS,
              });
              return;
            }
            const current = yield* lead(orgId, agentId);
            if (current.retiredAt !== null) {
              yield* queue.finish({ orgId, wakeupId, status: "failed" });
              return yield* retire(current);
            }
            // A model the host can't run falls back to the company default; the page says so.
            const hostSettings = yield* settings.getSettings;
            const devServer = yield* isDevServer;
            const providers = Option.isSome(providerRegistry)
              ? yield* providerRegistry.value.getProviders
              : null;
            const { model: modelSelection } = chooseLeadModel({
              own: current.model,
              companyDefault: yield* companyDefaultModel(orgId).pipe(
                provideSql,
                Effect.orElseSucceed(() => null),
              ),
              problemOf: (candidate) =>
                leadModelProblem(hostSettings, providers, candidate, devServer),
            });
            // Provisioning refuses these too; a row written another way still never launches.
            const wrongProvider = leadProviderProblem(hostSettings, modelSelection, devServer);
            if (wrongProvider !== undefined)
              return yield* new KinWakeupError({ orgId, agentId, cause: wrongProvider });
            // T3 starts the run that answers a finished task at once: own it before the slow
            // preparation below, so its first tool calls already find their turn.
            for (const event of events) {
              if (event._tag !== "task.finished" || row.runId !== null) continue;
              const state = noticeState(
                yield* noticeRecords(threads, event.threadId, event.messageId),
                event.messageId,
              );
              if (state._tag !== "live") continue;
              row = { ...row, threadId: event.threadId, runId: state.run.id };
              yield* sql`UPDATE kin_wakeups SET thread_id = ${event.threadId}, run_id = ${state.run.id}
                WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND agent_id = ${agentId}
                  AND status = 'running'`;
              yield* registry.register(event.threadId, {
                orgId,
                agentId,
                wakeupId,
                level: current.level,
              });
            }
            const admitted = yield* admitEvents(orgId, agentId, events);
            const atLimit = admitted.atLimit;
            for (const group of admitted.held) {
              {
                const deferred = new Set(group.events.map((item) => item.eventId));
                // A brief can't wait for tomorrow's budget: Kin sends its own line, saying so.
                if (Option.isSome(routineContent))
                  for (const event of events) {
                    if (!deferred.has(event.eventId) || !RoutineContent.isRoutineContent(event))
                      continue;
                    const sent = yield* routineContent.value
                      .post(
                        agentId,
                        event,
                        `(Today's budget is used up, so Kin sent this instead of ${current.name}.)`,
                      )
                      .pipe(
                        Effect.as(true),
                        Effect.catch((error) =>
                          Effect.logWarning("Kin routine fallback failed", {
                            orgId,
                            eventId: event.eventId,
                            cause: error.cause,
                          }).pipe(Effect.as(false)),
                        ),
                      );
                    if (sent) {
                      deferred.delete(event.eventId);
                      events = events.filter((item) => item.eventId !== event.eventId);
                    }
                  }
                const waits = events.filter((event) => deferred.has(event.eventId));
                yield* budget.defer({
                  orgId,
                  agentId,
                  wakeupId,
                  events: waits,
                  heldBy: group.heldBy,
                  nextReset: group.nextReset,
                });
                events = events.filter((event) => !deferred.has(event.eventId));
              }
            }
            // At the limit only the owner's own messages run: they hear why once.
            if (atLimit) yield* budget.notifyOwner(orgId, "org");
            const routines = yield* Effect.serviceOption(Routines.KinRoutines);
            if (Option.isSome(routines))
              events = yield* Effect.filter(events, (event) =>
                event._tag === "routine"
                  ? routines.value.isEnabled(orgId, event.routine)
                  : Effect.succeed(true),
              );
            // A finished-task notice T3 steered into a turn already going was answered there.
            events = yield* Effect.filter(events, (event) =>
              event._tag === "task.finished"
                ? noticeRecords(threads, event.threadId, event.messageId).pipe(
                    Effect.map((records) => noticeState(records, event.messageId)._tag !== "seen"),
                  )
                : Effect.succeed(true),
            );
            events = yield* Effect.filter(events, (event) =>
              goneBeforeTurn(orgId, event).pipe(Effect.map((gone) => !gone)),
            );
            if (events.length === 0) {
              yield* queue.finish({ orgId, wakeupId, status: "completed" });
              return;
            }
            const budgetContext = yield* budget.promptContext(orgId);
            const lane = Option.isSome(bridge)
              ? Option.getOrUndefined(yield* bridge.value.lane({ orgId, agentId, wakeupId }))
              : undefined;
            if (Option.isSome(bridge) && lane !== undefined)
              yield* bridge.value.preparing({
                orgId,
                agentId,
                wakeupId,
                lane,
                startedAt: row.startedAt,
              });
            const pinned = yield* memory.prepareWakeup(orgId, wakeupId, { lead: agentId }).pipe(
              Effect.tapError((error) =>
                Effect.logError("Kin memory preparation failed", {
                  orgId,
                  wakeupId,
                  errorTag: error._tag,
                }),
              ),
              Effect.tapError((error) =>
                error._tag === "MemoryCheckoutInvalid" && Option.isSome(hooks)
                  ? hooks.value.memoryCheckoutInvalid(error)
                  : Effect.void,
              ),
            );
            const preparedAt = yield* Clock.currentTimeMillis;
            // The owner check is retired (K145) and posts no card: a fire that lands is dropped.
            if (Option.isSome(ownerCheck)) {
              events = events.filter(
                (event) => event._tag !== "routine" || event.routine !== "owner_check",
              );
              if (events.length === 0) {
                yield* queue.finish({ orgId, wakeupId, status: "completed" });
                return;
              }
            }
            // The lead writes briefs and summaries from the server's facts; the server attaches
            // their card to its message, or posts its own line when the lead can't.
            const routineFacts = new Map<string, string>();
            if (Option.isSome(routineContent)) {
              const deliveries = yield* Effect.serviceOption(LeadDelivery.KinLeadDelivery);
              for (const event of events) {
                if (!RoutineContent.isRoutineContent(event)) continue;
                const content = routineContent.value;
                const prepared = yield* Effect.gen(function* () {
                  const ready = yield* content.prepare(agentId, event);
                  if (ready === null || Option.isNone(deliveries)) {
                    yield* content.post(agentId, event);
                    return null;
                  }
                  yield* deliveries.value.track({
                    orgId,
                    eventId: event.eventId,
                    kind: "routine",
                    agentId,
                    chatId: ready.chatId,
                    widget: { widgetId: ready.widgetId, type: "routine", state: ready.state },
                    fallbackBody: `${ready.body}\n\n(${current.name} couldn't write this one, so Kin sent it.)`,
                    deadlineAt: row.startedAt + LeadDelivery.DELIVERY_DEADLINE_MS.routine,
                  });
                  return ready;
                }).pipe(
                  // A failed brief retries on its own; the rest of the batch still runs.
                  Effect.catch((error) =>
                    Effect.logWarning("Kin routine content failed", {
                      orgId,
                      eventId: event.eventId,
                      cause: error.cause,
                    }).pipe(
                      Effect.andThen(
                        queue.release({
                          orgId,
                          wakeupId,
                          eventIds: [event.eventId],
                          countAttempt: true,
                        }),
                      ),
                      Effect.as(null),
                    ),
                  ),
                );
                if (prepared !== null) routineFacts.set(event.eventId, prepared.body);
              }
            }
            // The morning check-in carries the retired morning brief's sections as facts.
            if (Option.isSome(routineContent))
              for (const event of events.filter(isMorningCheckIn)) {
                const facts = yield* routineContent.value.morningFacts(orgId, agentId).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Kin morning facts unavailable", {
                      cause: error.cause,
                    }).pipe(Effect.as(null)),
                  ),
                );
                if (facts !== null) routineFacts.set(event.eventId, facts);
              }
            // The evening check-in carries the retired evening summary's sections as facts. One
            // past its own day in the company's zone, or with nothing to sum up, is not sent, and
            // what it marked told is untold again.
            const dropped = new Set<string>();
            if (Option.isSome(routineContent))
              for (const event of events.filter(isEveningCheckIn)) {
                const day = event._tag === "pulse" ? event.checkIn?.day : undefined;
                const today =
                  day === undefined
                    ? undefined
                    : dayIn(
                        yield* Clock.currentTimeMillis,
                        yield* ownerZone(orgId).pipe(provideSql),
                      );
                const facts =
                  day !== today
                    ? null
                    : yield* routineContent.value.eveningFacts(orgId, agentId).pipe(
                        Effect.catch((error) =>
                          Effect.logWarning("Kin evening facts unavailable", {
                            cause: error.cause,
                          }).pipe(Effect.as("")),
                        ),
                      );
                if (facts === null) {
                  dropped.add(event.eventId);
                  yield* sql`DELETE FROM kin_pulse_told
                    WHERE org_id = ${orgId} AND event_id = ${event.eventId}`;
                } else if (facts !== "") routineFacts.set(event.eventId, facts);
              }
            if (Option.isSome(routineContent)) {
              events = events.filter(
                (event) =>
                  !dropped.has(event.eventId) &&
                  (!RoutineContent.isRoutineContent(event) || routineFacts.has(event.eventId)),
              );
              if (events.length === 0) {
                yield* queue.finish({ orgId, wakeupId, status: "completed" });
                return;
              }
            }
            // Work the owner side started for a teammate's relayed request goes back to them.
            const workFor = new Map<string, ReadonlyArray<string>>();
            for (const [eventId, people] of yield* finishedFor(
              orgId,
              agentId,
              events.flatMap((event) => (event._tag === "task.finished" ? [event] : [])),
            ))
              workFor.set(
                eventId,
                people.map((one) => one.name),
              );
            const built = yield* prompt.build({
              orgId,
              agentId,
              wakeupId,
              events,
              memoryHead: pinned.head,
              budgetContext,
              routineFacts,
              workFor,
              ...(lane === undefined ? {} : { lane }),
            });
            // What the people in the chat attached to the messages this turn answers, as text and
            // pictures every provider reads alike.
            const { text, attachments } = yield* turnContent.prepare({
              text: built,
              attachments: yield* prompt.attachments({ orgId, events }),
            });
            // The prompt recorded who reads this turn; a shared one runs without file tools.
            const shared =
              (yield* recordedAudience({ orgId, wakeupId }).pipe(provideSql)) === "shared";
            // A project per lead, since its root is the provider's cwd: the lead's own checkout.
            const { project } = yield* bootstrapLeadProject(projects, {
              orgId,
              agentId,
              workspaceRoot: pinned.read,
              orgName: record.orgName,
              name: record.name,
            });
            // The owner's own turns share one thread; any other, a co-owner's included, runs on
            // its chat's own, so no model context crosses chats. Ended threads can't be
            // registered again.
            const alone = !shared && (yield* ownerAlone(row).pipe(provideSql));
            const chatId = alone ? null : ((yield* turnChat(row).pipe(provideSql))?.chatId ?? null);
            // A stranger's pull request is reviewed on a thread that lists only its review tools.
            const review = shared && (yield* outsideReview(row).pipe(provideSql)) !== undefined;
            const prefix = review ? REVIEW_THREAD_PREFIX : shared ? SHARED_THREAD_PREFIX : "kin:";
            const [live] = yield* sql<{ threadId: ThreadId }>`SELECT thread_id AS "threadId"
              FROM kin_agent_threads WHERE org_id = ${orgId} AND agent_id = ${agentId}
                AND ended_at IS NULL AND chat_id IS ${chatId}
                AND substr(thread_id, 1, ${prefix.length}) = ${prefix}
                AND (${review ? 1 : 0} = 1
                  OR substr(thread_id, 1, ${REVIEW_THREAD_PREFIX.length}) <> ${REVIEW_THREAD_PREFIX})
              ORDER BY started_at DESC, thread_id DESC LIMIT 1`;
            let existingThreadId = !alone && chatId === null ? null : (live?.threadId ?? null);
            if (existingThreadId !== null) {
              const existing = yield* threads
                .getThreadRecords(existingThreadId, [])
                .pipe(Effect.option);
              // A thread keeps its cwd: one from another project ends so this launches its own.
              if (Option.isSome(existing) && existing.value.thread.projectId !== project.id) {
                yield* identity.endAgentThread({ orgId, threadId: existingThreadId });
                existingThreadId = null;
              }
            }
            // A join aborted it while it prepared: nothing launches, a fresh wake-up answers.
            if (yield* isAborted(row)) {
              yield* queue.finish({ orgId, wakeupId, status: "failed" });
              return;
            }
            const threadId = existingThreadId ?? ThreadId.make(`${prefix}${yield* ulid}`);
            row = { ...row, threadId };
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const [active] =
                  yield* sql`SELECT 1 FROM kin_agents WHERE org_id = ${orgId} AND agent_id = ${agentId} AND retired_at IS NULL`;
                if (active === undefined)
                  return yield* new KinWakeupError({ orgId, agentId, cause: "retired" });
                // The post-time grant may have lapsed while these events waited to be claimed;
                // it now lasts as long as the wake-up may run, so a slow first reply still lands.
                yield* floor.renew({
                  orgId,
                  agentId,
                  until: (yield* Clock.currentTimeMillis) + RUN_SILENCE_MS,
                  messageIds: events.flatMap((event) =>
                    event._tag === "chat.message" ||
                    event._tag === "widget.action" ||
                    event._tag === "chat.reaction"
                      ? [event.messageId]
                      : [],
                  ),
                });
                yield* identity.registerAgentThread({
                  orgId,
                  agentId,
                  threadId,
                  ...(chatId === null ? {} : { chatId }),
                });
                // The running turn's thread: one wake-up runs per lead at a time.
                yield* sql`UPDATE kin_leads SET thread_id = ${threadId} WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
                yield* sql`UPDATE kin_wakeups SET thread_id = ${threadId}, model = ${modelSelection.model},
                prepared_at = ${preparedAt}
              WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND agent_id = ${agentId} AND status = 'running'`;
              }),
            );
            // A finished task's run may already be this wake-up's (above).
            if (registry.lookup(threadId)?.wakeupId !== wakeupId)
              yield* registry.register(threadId, {
                orgId,
                agentId,
                wakeupId,
                level: current.level,
              });
            if (Option.isSome(bridge))
              yield* bridge.value.begin({
                orgId,
                agentId,
                wakeupId,
                threadId,
                startedAt: row.startedAt,
                attachments: attachments.length > 0,
              });
            // T3 already started the run that answers a finished task here: this wake-up owns it.
            const finished = events.flatMap((event) =>
              event._tag === "task.finished" && event.threadId === threadId ? [event] : [],
            );
            const taken =
              existingThreadId === null || finished.length === 0
                ? undefined
                : (yield* Effect.forEach(finished, (event) =>
                    noticeRecords(threads, threadId, event.messageId).pipe(
                      Effect.map((records) => noticeState(records, event.messageId)),
                    ),
                  ))
                    .flatMap((state) => (state._tag === "live" ? [state.run] : []))
                    .at(0);
            const commandId = CommandId.make(`kin-wakeup:${wakeupId}`);
            const messageId = MessageId.make(KinIdentity.wakeupMessageId(wakeupId));
            const sent =
              taken !== undefined
                ? undefined
                : existingThreadId === null
                  ? (yield* launch.launch({
                      commandId,
                      threadId,
                      projectId: project.id,
                      title: current.name,
                      modelSelection,
                      runtimeMode: "full-access",
                      interactionMode: "default",
                      workspaceStrategy: { type: "root" },
                      initialMessage: { messageId, text, attachments },
                      createdBy: "system",
                      creationSource: "server",
                    })).projection
                  : (yield* threads.sendToThread({
                      commandId,
                      projectId: project.id,
                      threadId,
                      messageId,
                      text,
                      attachments,
                      mode: "queue",
                      freshContext: true,
                      modelSelection,
                      createdBy: "system",
                      creationSource: "server",
                    })).projection;
            const run = taken ?? sent?.runs.findLast((run) => run.userMessageId === messageId);
            if (run === undefined)
              return yield* new KinWakeupError({ orgId, agentId, cause: "missing_run" });
            // Anything else this wake-up answers goes into that run as its first steer, and so
            // does who the finished work was for.
            if (
              taken !== undefined &&
              (workFor.size > 0 || events.some((event) => event._tag !== "task.finished"))
            ) {
              if (Option.isSome(bridge))
                yield* bridge.value.steered(orgId, wakeupId, {
                  n: 1,
                  eventIds: events.map((event) => event.eventId),
                });
              const send = (mode: "steer" | "queue") =>
                threads.sendToThread({
                  commandId: CommandId.make(`kin-steer:${wakeupId}:1:${mode}`),
                  projectId: project.id,
                  threadId,
                  messageId: MessageId.make(KinIdentity.steerMessageId(wakeupId, 1)),
                  text,
                  attachments,
                  mode,
                  createdBy: "system",
                  creationSource: "server",
                });
              yield* send("steer").pipe(
                Effect.catchTags({ ThreadManagementNoSteerableRunError: () => send("queue") }),
              );
            }
            row = { ...row, runId: run.id };
            yield* sql`UPDATE kin_wakeups SET run_id = ${run.id}, launched_at = ${yield* Clock.currentTimeMillis}
              WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND agent_id = ${agentId} AND status = 'running'`;
            // A pause or a join that landed during launch found no run to stop; stop it here.
            if ((yield* paused(orgId)) || (yield* isAborted(row)))
              yield* threads.interruptThread({
                projectId: project.id,
                threadId,
                runId: run.id,
                commandId: CommandId.make(`kin-stop-launch:${wakeupId}`),
              });
            yield* wait(row, project.id);
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? cleanup(row, Exit.hasInterrupts(exit), exit.cause).pipe(
                    Effect.catch((error) =>
                      Effect.logError("Kin wake-up cleanup failed", {
                        orgId,
                        wakeupId,
                        errorTag: error._tag,
                      }),
                    ),
                  )
                : Effect.void,
            ),
          );
        }),
      ).pipe(
        Effect.retry({
          while: (error) => error._tag === "KinEventQueueBusy",
          schedule: Schedule.spaced("5 seconds"),
        }),
        Effect.ensuring(logLatency(orgId, wakeupId)),
      );
    },
    (effect, orgId, agentId) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new KinWakeupError({ orgId, agentId, cause: runnerCause(cause) }),
        ),
      ),
  );
  const abort = Effect.fn("WakeupRunner.abort")(
    function* (orgId: KinOrgId, wakeupId: KinWakeupId) {
      const [row] = yield* sql<{ agentId: KinAgentId; threadId: ThreadId | null }>`
        SELECT agent_id AS "agentId", thread_id AS "threadId" FROM kin_wakeups
        WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND status = 'running'
          AND aborted_at IS NOT NULL ORDER BY wakeup_id`;
      if (row === undefined) return;
      if (Option.isSome(bridge)) yield* bridge.value.abort(orgId, wakeupId);
      // Not launched yet: the runner finds the mark before or right after its launch.
      if (row.threadId === null) return;
      const projection = yield* threads.getThreadRecords(row.threadId, []);
      // The stop switch's interrupt, without settling its events: `wait` sees the mark.
      yield* threads.interruptThread({
        projectId: projection.thread.projectId,
        threadId: row.threadId,
        commandId: CommandId.make(`kin-audience:${wakeupId}`),
      });
    },
    (effect, orgId, wakeupId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin could not stop an aborted wake-up", { orgId, wakeupId, cause }),
        ),
      ),
  );
  const recoverOrg = Effect.fn("WakeupRunner.recoverOrg")(
    function* (
      orgId: KinOrgId,
      active: Set<KinAgentId> = new Set(),
      wake: Effect.Effect<void> = Effect.void,
      forkRecoveries = false,
    ) {
      const rows = yield* sql<{
        wakeupId: string;
        agentId: string;
      }>`SELECT org_id AS "orgId", agent_id AS "agentId", wakeup_id AS "wakeupId", thread_id AS "threadId", run_id AS "runId", started_at AS "startedAt" FROM kin_wakeups WHERE org_id = ${orgId} AND status = 'running' ORDER BY started_at, wakeup_id`;
      // Rows of leads this process is already driving are not abandoned; the rest recover together.
      const pending = rows.filter((row) => !active.has(KinAgentId.make(row.agentId)));
      const recoverRow = (raw: (typeof pending)[number]) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(Effect.void, () =>
              queue
                .finish({ orgId, wakeupId: KinWakeupId.make(raw.wakeupId), status: "failed" })
                .pipe(Effect.ignore),
            );
            let row = yield* decodeRunning(raw);
            yield* Effect.acquireRelease(Effect.void, (_, exit) =>
              cleanup(row, Exit.hasInterrupts(exit), Exit.isFailure(exit) ? exit.cause : null).pipe(
                Effect.ignore,
              ),
            );
            const existing =
              row.threadId === null
                ? []
                : yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${row.threadId}`;
            const wakeMessageId = MessageId.make(KinIdentity.wakeupMessageId(row.wakeupId));
            const runId =
              row.threadId === null || existing.length === 0 || row.runId !== null
                ? row.runId
                : ((yield* threads.getThreadRecords(row.threadId, ["messages"], {
                    messageIds: [wakeMessageId],
                  })).messages[0]?.runId ?? null);
            const projection =
              row.threadId === null || existing.length === 0
                ? undefined
                : yield* threads.getThreadRecords(row.threadId, ["runs"], {
                    runIds: runId === null ? [] : [runId],
                  });
            const run = projection?.runs.find((run) =>
              row.runId === null ? run.userMessageId === wakeMessageId : run.id === row.runId,
            );
            if (projection === undefined || run === undefined) {
              const receipts =
                yield* sql`SELECT 1 FROM kin_lead_tool_calls WHERE org_id = ${row.orgId} AND wakeup_id = ${row.wakeupId} LIMIT 1`;
              if (receipts.length > 0 && Option.isSome(writer) && (yield* sharedTurn(row)))
                yield* writer.value.discard(row.orgId, row.wakeupId);
              else if (receipts.length > 0 && Option.isSome(writer)) {
                yield* writer.value.commitWakeup(row.orgId, row.wakeupId, "failed").pipe(
                  Effect.tap(
                    ({ commit }) =>
                      sql`UPDATE kin_wakeups SET memory_commit = ${commit} WHERE org_id = ${row.orgId} AND wakeup_id = ${row.wakeupId}`,
                  ),
                  Effect.catchCause((cause) =>
                    Effect.logError(
                      "Kin recovery commit failed; requeueing unfinished wake-up",
                      cause,
                    ),
                  ),
                );
              }
              if (projection === undefined) yield* clearMissingThread(row);
              yield* queue.requeueUnfinished(row.orgId, row.wakeupId);
              return;
            }
            row = { ...row, runId: run.id };
            yield* sql`UPDATE kin_wakeups SET run_id = ${run.id} WHERE org_id = ${row.orgId} AND agent_id = ${row.agentId} AND wakeup_id = ${row.wakeupId} AND status = 'running'`;
            const record = yield* lead(row.orgId, row.agentId);
            if (record.retiredAt !== null) {
              yield* cleanup(row);
              return yield* retire(record);
            }
            yield* identity.registerAgentThread({
              orgId: row.orgId,
              agentId: row.agentId,
              threadId: projection.thread.id,
            });
            yield* registry.register(projection.thread.id, { ...row, level: record.level });
            if (Option.isSome(bridge))
              yield* bridge.value.begin({ ...row, threadId: projection.thread.id });
            yield* wait(row, projection.thread.projectId).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? cleanup(row, Exit.hasInterrupts(exit), exit.cause).pipe(Effect.ignore)
                  : Effect.void,
              ),
            );
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Kin wake-up recovery failed", {
              orgId,
              wakeupId: raw.wakeupId,
              cause,
            }),
          ),
        );
      // In the org loop each recovery runs beside the loop, marked active like a fresh run,
      // so one slow recovery never stalls the leads behind it.
      if (forkRecoveries) {
        for (const raw of pending) {
          const agentId = KinAgentId.make(raw.agentId);
          active.add(agentId);
          yield* recoverRow(raw).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active.delete(agentId);
              }).pipe(Effect.andThen(wake)),
            ),
            Effect.forkScoped,
          );
        }
      } else
        yield* Effect.forEach(pending, recoverRow, { concurrency: "unbounded", discard: true });
    },
    Effect.mapError((cause) =>
      isWakeupError(cause)
        ? cause
        : new KinWakeupError({
            orgId: KinOrgId.make("startup"),
            agentId: KinAgentId.make("startup"),
            cause: runnerCause(cause),
          }),
    ),
  );

  const orgIds = Effect.fn("WakeupRunner.orgIds")(function* () {
    const rows = yield* sql<{
      orgId: string;
    }>`SELECT org_id AS "orgId" FROM kin_leads GROUP BY org_id ORDER BY org_id`;
    return rows.map((row) => KinOrgId.make(row.orgId));
  });
  const recover = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.forEach(
        yield* orgIds(),
        (orgId) =>
          recoverOrg(orgId).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Kin org recovery failed", { orgId, cause }),
            ),
          ),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new KinWakeupError({
          orgId: KinOrgId.make("startup"),
          agentId: KinAgentId.make("startup"),
          cause: runnerCause(cause),
        }),
    ),
  );
  const start = Effect.gen(function* () {
    const organizations = new Set<KinOrgId>();
    // Leads with a wake-up in flight, per organization, so each is driven once.
    const activeByOrg = new Map<KinOrgId, Set<KinAgentId>>();
    const activeOf = (orgId: KinOrgId) => {
      const existing = activeByOrg.get(orgId);
      if (existing !== undefined) return existing;
      const created = new Set<KinAgentId>();
      activeByOrg.set(orgId, created);
      return created;
    };
    const discover = Effect.gen(function* () {
      for (const orgId of yield* orgIds()) {
        if (organizations.has(orgId)) continue;
        organizations.add(orgId);
        // A run leaves `active` before it signals, so the lead it frees launches on the next pass.
        let freed = Deferred.makeUnsafe<void>();
        const wake = Effect.suspend(() => {
          const signal = freed;
          freed = Deferred.makeUnsafe<void>();
          return Deferred.succeed(signal, undefined);
        }).pipe(Effect.asVoid);
        // One reader of the runner's run activity per company, for its loop's life: activity on a
        // lead's thread ends a pass's wait, as `freed` does.
        let stirred = Deferred.makeUnsafe<void>();
        let leadThreads = new Set<string>();
        // A pass after a run ended, or after a quiet wait, recovers wake-ups left running.
        let recoverNext = true;
        const pass = Effect.gen(function* () {
          const changed = yield* queue.changes(orgId);
          // Taken before any read, so a run that finishes mid-pass still ends this pass's wait.
          const finished = Deferred.await(freed);
          stirred = Deferred.makeUnsafe<void>();
          const stir = Deferred.await(stirred);
          leadThreads = yield* leadThreadIds(orgId);
          const active = activeOf(orgId);
          if (recoverNext) yield* recoverOrg(orgId, active, wake, true);
          recoverNext = false;
          const rows = yield* sql<{
            agentId: string;
          }>`SELECT l.agent_id AS "agentId" FROM kin_leads l
              JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
              WHERE l.org_id = ${orgId} AND a.retired_at IS NOT NULL ORDER BY l.agent_id`;
          for (const row of rows) yield* retire(yield* lead(orgId, KinAgentId.make(row.agentId)));
          const ready = (yield* paused(orgId)) ? [] : yield* queue.readyLeads(orgId);
          const now = yield* Clock.currentTimeMillis;
          for (const candidate of ready) {
            if (candidate.readyAt > now || active.has(candidate.agentId)) continue;
            active.add(candidate.agentId);
            yield* runOnce(orgId, candidate.agentId).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Kin runner iteration failed", {
                  orgId,
                  agentId: candidate.agentId,
                  cause,
                }).pipe(Effect.andThen(Effect.sleep("1 second"))),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  active.delete(candidate.agentId);
                }).pipe(Effect.andThen(wake)),
              ),
              Effect.forkScoped,
            );
          }
          recoverNext = yield* Effect.raceAllFirst([
            changed.pipe(Effect.as(false)),
            finished.pipe(Effect.as(true)),
            stir.pipe(Effect.as(false)),
          ]).pipe(
            Effect.timeoutOrElse({
              duration: orgLoopWaitMs(ready, active, now),
              orElse: () => Effect.succeed(true),
            }),
          );
        });
        yield* Effect.gen(function* () {
          yield* Stream.fromPubSub(runActivity).pipe(
            Stream.runForEach((threadId) =>
              leadThreads.has(threadId) ? Deferred.succeed(stirred, undefined) : Effect.void,
            ),
            Effect.forkChild,
          );
          return yield* pass.pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Kin runner iteration failed", { orgId, cause }).pipe(
                Effect.andThen(Effect.sleep("1 second")),
              ),
            ),
            Effect.forever,
          );
        }).pipe(
          Effect.catchCause((cause) => Effect.logError("Kin org loop failed", { orgId, cause })),
          Effect.ensuring(Effect.sync(() => organizations.delete(orgId))),
          Effect.forkScoped,
        );
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logError("Kin runner discovery failed", { cause })),
    );
    // A new company's first work wakes discovery at once; the minute is the backstop.
    yield* Effect.gen(function* () {
      const newWork = yield* queue.unwatched;
      yield* discover;
      yield* newWork.pipe(
        Effect.timeoutOrElse({ duration: "60 seconds", orElse: () => Effect.void }),
      );
    }).pipe(Effect.forever, Effect.forkScoped);
  }).pipe(Effect.catchCause((cause) => Effect.logError("Kin runner unavailable", { cause })));
  return WakeupRunner.of({ runOnce, abort, recover, start });
});

export const layer = Layer.effect(WakeupRunner, make).pipe(Layer.provide(Floor.layer));

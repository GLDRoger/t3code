import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  KinAgentId,
  KinChatId,
  KinChatError,
  KinLead,
  type KinMemoryItemId,
  KinPersonId,
  type KinOrgId,
  type MemoryItemEvery,
  ProjectId,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { leadProjectId } from "../lead/leadProject.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { isStrayKinTask, KIN_COMMAND_PREFIX, KIN_TASK_PREFIX } from "./taskIds.ts";

const commandIdOf = (orgId: KinOrgId, scheduleId: string) =>
  CommandId.make(`${KIN_COMMAND_PREFIX}schedule:${orgId}:${scheduleId}`);
// Upstream names a task created by commandId `scheduled-task:${commandId}`.
export const scheduleTaskId = (orgId: KinOrgId, scheduleId: string) =>
  ScheduledTaskId.make(`scheduled-task:${commandIdOf(orgId, scheduleId)}`);

/** "Around 15:30" is any minute from 15:25 to 15:50: the native task fires at the start. */
export const LOOSE_BEFORE_MINUTES = 5;
export const LOOSE_AFTER_MINUTES = 20;
/** The native task's time for a loose one: five minutes earlier, never before midnight. */
const windowStart = (at: string) => {
  const [hours, minutes] = at.split(":").map(Number);
  const start = Math.max(0, hours! * 60 + minutes! - LOOSE_BEFORE_MINUTES);
  return `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
};

/** The instant a time of day ("09:55") falls on, on the day `ms` is in `zone`. */
export const timeOnDayOf = (ms: number, zone: string, time: string) => {
  const [hour, minute] = time.split(":").map(Number);
  return DateTime.toEpochMillis(
    DateTime.setParts(DateTime.makeZonedUnsafe(ms, { timeZone: zone }), {
      hour: hour!,
      minute: minute!,
      second: 0,
      millisecond: 0,
    }),
  );
};
/** When a loose slot's window opens on the day `ms` falls on in `zone`. */
export const looseWindowStartAt = (ms: number, zone: string, looseAt: string) =>
  timeOnDayOf(ms, zone, windowStart(looseAt));

/** Minutes from a loose window's start to its end: fewer when midnight cuts off its start. */
export const looseSpanMinutes = (at: string) => {
  const [hours, minutes] = at.split(":").map(Number);
  return Math.min(LOOSE_BEFORE_MINUTES, hours! * 60 + minutes!) + LOOSE_AFTER_MINUTES;
};

/** The zone native `fixed_time` schedules are read in: the host's, not the owner's. */
export const hostTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const promptSha256 = (prompt: string) =>
  Digest.Digest.pipe(
    Effect.flatMap((digest) => digest.digest(Digest.sha256, new TextEncoder().encode(prompt))),
    Effect.map(Hex.encode),
    Effect.provide(NodeCrypto.layer),
  );

const Every = Schema.Struct({ at: Schema.String, days: Schema.Array(Schema.Number) });
/** A check-in set in Settings: the owner's own time, and the host time Kin last wrote for it. */
const OwnerTime = Schema.fromJsonString(Schema.Struct({ ...Every.fields, host: Every }));
export const decodeOwnerTime = Schema.decodeUnknownOption(OwnerTime);
const encodeOwnerTime = Schema.encodeEffect(OwnerTime);

export interface KinSchedule {
  readonly taskId: ScheduledTaskId;
  readonly orgId: KinOrgId;
  readonly scheduleId: KinMemoryItemId;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
  readonly sourceEvent: string;
  readonly saidBy: string;
  readonly audience: "owner_only" | "shared";
  readonly contentSha256: string;
  readonly inboxThreadId: ThreadId;
  readonly askedSha256: string | null;
  readonly pendingEnabled: number | null;
  readonly runNowAt: number | null;
  readonly deletedAt: number | null;
  /** The time the owner said for a loose schedule ("around 15:30"); the native task runs earlier. */
  readonly looseAt: string | null;
  /** Its runs are pulse check-ins, not its prompt run as a task. */
  readonly checkIn: number;
  /** Set in Settings: `OwnerTime` as JSON. */
  readonly ownerTime: string | null;
}

const COLUMNS = `task_id AS "taskId", org_id AS "orgId", schedule_id AS "scheduleId",
  agent_id AS "agentId", chat_id AS "chatId", source_event AS "sourceEvent", said_by AS "saidBy",
  audience, content_sha256 AS "contentSha256", inbox_thread_id AS "inboxThreadId",
  asked_sha256 AS "askedSha256", pending_enabled AS "pendingEnabled", run_now_at AS "runNowAt",
  deleted_at AS "deletedAt", loose_at AS "looseAt", check_in AS "checkIn",
  owner_time_json AS "ownerTime"`;

export const readSchedule = (sql: SqlClient.SqlClient, orgId: KinOrgId, scheduleId: string) =>
  sql<KinSchedule>`SELECT ${sql.literal(COLUMNS)} FROM kin_schedules
    WHERE org_id = ${orgId} AND schedule_id = ${scheduleId}`.pipe(Effect.map((rows) => rows[0]));
export const readScheduleByTask = (sql: SqlClient.SqlClient, taskId: string) =>
  sql<KinSchedule>`SELECT ${sql.literal(COLUMNS)} FROM kin_schedules
    WHERE task_id = ${taskId}`.pipe(Effect.map((rows) => rows[0]));
export const listSchedules = (sql: SqlClient.SqlClient, orgId: KinOrgId) =>
  sql<KinSchedule>`SELECT ${sql.literal(COLUMNS)} FROM kin_schedules
    WHERE org_id = ${orgId} ORDER BY task_id`;

export interface NativeTask {
  readonly title: string;
  readonly prompt: string;
  readonly enabled: number;
  readonly projectId: string;
  readonly threadId: string | null;
  readonly threadMode: string | null;
  readonly scheduleType: string | null;
  readonly timeOfDay: string | null;
  readonly weekdays: string | null;
  readonly nextRunAt: string | null;
}
/** The fields of the native row Kin reads; the contract test pins these columns. */
export const readNativeTask = (sql: SqlClient.SqlClient, taskId: string) =>
  sql<NativeTask>`SELECT title, prompt, enabled, project_id AS "projectId",
      thread_id AS "threadId", thread_mode AS "threadMode",
      json_extract(schedule_json, '$.type') AS "scheduleType",
      json_extract(schedule_json, '$.timeOfDay') AS "timeOfDay",
      json_extract(schedule_json, '$.weekdays') AS weekdays, next_run_at AS "nextRunAt"
    FROM scheduled_tasks WHERE task_id = ${taskId}`.pipe(Effect.map((rows) => rows[0]));

/** Still loose: changed on T3's screen since, it is exact again at the time shown there. */
export const isAround = (task: NativeTask, looseAt: string | null) =>
  looseAt !== null && windowStart(looseAt) === task.timeOfDay;

/** The native schedule as the card shows it; undefined for a shape Kin never saves. */
export const everyOf = (
  task: NativeTask,
  looseAt: string | null = null,
): MemoryItemEvery | undefined => {
  if (task.scheduleType !== "fixed_time" || task.timeOfDay === null) return undefined;
  const days: unknown = task.weekdays === null ? null : JSON.parse(task.weekdays);
  return {
    at: looseAt !== null && isAround(task, looseAt) ? looseAt : task.timeOfDay,
    days: Array.isArray(days) && days.length > 0 ? days.map(Number) : [0, 1, 2, 3, 4, 5, 6],
  };
};

/** Disables each enabled stray in `tasks` through T3's service; returns the ids it disabled. */
export const disableStrayTasks = Effect.fn("KinSchedules.disableStrayTasks")(function* (
  tasks: ReadonlyArray<{ readonly id: ScheduledTaskId; readonly enabled: boolean }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const service = yield* ScheduledTaskService.ScheduledTaskService;
  const disabled: ScheduledTaskId[] = [];
  for (const task of tasks) {
    if (!task.enabled || !task.id.startsWith(KIN_TASK_PREFIX)) continue;
    yield* readScheduleByTask(sql, task.id).pipe(
      Effect.flatMap((source) =>
        isStrayKinTask(task.id, source !== undefined)
          ? service
              .setEnabled({ id: task.id, enabled: false })
              .pipe(
                Effect.andThen(Effect.logWarning("Kin stray scheduled task disabled")),
                Effect.andThen(Effect.sync(() => disabled.push(task.id))),
              )
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin stray scheduled task not disabled", Cause.pretty(cause)),
      ),
      Effect.annotateLogs({ scheduledTaskId: task.id }),
    );
  }
  return disabled;
});

/** Its first pass cleans strays at start-up; each later change catches one whose run was refused. */
export const watchStrayTasks = Effect.fn("KinSchedules.watchStrayTasks")(function* () {
  const service = yield* ScheduledTaskService.ScheduledTaskService;
  yield* service.subscribeList().pipe(
    Stream.runForEach((list) => disableStrayTasks(list.tasks)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin stray scheduled task watch stopped", Cause.pretty(cause)),
    ),
  );
});

const decodeModel = Schema.decodeUnknownEffect(Schema.fromJsonString(KinLead.fields.model));
const decodeUpsert = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

export interface SaveInput {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly scheduleId: KinMemoryItemId;
  /** True changes an existing schedule in place: same native task, same card. */
  readonly existing: boolean;
  readonly chatId: KinChatId;
  /** 'shared': set for the chat it was asked in, so it runs there (`sharedChatOf`). */
  readonly audience?: "shared" | undefined;
  readonly sourceEvent: string;
  readonly saidBy: string;
  readonly title: string;
  readonly prompt: string;
  readonly every: MemoryItemEvery;
  /** Fires once somewhere around `every.at`, a different minute each day. */
  readonly around?: boolean | undefined;
  readonly checkIn?: boolean | undefined;
  /**
   * A change of time or days only: the wording the owner approved and any edit waiting for his
   * confirm stay as they are, so this save approves no wording.
   */
  readonly keepWording?: true | undefined;
  /** The owner's own time it was set at, kept so a clock change moves `every` and not that. */
  readonly ownerTime?: MemoryItemEvery | undefined;
  readonly now: number;
}

export class KinSchedules extends Context.Service<
  KinSchedules,
  {
    /** Saves the native task, then the row that authorises its runs. */
    readonly save: (input: SaveInput) => Effect.Effect<void, KinChatError>;
    /** Deletes the native task, then marks its row deleted; a row left alone fires nothing. */
    readonly cancel: (orgId: KinOrgId, scheduleId: string) => Effect.Effect<void, KinChatError>;
    /** Applies this org's card taps (Run now, Pause, Resume, Delete) to the native tasks. */
    readonly applyTaps: (orgId: KinOrgId) => Effect.Effect<void, KinChatError>;
  }
>()("t3/kin/triggers/kinSchedules") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* ScheduledTaskService.ScheduledTaskService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const sqlError = toPersistenceSqlError("KinSchedules");
  const failed = (message: string) => (cause: unknown) =>
    Effect.logWarning(`Kin schedule: ${message}`, { cause }).pipe(
      Effect.andThen(Effect.fail(invalid(`${message} Try again in a moment.`))),
    );

  /** The archived thread a run records against, so no thread shows in the sidebar. */
  const inboxThread = Effect.fn("KinSchedules.inboxThread")(function* (
    orgId: KinOrgId,
    agentId: KinAgentId,
    projectId: ProjectId,
    modelSelection: ScheduledTaskUpsertInput["modelSelection"],
  ) {
    const launched = yield* launcher.launch({
      commandId: CommandId.make(`${KIN_COMMAND_PREFIX}schedule-inbox:${orgId}:${agentId}`),
      projectId,
      title: "Kin · Scheduled runs",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      workspaceStrategy: { type: "root" },
      createdBy: "system",
      creationSource: "server",
    });
    if (launched.projection.thread.archivedAt === null)
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(
          `${KIN_COMMAND_PREFIX}schedule-inbox-archive:${orgId}:${agentId}`,
        ),
        threadId: launched.threadId,
      });
    return launched.threadId;
  });

  const save = Effect.fn("KinSchedules.save")(function* (input: SaveInput) {
    const taskId = scheduleTaskId(input.orgId, input.scheduleId);
    const [lead] = yield* sql<{ model: string }>`SELECT models_json AS model FROM kin_leads
      WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId}`.pipe(
      Effect.mapError(sqlError),
    );
    if (lead === undefined) return yield* invalid("There is no agent to run it.");
    const model = yield* decodeModel(lead.model).pipe(
      Effect.catch(failed("The schedule could not be saved.")),
    );
    // The lead's own project, as its wake-ups use; the scheduled-tasks tick makes it before any.
    const projectId = leadProjectId(input.orgId, input.agentId);
    const inbox = yield* inboxThread(input.orgId, input.agentId, projectId, model).pipe(
      Effect.catch(failed("The schedule could not be saved.")),
    );
    const existing = input.existing ? yield* readNativeTask(sql, taskId) : undefined;
    // Unbound, plan mode and approval-required: if the sink were ever bypassed, a run is harmless.
    const upsert = yield* decodeUpsert({
      ...(existing === undefined
        ? { commandId: commandIdOf(input.orgId, input.scheduleId) }
        : { id: taskId, requireExisting: true }),
      title: input.title,
      prompt: input.prompt,
      // A change keeps a pause set in the Scheduled tasks screen.
      enabled: existing === undefined ? true : existing.enabled === 1,
      schedule: {
        type: "fixed_time",
        timeOfDay: input.around === true ? windowStart(input.every.at) : input.every.at,
        weekdays: input.every.days,
      },
      projectId,
      threadId: null,
      threadMode: "new_thread",
      workspaceStrategy: { type: "root" },
      modelSelection: model,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      createdBy: "system",
      creationSource: "server",
    }).pipe(Effect.catch(failed("The schedule could not be saved.")));
    const hash = yield* promptSha256(input.prompt);
    const keep = input.keepWording === true && existing !== undefined ? 1 : 0;
    yield* tasks.upsert(upsert).pipe(Effect.catch(failed("The schedule could not be saved.")));
    // After the task: a crash between leaves a task with no row, which the sink refuses.
    yield* sql`INSERT INTO kin_schedules (task_id, org_id, schedule_id, agent_id, chat_id,
        source_event, said_by, audience, content_sha256, inbox_thread_id, created_at, updated_at,
        loose_at, check_in, owner_time_json)
      VALUES (${taskId}, ${input.orgId}, ${input.scheduleId}, ${input.agentId}, ${input.chatId},
        ${input.sourceEvent}, ${input.saidBy}, ${input.audience ?? "owner_only"}, ${hash}, ${inbox}, ${input.now},
        ${input.now}, ${input.around === true ? input.every.at : null},
        ${input.checkIn === true ? 1 : 0},
        ${input.ownerTime === undefined ? null : yield* encodeOwnerTime({ ...input.ownerTime, host: input.every })})
      ON CONFLICT (task_id) DO UPDATE SET chat_id = excluded.chat_id,
        loose_at = excluded.loose_at, check_in = excluded.check_in,
        owner_time_json = excluded.owner_time_json,
        source_event = excluded.source_event, said_by = excluded.said_by,
        audience = excluded.audience,
        content_sha256 = CASE WHEN ${keep} THEN content_sha256 ELSE excluded.content_sha256 END,
        inbox_thread_id = excluded.inbox_thread_id,
        asked_sha256 = CASE WHEN ${keep} THEN asked_sha256 ELSE NULL END,
        updated_at = excluded.updated_at`.pipe(
      Effect.catch((cause) =>
        existing !== undefined
          ? failed("The schedule could not be saved.")(cause)
          : tasks
              .delete({ id: taskId })
              .pipe(
                Effect.ignore,
                Effect.andThen(failed("The schedule could not be saved.")(cause)),
              ),
      ),
    );
  }, Effect.mapError(asChatError));

  const cancel = Effect.fn("KinSchedules.cancel")(function* (orgId: KinOrgId, scheduleId: string) {
    const taskId = scheduleTaskId(orgId, scheduleId);
    yield* tasks.delete({ id: taskId }).pipe(Effect.catch(failed("It could not be cancelled.")));
    const now = yield* Clock.currentTimeMillis;
    // A tombstone until the next tick closes the card and removes it.
    yield* sql`UPDATE kin_schedules SET deleted_at = COALESCE(deleted_at, ${now}),
      updated_at = ${now} WHERE task_id = ${taskId}`.pipe(Effect.mapError(sqlError));
  }, Effect.mapError(asChatError));

  const applyTaps = Effect.fn("KinSchedules.applyTaps")(function* (orgId: KinOrgId) {
    const rows = yield* listSchedules(sql, orgId).pipe(Effect.mapError(sqlError));
    for (const row of rows) {
      const logged = (what: string) =>
        Effect.catchCause((cause: Cause.Cause<unknown>) =>
          Effect.logWarning(`Kin schedule tap failed: ${what}`, Cause.pretty(cause)).pipe(
            Effect.annotateLogs({ taskId: row.taskId }),
          ),
        );
      if (row.deletedAt !== null) {
        yield* tasks.delete({ id: row.taskId }).pipe(logged("delete"));
        continue;
      }
      if (row.pendingEnabled !== null) {
        yield* tasks
          .setEnabled({ id: row.taskId, enabled: row.pendingEnabled === 1 })
          .pipe(logged("pause or resume"));
        yield* sql`UPDATE kin_schedules SET pending_enabled = NULL
          WHERE task_id = ${row.taskId} AND pending_enabled = ${row.pendingEnabled}`.pipe(
          Effect.mapError(sqlError),
        );
      }
      if (row.runNowAt !== null) {
        // Cleared first: the run is handed to the sink now, and a repeat would run it twice.
        yield* sql`UPDATE kin_schedules SET run_now_at = NULL
          WHERE task_id = ${row.taskId} AND run_now_at = ${row.runNowAt}`.pipe(
          Effect.mapError(sqlError),
        );
        yield* tasks.runNow({ id: row.taskId }).pipe(logged("run now"));
      }
    }
  }, Effect.mapError(asChatError));

  return KinSchedules.of({ save, cancel, applyTaps });
});

const isChatError = Schema.is(KinChatError);
function asChatError(cause: unknown) {
  return isChatError(cause)
    ? cause
    : new KinChatError({ reason: "invalid_state", message: "The schedule could not be changed." });
}

export const layer = Layer.effect(KinSchedules, make);

/**
 * Whether a run of `schedule` may still go on: not paused (a Run now included), and a room's own
 * still has its setter in the company, owner or co-owner. Read at the fire and again at the claim.
 */
export const runnable = Effect.fn("KinSchedules.runnable")(function* (
  sql: SqlClient.SqlClient,
  schedule: KinSchedule,
  task: NativeTask,
) {
  if ((schedule.pendingEnabled ?? task.enabled) !== 1) return false;
  if (schedule.audience !== "shared") return true;
  const [setter] = yield* sql<{ removed: number }>`SELECT removed_at IS NOT NULL AS removed
    FROM kin_people WHERE org_id = ${schedule.orgId} AND person_id = ${schedule.saidBy}`;
  if (setter === undefined || setter.removed === 1) return false;
  return yield* ownerLevel(schedule.orgId, KinPersonId.make(schedule.saidBy)).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );
});

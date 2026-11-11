import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  KinAgentId,
  KinChatId,
  KinChatError,
  KinLead,
  type KinMemoryItemId,
  type KinOrgId,
  type MemoryItemEvery,
  ProjectId,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { KIN_COMMAND_PREFIX, KIN_TASK_PREFIX } from "./taskIds.ts";

export const KIN_SCHEDULE_TASK_PREFIX = `${KIN_TASK_PREFIX}schedule:`;
const commandIdOf = (orgId: KinOrgId, scheduleId: string) =>
  CommandId.make(`${KIN_COMMAND_PREFIX}schedule:${orgId}:${scheduleId}`);
// Upstream names a task created by commandId `scheduled-task:${commandId}`.
export const scheduleTaskId = (orgId: KinOrgId, scheduleId: string) =>
  ScheduledTaskId.make(`scheduled-task:${commandIdOf(orgId, scheduleId)}`);

/** The zone native `fixed_time` schedules are read in: the host's, not the owner's. */
export const hostTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const promptSha256 = (prompt: string) =>
  Digest.Digest.pipe(
    Effect.flatMap((digest) => digest.digest(Digest.sha256, new TextEncoder().encode(prompt))),
    Effect.map(Hex.encode),
    Effect.provide(NodeCrypto.layer),
  );

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
}

const COLUMNS = `task_id AS "taskId", org_id AS "orgId", schedule_id AS "scheduleId",
  agent_id AS "agentId", chat_id AS "chatId", source_event AS "sourceEvent", said_by AS "saidBy",
  audience, content_sha256 AS "contentSha256", inbox_thread_id AS "inboxThreadId",
  asked_sha256 AS "askedSha256", pending_enabled AS "pendingEnabled", run_now_at AS "runNowAt",
  deleted_at AS "deletedAt"`;

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

/** The native schedule as the card shows it; undefined for a shape Kin never saves. */
export const everyOf = (task: NativeTask): MemoryItemEvery | undefined => {
  if (task.scheduleType !== "fixed_time" || task.timeOfDay === null) return undefined;
  const days: unknown = task.weekdays === null ? null : JSON.parse(task.weekdays);
  return {
    at: task.timeOfDay,
    days: Array.isArray(days) && days.length > 0 ? days.map(Number) : [0, 1, 2, 3, 4, 5, 6],
  };
};

const decodeModels = Schema.decodeUnknownEffect(Schema.fromJsonString(KinLead.fields.models));
const decodeUpsert = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

export interface SaveInput {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly scheduleId: KinMemoryItemId;
  /** True changes an existing schedule in place: same native task, same card. */
  readonly existing: boolean;
  readonly chatId: KinChatId;
  readonly sourceEvent: string;
  readonly saidBy: string;
  readonly title: string;
  readonly prompt: string;
  readonly every: MemoryItemEvery;
  readonly now: number;
}

export class KinSchedules extends Context.Service<
  KinSchedules,
  {
    /** Saves the native task, then the row that authorises its runs. */
    readonly save: (input: SaveInput) => Effect.Effect<void, KinChatError>;
    /** Deletes the native task, then its row; a row left alone fires nothing. */
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
    const [lead] = yield* sql<{ models: string }>`SELECT models_json AS models FROM kin_leads
      WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId}`.pipe(
      Effect.mapError(sqlError),
    );
    if (lead === undefined) return yield* invalid("There is no lead to run it.");
    const models = yield* decodeModels(lead.models).pipe(
      Effect.catch(failed("The schedule could not be saved.")),
    );
    // The lead's own project, as its wake-ups use (WakeupRunner).
    const projectId = ProjectId.make(`kin:${input.orgId}:${input.agentId}`);
    const inbox = yield* inboxThread(input.orgId, input.agentId, projectId, models.cheap).pipe(
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
      schedule: { type: "fixed_time", timeOfDay: input.every.at, weekdays: input.every.days },
      projectId,
      threadId: null,
      threadMode: "new_thread",
      workspaceStrategy: { type: "root" },
      modelSelection: models.cheap,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      createdBy: "system",
      creationSource: "server",
    }).pipe(Effect.catch(failed("The schedule could not be saved.")));
    const hash = yield* promptSha256(input.prompt);
    yield* tasks.upsert(upsert).pipe(Effect.catch(failed("The schedule could not be saved.")));
    // After the task: a crash between leaves a task with no row, which the sink refuses.
    yield* sql`INSERT INTO kin_schedules (task_id, org_id, schedule_id, agent_id, chat_id,
        source_event, said_by, audience, content_sha256, inbox_thread_id, created_at, updated_at)
      VALUES (${taskId}, ${input.orgId}, ${input.scheduleId}, ${input.agentId}, ${input.chatId},
        ${input.sourceEvent}, ${input.saidBy}, 'owner_only', ${hash}, ${inbox}, ${input.now},
        ${input.now})
      ON CONFLICT (task_id) DO UPDATE SET chat_id = excluded.chat_id,
        source_event = excluded.source_event, said_by = excluded.said_by,
        audience = excluded.audience, content_sha256 = excluded.content_sha256,
        inbox_thread_id = excluded.inbox_thread_id, asked_sha256 = NULL,
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
    yield* sql`DELETE FROM kin_schedules WHERE task_id = ${taskId}`.pipe(Effect.mapError(sqlError));
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
        yield* cancel(orgId, row.scheduleId).pipe(logged("delete"));
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

function asChatError(cause: unknown) {
  return Schema.is(KinChatError)(cause)
    ? cause
    : new KinChatError({ reason: "invalid_state", message: "The schedule could not be changed." });
}

export const layer = Layer.effect(KinSchedules, make);

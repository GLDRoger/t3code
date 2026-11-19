import * as DevClock from "../DevClock.ts";
import * as KinEnabled from "../KinEnabled.ts";
import { type CommandId, KinTriggerFireId, KinTriggerFired } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestratorCommandRejectedError } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { leadProjectId } from "../lead/leadProject.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as KinSchedules from "./kinSchedules.ts";
import { KIN_SCHEDULE_TASK_PREFIX, KIN_TASK_PREFIX } from "./taskIds.ts";

const decodeFire = Schema.decodeEffect(KinTriggerFired);

export class KinTriggerSinkRefused extends Schema.TaggedError<KinTriggerSinkRefused>()(
  "KinTriggerSinkRefused",
  { scheduledTaskId: Schema.String, reason: Schema.Literals(["no_source", "not_kin_shape"]) },
) {}

/**
 * A native task is Kin's when its stored id carries Kin's command prefix or a `kin_schedules` row
 * names it, never by its prompt. Kin only writes prefixed ids, so a failed row lookup falls back
 * to the prefix and the developer's own tasks keep running.
 */
const isKinTask = (sql: SqlClient.SqlClient, taskId: string) =>
  taskId.startsWith(KIN_TASK_PREFIX)
    ? Effect.succeed(true)
    : Effect.suspend(
        () => sql<{ present: number }>`SELECT EXISTS (SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'kin_schedules') AS present`,
      ).pipe(
        Effect.flatMap(([row]) =>
          row?.present === 1
            ? sql`SELECT 1 FROM kin_schedules WHERE task_id = ${taskId}`.pipe(
                Effect.map((rows) => rows.length > 0),
              )
            : Effect.succeed(false),
        ),
        Effect.catchCause(() => Effect.succeed(false)),
      );

const refusedLaunch = (input: ThreadLaunchService.ThreadLaunchInput, why: string) =>
  Effect.logWarning(`Kin scheduled task refused: ${why}`).pipe(
    Effect.annotateLogs({ scheduledTaskId: input.initialMessage?.scheduledTaskId }),
    Effect.andThen(
      Effect.fail(
        new ThreadLaunchService.ThreadLaunchError({
          operation: "dispatch-message",
          commandId: input.commandId,
          projectId: input.projectId,
          cause: new Error(`Kin scheduled task refused: ${why}`),
        }),
      ),
    ),
  );

const refusedSend = (
  input: { readonly commandId: CommandId; readonly scheduledTaskId?: string | undefined },
  commandType: string,
  why: string,
) =>
  Effect.logWarning(`Kin scheduled task refused: ${why}`).pipe(
    Effect.annotateLogs({ scheduledTaskId: input.scheduledTaskId }),
    Effect.andThen(
      Effect.fail(
        new OrchestratorCommandRejectedError({
          commandId: input.commandId,
          commandType,
          cause: new Error(`Kin scheduled task refused: ${why}`),
        }),
      ),
    ),
  );

/** Kin off or failed: ordinary tasks run as always; Kin's own refuse instead of a bare thread. */
const refusingKinTasks = (why: string) =>
  Layer.mergeAll(
    Layer.effect(
      ThreadLaunchService.ThreadLaunchService,
      Effect.gen(function* () {
        const service = yield* ThreadLaunchService.ThreadLaunchService;
        const sql = yield* SqlClient.SqlClient;
        return ThreadLaunchService.ThreadLaunchService.of({
          ...service,
          launch: Effect.fn("KinTriggerSink.offLaunch")(function* (input) {
            const taskId = input.initialMessage?.scheduledTaskId;
            if (taskId !== undefined && (yield* isKinTask(sql, taskId)))
              return yield* refusedLaunch(input, why);
            return yield* service.launch(input);
          }),
        });
      }),
    ),
    Layer.effect(
      ThreadManagementService.ThreadManagementService,
      Effect.gen(function* () {
        const service = yield* ThreadManagementService.ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        return ThreadManagementService.ThreadManagementService.of({
          ...service,
          sendToThread: Effect.fn("KinTriggerSink.offSend")(function* (input) {
            if (
              input.scheduledTaskId !== undefined &&
              (yield* isKinTask(sql, input.scheduledTaskId))
            )
              return yield* refusedSend(input, "kin.trigger.disabled", why);
            return yield* service.sendToThread(input);
          }),
        });
      }),
    ),
  );

class KinTriggerSink extends Context.Service<
  KinTriggerSink,
  {
    readonly receive: (
      input: ThreadLaunchService.ThreadLaunchInput,
    ) => Effect.Effect<
      ThreadLaunchService.ThreadLaunchResult | undefined,
      ThreadLaunchService.ThreadLaunchError
    >;
  }
>()("t3/kin/triggers/KinTriggerSink") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const inbox = yield* KinTriggerInbox.KinTriggerInbox;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const refuse = (taskId: string, reason: "no_source" | "not_kin_shape") =>
    Effect.logWarning(`Kin scheduled task refused: ${reason}`).pipe(
      Effect.annotateLogs({ scheduledTaskId: taskId }),
      Effect.andThen(Effect.fail(new KinTriggerSinkRefused({ scheduledTaskId: taskId, reason }))),
    );
  /** A time run of a Kin schedule: one inbox row, authorised by its kin_schedules row. */
  const receiveSchedule = Effect.fn("KinTriggerSink.receiveSchedule")(function* (
    input: ThreadLaunchService.ThreadLaunchInput,
    taskId: string,
  ) {
    const schedule = yield* KinSchedules.readScheduleByTask(sql, taskId).pipe(
      Effect.mapError(toPersistenceSqlError("KinTriggerSink.receiveSchedule")),
    );
    if (schedule === undefined || schedule.deletedAt !== null)
      return yield* refuse(taskId, "no_source");
    const task = yield* KinSchedules.readNativeTask(sql, taskId).pipe(
      Effect.mapError(toPersistenceSqlError("KinTriggerSink.receiveSchedule")),
    );
    const run = /^(\d+):(scheduled|manual)$/.exec(
      input.commandId.slice(`scheduled-task:${taskId}:`.length),
    );
    // Anyone with the Scheduled tasks screen can re-save it, so its shape is checked per run.
    if (
      task === undefined ||
      run === null ||
      !input.commandId.startsWith(`scheduled-task:${taskId}:`) ||
      task.threadId !== null ||
      (task.threadMode ?? "new_thread") !== "new_thread" ||
      task.projectId !== input.projectId ||
      task.projectId !== leadProjectId(schedule.orgId, schedule.agentId) ||
      !["fixed_time", "interval", "once"].includes(task.scheduleType ?? "")
    )
      return yield* refuse(taskId, "not_kin_shape");
    const projection = yield* threads.getThreadProjection(schedule.inboxThreadId);
    if (projection.thread.projectId !== input.projectId || projection.thread.deletedAt !== null)
      return yield* refuse(taskId, "not_kin_shape");
    const now = yield* Clock.currentTimeMillis;
    const startedAt = Number(run[1]);
    yield* inbox.put(
      yield* decodeFire({
        fireId: KinTriggerFireId.make(`ns:${taskId}:${run[1]}:${run[2]}`),
        orgId: schedule.orgId,
        dueAt: DateTime.formatIso(DateTime.makeUnsafe(startedAt)),
        firedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        lateByMs: Math.max(0, now - startedAt),
        payload: {
          kind: "time",
          triggerId: `native:${schedule.scheduleId}`,
          subject: { type: "scheduled_task", itemId: schedule.scheduleId },
        },
      }),
      now,
    );
    return { threadId: schedule.inboxThreadId, projection, resumed: false };
  });

  return KinTriggerSink.of({
    receive: Effect.fn("KinTriggerSink.receive")(
      function* (input) {
        const taskId = input.initialMessage?.scheduledTaskId;
        if (taskId === undefined) return;
        if (taskId.startsWith(KIN_SCHEDULE_TASK_PREFIX))
          return yield* receiveSchedule(input, taskId);
        // Kin's task ids are deterministic, so a fire racing a remove still refuses to launch, and
        // a delivery to Kin's retired GitHub webhook task starts nothing.
        if (yield* isKinTask(sql, taskId)) {
          yield* Effect.logWarning("Kin scheduled task refused: no Kin source for it").pipe(
            Effect.annotateLogs({ scheduledTaskId: taskId }),
          );
          return yield* new KinTriggerSinkRefused({ scheduledTaskId: taskId, reason: "no_source" });
        }
        return;
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ThreadLaunchService.ThreadLaunchError({
                operation: "dispatch-message",
                commandId: input.commandId,
                projectId: input.projectId,
                cause,
              }),
          ),
        ),
    ),
  });
});

const layer = Layer.effect(KinTriggerSink, make).pipe(
  Layer.provide(KinTriggerInbox.layer),
  Layer.provide(KinPersistence.layer),
);

export function wrapTaskDispatch<E, R, E2, R2>(
  inner: Layer.Layer<ThreadLaunchService.ThreadLaunchService, E, R>,
  threads: Layer.Layer<ThreadManagementService.ThreadManagementService, E2, R2>,
) {
  const wrapped = Layer.mergeAll(
    Layer.effect(
      ThreadLaunchService.ThreadLaunchService,
      Effect.gen(function* () {
        const service = yield* ThreadLaunchService.ThreadLaunchService;
        const sink = yield* KinTriggerSink;
        return ThreadLaunchService.ThreadLaunchService.of({
          ...service,
          launch: Effect.fn("KinTriggerSink.launch")(function* (input) {
            return (yield* sink.receive(input)) ?? (yield* service.launch(input));
          }),
        });
      }),
    ),
    Layer.effect(
      ThreadManagementService.ThreadManagementService,
      Effect.gen(function* () {
        const service = yield* ThreadManagementService.ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        return ThreadManagementService.ThreadManagementService.of({
          ...service,
          sendToThread: Effect.fn("KinTriggerSink.sendToThread")(function* (input) {
            if (input.scheduledTaskId === undefined) return yield* service.sendToThread(input);
            if (!(yield* isKinTask(sql, input.scheduledTaskId)))
              return yield* service.sendToThread(input);
            yield* Effect.logWarning("Kin trigger sources must stay unbound new_thread tasks").pipe(
              Effect.annotateLogs({ scheduledTaskId: input.scheduledTaskId }),
            );
            return yield* new OrchestratorCommandRejectedError({
              commandId: input.commandId,
              commandType: "kin.trigger.bound_source",
              cause: new Error("Kin trigger sources must stay unbound new_thread tasks"),
            });
          }),
        });
      }),
    ),
  ).pipe(
    Layer.provide(layer),
    Layer.catchCause((cause) =>
      Layer.mergeAll(
        Layer.effectDiscard(
          KinEnabled.KinEnabled.pipe(Effect.flatMap((config) => config.reportFailure(cause))),
        ),
        refusingKinTasks("Kin is unavailable"),
      ),
    ),
    Layer.provide(Layer.mergeAll(inner, threads)),
  );
  const refusing = (why: string) =>
    refusingKinTasks(why).pipe(Layer.provide(Layer.mergeAll(inner, threads)));
  return Layer.unwrap(
    KinEnabled.KinEnabled.pipe(
      Effect.map(
        (
          config,
        ): Layer.Layer<
          Layer.Success<typeof wrapped>,
          Layer.Error<typeof wrapped>,
          Layer.Services<typeof wrapped> | R | R2
        > =>
          config.enabled
            ? wrapped.pipe(
                Layer.catchCause((cause) =>
                  refusing("Kin is unavailable").pipe(
                    Layer.provideMerge(Layer.effectDiscard(config.reportFailure(cause))),
                  ),
                ),
              )
            : refusing("Kin is off"),
      ),
    ),
  ).pipe(
    Layer.provide(KinEnabled.layer),
    // T3's scheduled tasks run Kin's check-ins, so they keep Kin's dev clock too.
    Layer.merge(DevClock.layer),
  );
}

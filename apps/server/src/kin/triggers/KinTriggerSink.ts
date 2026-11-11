import * as KinEnabled from "../KinEnabled.ts";
import {
  CanonicalUtcTimestamp,
  type CommandId,
  KinTriggerFireId,
  KinTriggerFired,
  ScheduledTaskWebhookDeliveryId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestratorCommandRejectedError } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { PersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import { configuredGithubMemoryRepo } from "../memory/MemoryConfig.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";
import * as KinSchedules from "./kinSchedules.ts";
import { KIN_TASK_PREFIX } from "./taskIds.ts";

const Delivery = Schema.Struct({ receivedAt: CanonicalUtcTimestamp });
const decodeDelivery = Schema.decodeUnknownEffect(Delivery);
const decodeFire = Schema.decodeEffect(KinTriggerFired);
const decodeDeliveryId = Schema.decodeEffect(ScheduledTaskWebhookDeliveryId);

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

/** Kin off: ordinary tasks run as always; Kin's own refuse instead of launching a bare thread. */
const kinOwnedRefused = <E, R, E2, R2>(
  inner: Layer.Layer<ThreadLaunchService.ThreadLaunchService, E, R>,
  threads: Layer.Layer<ThreadManagementService.ThreadManagementService, E2, R2>,
  why: string,
) =>
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
  ).pipe(Layer.provide(Layer.mergeAll(inner, threads)));

// Shared with the upstream contract test so the tripwire pins exactly what the sink reads.
// Any agent can re-save a task, so its shape is rechecked per delivery and the secret is
// returned for the caller to compare with the hash Kin bound; never log or decode it.
export const findLaunchDelivery = (
  sql: SqlClient.SqlClient,
  input: {
    readonly taskId: string;
    readonly deliveryId: string;
    readonly projectId: string;
    readonly botLogin: string;
  },
) => sql<{ readonly receivedAt: unknown; readonly secret: string; readonly repo: string | null }>`
  SELECT d.received_at AS "receivedAt", t.webhook_secret AS secret,
    CASE WHEN json_valid(d.body) THEN json_extract(d.body, '$.repository.full_name') END AS repo
  FROM scheduled_task_webhook_deliveries d
  JOIN scheduled_tasks t ON t.task_id = d.task_id
  WHERE d.task_id = ${input.taskId} AND d.delivery_id = ${input.deliveryId}
    AND d.signature_verified = 1 AND d.outcome = 'accepted'
    AND t.project_id = ${input.projectId}
    AND t.thread_id IS NULL AND t.thread_mode = 'new_thread'
    AND json_extract(t.schedule_json, '$.type') = 'webhook'
    AND json_extract(t.schedule_json, '$.signature') IS NOT NULL AND t.webhook_secret IS NOT NULL
    AND json_extract(t.schedule_json, '$.dedupe') = ${JSON.stringify(KinTriggerStore.GITHUB_DEDUPE)}
    AND EXISTS (SELECT 1 FROM json_each(t.schedule_json, '$.filters') f
      WHERE json_extract(f.value, '$.path') = 'headers.x-github-event'
        AND json_extract(f.value, '$.op') = 'in'
        AND json_extract(f.value, '$.value') = ${JSON.stringify(KinTriggerStore.GITHUB_EVENTS)})
    AND EXISTS (SELECT 1 FROM json_each(t.schedule_json, '$.filters') f
      WHERE json_extract(f.value, '$.path') = 'body.sender.login'
        AND json_extract(f.value, '$.op') = 'notEquals'
        AND json_extract(f.value, '$.value') = ${input.botLogin})
`;

export class KinTriggerSink extends Context.Service<
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
  const store = yield* KinTriggerStore.KinTriggerStore;
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
    if (schedule === undefined) return yield* refuse(taskId, "no_source");
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
      task.projectId !== `kin:${schedule.orgId}:${schedule.agentId}` ||
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
        if (taskId.startsWith(KinSchedules.KIN_SCHEDULE_TASK_PREFIX))
          return yield* receiveSchedule(input, taskId);
        const source = yield* store.sourceByTaskId(taskId);
        if (source === undefined) {
          // Kin's task ids are deterministic, so a fire racing a remove still refuses to launch.
          if (yield* isKinTask(sql, taskId)) {
            yield* Effect.logWarning("Kin scheduled task refused: no Kin source for it").pipe(
              Effect.annotateLogs({ scheduledTaskId: taskId }),
            );
            return yield* new KinTriggerSinkRefused({
              scheduledTaskId: taskId,
              reason: "no_source",
            });
          }
          return;
        }
        const prefix = `scheduled-task:${taskId}:webhook:`;
        // `status` is what trigger_reconcile last saw; the task shape and secret below are the gate.
        if (!input.commandId.startsWith(prefix))
          return yield* new KinTriggerInbox.KinTriggerInboxConflict({
            orgId: source.orgId,
            reason: "unknown_source",
          });
        const deliveryId = yield* decodeDeliveryId(input.commandId.slice(prefix.length));
        const [row] = yield* findLaunchDelivery(sql, {
          taskId,
          deliveryId,
          projectId: input.projectId,
          botLogin: source.botLogin,
        }).pipe(Effect.mapError(toPersistenceSqlError("KinTriggerSink.receive")));
        if (row === undefined)
          return yield* new KinTriggerInbox.KinTriggerInboxConflict({
            orgId: source.orgId,
            reason: "unknown_source",
          });
        const delivery = yield* decodeDelivery({ receivedAt: row.receivedAt }).pipe(
          Effect.mapError((cause) =>
            PersistenceDecodeError.fromSchemaError("KinTriggerSink.receive", cause),
          ),
        );
        if (
          !(yield* store.acceptsDelivery(source.orgId, source.id, {
            secret: Redacted.make(row.secret),
            receivedAt: DateTime.toEpochMillis(delivery.receivedAt),
          }))
        )
          return yield* new KinTriggerInbox.KinTriggerInboxConflict({
            orgId: source.orgId,
            reason: "unknown_source",
          });
        const projection = yield* threads.getThreadProjection(source.inboxThreadId);
        if (projection.thread.projectId !== input.projectId || projection.thread.deletedAt !== null)
          return yield* new KinTriggerInbox.KinTriggerInboxConflict({
            orgId: source.orgId,
            reason: "unknown_source",
          });
        const memoryRepo = yield* configuredGithubMemoryRepo(source.orgId);
        if (
          typeof row.repo === "string" &&
          memoryRepo !== undefined &&
          row.repo.toLowerCase() === memoryRepo.toLowerCase()
        )
          return { threadId: source.inboxThreadId, projection, resumed: false };
        const now = yield* Clock.currentTimeMillis;
        const event = yield* decodeFire({
          fireId: KinTriggerFireId.make(`gh:${source.orgId}:${deliveryId}`),
          orgId: source.orgId,
          dueAt: DateTime.formatIso(delivery.receivedAt),
          firedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          lateByMs: Math.max(0, now - DateTime.toEpochMillis(delivery.receivedAt)),
          payload: { kind: "github", sourceId: source.id, scheduledTaskId: taskId, deliveryId },
        });
        yield* inbox.put(event, now);
        return { threadId: source.inboxThreadId, projection, resumed: false };
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

export const layer = Layer.effect(KinTriggerSink, make).pipe(
  Layer.provide(Layer.mergeAll(KinTriggerStore.layer, KinTriggerInbox.layer)),
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
        const store = yield* KinTriggerStore.KinTriggerStore;
        const sql = yield* SqlClient.SqlClient;
        return ThreadManagementService.ThreadManagementService.of({
          ...service,
          sendToThread: Effect.fn("KinTriggerSink.sendToThread")(function* (input) {
            if (input.scheduledTaskId === undefined) return yield* service.sendToThread(input);
            const source = yield* store.sourceByTaskId(input.scheduledTaskId).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorCommandRejectedError({
                    commandId: input.commandId,
                    commandType: "kin.trigger.bound_source",
                    cause,
                  }),
              ),
              Effect.tapError(() =>
                Effect.logWarning("Kin trigger source lookup failed").pipe(
                  Effect.annotateLogs({ scheduledTaskId: input.scheduledTaskId }),
                ),
              ),
            );
            if (source === undefined && !(yield* isKinTask(sql, input.scheduledTaskId)))
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
    Layer.provide(Layer.mergeAll(layer, KinTriggerStore.layer)),
    Layer.catchCause((cause) =>
      Layer.mergeAll(
        Layer.effectDiscard(
          KinEnabled.KinEnabled.pipe(Effect.flatMap((config) => config.reportFailure(cause))),
        ),
        Layer.effect(
          ThreadLaunchService.ThreadLaunchService,
          Effect.gen(function* () {
            const service = yield* ThreadLaunchService.ThreadLaunchService;
            const sql = yield* SqlClient.SqlClient;
            return ThreadLaunchService.ThreadLaunchService.of({
              ...service,
              launch: Effect.fn("KinTriggerSink.disabledLaunch")(function* (input) {
                const taskId = input.initialMessage?.scheduledTaskId;
                if (taskId !== undefined && (yield* isKinTask(sql, taskId)))
                  return yield* refusedLaunch(input, "Kin is unavailable");
                if (
                  taskId === undefined ||
                  !input.commandId.startsWith(`scheduled-task:${taskId}:webhook:`)
                )
                  return yield* service.launch(input);
                return yield* new ThreadLaunchService.ThreadLaunchError({
                  operation: "dispatch-message",
                  commandId: input.commandId,
                  projectId: input.projectId,
                  cause: new Error("Kin is unavailable; webhook dispatch refused.", { cause }),
                });
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
              sendToThread: Effect.fn("KinTriggerSink.disabledSend")(function* (input) {
                if (input.scheduledTaskId === undefined) return yield* service.sendToThread(input);
                const webhook =
                  (yield* isKinTask(sql, input.scheduledTaskId)) ||
                  (yield* sql`SELECT 1 FROM scheduled_tasks WHERE task_id = ${input.scheduledTaskId}
                  AND json_extract(schedule_json, '$.type') = 'webhook'`.pipe(
                    Effect.map((rows) => rows.length > 0),
                    Effect.catchCause(() => Effect.succeed(true)),
                  ));
                if (!webhook) return yield* service.sendToThread(input);
                yield* Effect.logWarning("Kin scheduled task refused: Kin is unavailable").pipe(
                  Effect.annotateLogs({ scheduledTaskId: input.scheduledTaskId }),
                );
                return yield* new OrchestratorCommandRejectedError({
                  commandId: input.commandId,
                  commandType: "kin.trigger.disabled",
                  cause,
                });
              }),
            });
          }),
        ),
      ),
    ),
    Layer.provide(Layer.mergeAll(inner, threads)),
  );
  const degraded = Layer.mergeAll(
    Layer.effect(
      ThreadLaunchService.ThreadLaunchService,
      Effect.gen(function* () {
        const service = yield* ThreadLaunchService.ThreadLaunchService;
        const sql = yield* SqlClient.SqlClient;
        return ThreadLaunchService.ThreadLaunchService.of({
          ...service,
          launch: Effect.fn("KinTriggerSink.degradedLaunch")(function* (input) {
            const taskId = input.initialMessage?.scheduledTaskId;
            if (taskId !== undefined && (yield* isKinTask(sql, taskId)))
              return yield* refusedLaunch(input, "Kin is unavailable");
            if (
              input.initialMessage?.scheduledTaskId !== undefined &&
              input.commandId.startsWith(
                `scheduled-task:${input.initialMessage.scheduledTaskId}:webhook:`,
              )
            )
              return yield* new ThreadLaunchService.ThreadLaunchError({
                operation: "dispatch-message",
                commandId: input.commandId,
                projectId: input.projectId,
                cause: new Error("Kin is unavailable; webhook dispatch refused."),
              });
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
          sendToThread: Effect.fn("KinTriggerSink.degradedSend")(function* (input) {
            if (
              input.scheduledTaskId !== undefined &&
              (yield* isKinTask(sql, input.scheduledTaskId))
            )
              return yield* refusedSend(input, "kin.trigger.unavailable", "Kin is unavailable");
            if (
              input.scheduledTaskId !== undefined &&
              input.commandId.startsWith(`scheduled-task:${input.scheduledTaskId}:webhook:`)
            )
              return yield* new OrchestratorCommandRejectedError({
                commandId: input.commandId,
                commandType: "kin.trigger.unavailable",
                cause: new Error("Kin is unavailable; webhook dispatch refused."),
              });
            return yield* service.sendToThread(input);
          }),
        });
      }),
    ),
  ).pipe(Layer.provide(Layer.mergeAll(inner, threads)));
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
                  degraded.pipe(
                    Layer.provideMerge(Layer.effectDiscard(config.reportFailure(cause))),
                  ),
                ),
              )
            : kinOwnedRefused(inner, threads, "Kin is off"),
      ),
    ),
  ).pipe(Layer.provide(KinEnabled.layer));
}

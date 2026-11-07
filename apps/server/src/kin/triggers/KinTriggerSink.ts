import {
  CanonicalUtcTimestamp,
  KinTriggerFireId,
  KinTriggerFired,
  ScheduledTaskWebhookDeliveryId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { PersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";

const Delivery = Schema.Struct({ receivedAt: CanonicalUtcTimestamp });
const decodeDelivery = Schema.decodeUnknownEffect(Delivery);
const decodeFire = Schema.decodeEffect(KinTriggerFired);
const decodeDeliveryId = Schema.decodeEffect(ScheduledTaskWebhookDeliveryId);

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

  return KinTriggerSink.of({
    receive: Effect.fn("KinTriggerSink.receive")(
      function* (input) {
        const taskId = input.initialMessage?.scheduledTaskId;
        if (taskId === undefined) return;
        const source = yield* store.sourceByTaskId(taskId);
        if (source === undefined) return;
        const prefix = `scheduled-task:${taskId}:webhook:`;
        if (!input.commandId.startsWith(prefix) || source.status !== "active")
          return yield* new KinTriggerInbox.KinTriggerInboxConflict({
            orgId: source.orgId,
            reason: "unknown_source",
          });
        const deliveryId = yield* decodeDeliveryId(input.commandId.slice(prefix.length));
        const [row] = yield* sql`
          SELECT d.received_at AS "receivedAt" FROM scheduled_task_webhook_deliveries d
          JOIN scheduled_tasks t ON t.task_id = d.task_id
          JOIN kin_agent_threads k ON k.thread_id = ${source.inboxThreadId} AND k.org_id = ${source.orgId}
          JOIN orchestration_v2_projection_threads p ON p.thread_id = k.thread_id AND p.project_id = t.project_id
          WHERE d.task_id = ${taskId} AND d.delivery_id = ${deliveryId}
            AND t.project_id = ${input.projectId} AND k.ended_at IS NULL
            AND t.thread_id IS NULL AND t.thread_mode = 'new_thread'
            AND json_extract(t.schedule_json, '$.type') = 'webhook'
        `.pipe(Effect.mapError(toPersistenceSqlError("KinTriggerSink.receive")));
        if (row === undefined)
          return yield* new KinTriggerInbox.KinTriggerInboxConflict({
            orgId: source.orgId,
            reason: "unknown_source",
          });
        const delivery = yield* decodeDelivery(row).pipe(
          Effect.mapError((cause) =>
            PersistenceDecodeError.fromSchemaError("KinTriggerSink.receive", cause),
          ),
        );
        const projection = yield* threads.getThreadProjection(source.inboxThreadId);
        if (projection.thread.projectId !== input.projectId || projection.thread.deletedAt !== null)
          return yield* new KinTriggerInbox.KinTriggerInboxConflict({
            orgId: source.orgId,
            reason: "unknown_source",
          });
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

export function wrapThreadLaunch<E, R, E2, R2>(
  inner: Layer.Layer<ThreadLaunchService.ThreadLaunchService, E, R>,
  threads: Layer.Layer<ThreadManagementService.ThreadManagementService, E2, R2>,
) {
  return Layer.effect(
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
  ).pipe(Layer.provide(inner), Layer.provide(layer.pipe(Layer.provide(threads))));
}

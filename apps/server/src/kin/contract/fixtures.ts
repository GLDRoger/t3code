import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  OrchestrationV2DomainEventJson,
  ScheduledTaskUpsertInput,
  type ManagedPolicyDocument,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { emptyProjection } from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as KinTriggerSink from "../triggers/KinTriggerSink.ts";
import * as KinTriggerStore from "../triggers/KinTriggerStore.ts";

const decodeEvent = Schema.decodeSync(OrchestrationV2DomainEventJson);

const decodeUpsert = Schema.decodeEffect(ScheduledTaskUpsertInput);

const projection = () => {
  const event = decodeEvent({
    id: "event-contract",
    threadId: "thread-contract",
    type: "thread.created",
    occurredAt: "2026-11-08T00:00:00.000Z",
    payload: {
      id: "thread-contract",
      projectId: "project-contract",
      title: "Inbox",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: "thread-contract",
      },
      forkedFrom: null,
      createdBy: "system",
      creationSource: "server",
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-08T00:00:00.000Z",
      archivedAt: "2026-11-08T00:00:00.000Z",
      deletedAt: null,
    },
  });
  if (event.type !== "thread.created") throw new Error("Expected thread.created");
  return emptyProjection(event);
};

export const webhookInput = (overrides: Partial<typeof ScheduledTaskUpsertInput.Encoded> = {}) =>
  decodeUpsert({
    id: "kin-github",
    title: "GitHub inbox",
    prompt: "Review {{body}}",
    enabled: true,
    schedule: { type: "webhook" },
    projectId: "project-contract",
    threadMode: "new_thread",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

export const withScheduledTasks = Effect.fn("KinContract.withScheduledTasks")(function* <A, E>(
  body: (input: {
    service: ScheduledTasks.ScheduledTaskService["Service"];
    launches: Queue.Queue<ThreadLaunch.ThreadLaunchInput>;
    sends: Queue.Queue<ThreadManagement.ThreadManagementSendInput>;
    launchDeliveries: Queue.Queue<ReadonlyArray<{ readonly receivedAt: unknown }>>;
    launchInFlight: Queue.Queue<number>;
  }) => Effect.Effect<A, E, SqlClient.SqlClient>,
  policy?: ManagedPolicyDocument,
) {
  const sql = yield* SqlClient.SqlClient;
  const launchDeliveries =
    yield* Queue.unbounded<ReadonlyArray<{ readonly receivedAt: unknown }>>();
  const launches = yield* Queue.unbounded<ThreadLaunch.ThreadLaunchInput>();
  const launchInFlight = yield* Queue.unbounded<number>();
  const sends = yield* Queue.unbounded<ThreadManagement.ThreadManagementSendInput>();
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Scheduler.layer,
    ManagedPolicy.layerTest(policy),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: Effect.fn("KinContract.launch")(function* (input) {
        const taskId = input.initialMessage?.scheduledTaskId;
        const prefix = `scheduled-task:${taskId}:webhook:`;
        const deliveryId = input.commandId.slice(prefix.length);
        const rows = yield* KinTriggerSink.findLaunchDelivery(sql, {
          taskId: taskId ?? "",
          deliveryId,
          projectId: input.projectId,
        }).pipe(Effect.orDie);
        yield* Queue.offer(launchDeliveries, rows);
        const inFlight = yield* KinTriggerStore.inFlightDeliveries(sql, taskId ?? "").pipe(
          Effect.orDie,
        );
        yield* Queue.offer(launchInFlight, inFlight.length);
        yield* Queue.offer(launches, input);
        const result = projection();
        return { threadId: result.thread.id, projection: result, resumed: false };
      }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      // Only the input boundary is under contract; no orchestrator runs in this fixture.
      sendToThread: (input) =>
        Queue.offer(sends, input).pipe(Effect.andThen(Effect.die("send boundary reached"))),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.succeed(
      ScheduledTasks.ScheduledTaskWebhookOrigin,
      Effect.succeed({ relayHookBaseUrl: null }),
    ),
  );
  return yield* Effect.gen(function* () {
    const service = yield* ScheduledTasks.ScheduledTaskService;
    return yield* body({ service, launches, sends, launchDeliveries, launchInFlight });
  }).pipe(Effect.provide(Layer.fresh(ScheduledTasks.layer.pipe(Layer.provide(dependencies)))));
});

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  OrchestrationV2ThreadProjectionJson,
  ScheduledTaskUpsertInput,
  type ManagedPolicyDocument,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";

const decodeProjection = Schema.decodeSync(OrchestrationV2ThreadProjectionJson);

const decodeUpsert = Schema.decodeEffect(ScheduledTaskUpsertInput);

const projection = () =>
  decodeProjection({
    thread: {
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
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: "2026-11-08T00:00:00.000Z",
  });

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
  }) => Effect.Effect<A, E, SqlClient.SqlClient>,
  policy?: ManagedPolicyDocument,
) {
  const launches = yield* Queue.unbounded<ThreadLaunch.ThreadLaunchInput>();
  const sends = yield* Queue.unbounded<ThreadManagement.ThreadManagementSendInput>();
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Scheduler.layer,
    ManagedPolicy.layerTest(policy),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Queue.offer(launches, input).pipe(
          Effect.as({
            threadId: projection().thread.id,
            projection: projection(),
            resumed: false,
          }),
        ),
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
    return yield* body({ service, launches, sends });
  }).pipe(Effect.provide(Layer.fresh(ScheduledTasks.layer.pipe(Layer.provide(dependencies)))));
});

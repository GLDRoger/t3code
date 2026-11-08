// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import * as Crypto from "@effect/platform-node/NodeCrypto";
import {
  KinOrgId,
  OrchestrationV2ThreadProjectionJson,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

import { OrchestratorCommandRejectedError } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as KinTriggerSink from "./KinTriggerSink.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";

export const timestamp = "2026-11-07T00:00:00.000Z";
const decodeProjection = Schema.decodeSync(OrchestrationV2ThreadProjectionJson);

export const projection = (orgId: KinOrgId, archivedAt: string | null = timestamp) =>
  decodeProjection({
    thread: {
      id: `inbox-${orgId}`,
      projectId: `project-${orgId}`,
      title: "Inbox",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: `inbox-${orgId}` },
      forkedFrom: null,
      createdBy: "system",
      creationSource: "server",
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt,
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
    updatedAt: timestamp,
  });

// The runWebhookDelivery span ends after both delivery and run completion are persisted.
export const waitForDispatch = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (...args) => {
          end(...args);
          if (span.name === "ScheduledTaskService.runWebhookDelivery")
            Deferred.doneUnsafe(done, Effect.void);
        };
        return span;
      },
    });
    const result = yield* work.pipe(Effect.withTracer(tracer));
    yield* Deferred.await(done);
    return result;
  });

const decodeUpsert = Schema.decodeEffect(ScheduledTaskUpsertInput);
const orgOf = (id: string) => KinOrgId.make(id.replace(/^(inbox|project)-/, ""));

/** An enabled, unbound GitHub-shaped webhook task signed with `test-secret`. */
export const webhookTask = (id: string, projectId: string) =>
  decodeUpsert({
    id,
    title: "Kin webhook",
    prompt: "Do nothing",
    enabled: true,
    projectId,
    threadId: null,
    threadMode: "new_thread",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    schedule: {
      type: "webhook",
      signature: {
        header: "x-hub-signature-256",
        encoding: "hex",
        prefix: "sha256=",
        secret: "test-secret",
      },
      dedupe: { replayKey: KinTriggerStore.GITHUB_REPLAY_KEY },
      filters: [
        { path: "headers.x-github-event", op: "in", value: KinTriggerStore.GITHUB_EVENTS },
        { path: "body.sender.login", op: "notEquals", value: "kin[bot]" },
      ],
    },
  });

/** The real `ScheduledTaskService`, dispatching through Kin's sink; inner launches and sends are recorded. */
export const withScheduledTasks = <A, E, R>(
  body: (
    service: ScheduledTaskService.ScheduledTaskService["Service"],
    launches: ThreadLaunchService.ThreadLaunchInput[],
    sends: ThreadManagementService.ThreadManagementSendInput[],
  ) => Effect.Effect<A, E, R>,
  workers?: Map<string, Effect.Effect<void>>,
  policy?: Parameters<typeof ManagedPolicy.layerTest>[0],
) =>
  Effect.gen(function* () {
    const launches: ThreadLaunchService.ThreadLaunchInput[] = [];
    const sends: ThreadManagementService.ThreadManagementSendInput[] = [];
    const boundThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadProjection: (id) => Effect.succeed(projection(orgOf(id))),
      sendToThread: (input) =>
        Effect.gen(function* () {
          sends.push(input);
          return yield* new OrchestratorCommandRejectedError({
            commandId: input.commandId,
            commandType: "test.inner_send",
          });
        }),
    });
    const inner = Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          launches.push(input);
          const view = projection(orgOf(input.projectId));
          return { threadId: view.thread.id, projection: view, resumed: false };
        }),
    });
    const serviceLayer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          KinTriggerSink.wrapTaskDispatch(inner, boundThreads),
          Crypto.layer,
          workers === undefined
            ? Scheduler.layer
            : Layer.succeed(Scheduler.Scheduler, {
                register: Effect.fn("KinWebhooksTestkit.register")(function* <E2, R2>(
                  name: string,
                  work: Effect.Effect<void, E2, R2>,
                ) {
                  const context = yield* Effect.context<R2>();
                  workers.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
                }),
              }),
          ManagedPolicy.layerTest(policy),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          Layer.succeed(
            ScheduledTaskService.ScheduledTaskWebhookOrigin,
            Effect.succeed({ relayHookBaseUrl: null }),
          ),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      return yield* body(yield* ScheduledTaskService.ScheduledTaskService, launches, sends);
    }).pipe(Effect.provide(serviceLayer));
  });

/** A webhook request GitHub would send, signed with `test-secret` unless told otherwise. */
export const signedRequest = (
  task: { id: string; webhook?: { path: string } | undefined },
  githubDelivery: string,
  payload: unknown,
  event = "pull_request",
  secret = "test-secret",
) => {
  const bodyText = JSON.stringify(payload);
  return {
    hookId: task.id,
    token: task.webhook?.path.split("/").at(-1) ?? "",
    method: "POST",
    path: "/api/hooks",
    query: "",
    bodyText,
    body: new TextEncoder().encode(bodyText),
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": githubDelivery,
      "x-hub-signature-256": `sha256=${NodeCrypto.createHmac("sha256", secret).update(bodyText).digest("hex")}`,
    },
  };
};

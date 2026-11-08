import { type KinOrgId, OrchestrationV2ThreadProjectionJson } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

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

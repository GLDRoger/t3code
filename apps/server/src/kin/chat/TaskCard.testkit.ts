import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";

export const environment = Layer.mock(ServerEnvironment)({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
});
export const orchestration = Layer.merge(
  environment,
  Layer.mock(OrchestratorV2)({
    getThreadShell: (threadId) =>
      Effect.succeed({
        ...liveThreadShell(threadId),
        lineage: {
          rootThreadId: ThreadId.make("lead-thread"),
          parentThreadId: threadId === "unlinked" ? null : ThreadId.make("lead-thread"),
          relationshipToParent: threadId === "unlinked" ? null : ("subagent" as const),
        },
      }),
    streamDomainEvents: Stream.empty,
  }),
);

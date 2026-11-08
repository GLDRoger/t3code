import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";

export const orchestration = Layer.mock(OrchestratorV2)({
  getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
  streamDomainEvents: Stream.empty,
});

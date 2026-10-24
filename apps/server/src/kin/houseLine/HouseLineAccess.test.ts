import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  lineageToolsForProfile,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import type { McpCapability } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as HouseLine from "./HouseLineService.ts";

it("hides will reads and crowns from a reviewer", () => {
  const reviewer = lineageToolsForProfile({ role: "reviewer", crownable: true, seesWills: true });
  const implementer = lineageToolsForProfile({ role: "implementer" });
  assert.equal(
    reviewer.some(
      (tool) => tool.willRead || tool.name === "lineage_crown" || tool.name === "lineage_will",
    ),
    false,
  );
  assert.equal(
    reviewer.some((tool) => tool.name === "lineage_read"),
    true,
  );
  assert.equal(
    implementer.some((tool) => tool.name === "lineage_read" && tool.willRead),
    true,
  );
  assert.equal(
    implementer.some((tool) => tool.name === "lineage_crown"),
    true,
  );
});

const threadId = ThreadId.make("thread-reviewer");

const layerDenied = Layer.mergeAll(
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make("env-reviewer"),
    capabilities: new Set<McpCapability>(),
    issuedAt: 0,
    requestNamespace: "kin-house-line",
    thread: {
      threadId,
      providerSessionId: "session-reviewer",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  }),
  Layer.mock(HouseLine.HouseLineService)({
    seesWills: () => Effect.succeed(false),
    crownable: () => Effect.succeed(false),
  }),
);

it.effect("McpToolAccess denies will reads and crowns for a blind lane", () =>
  Effect.gen(function* () {
    const read = yield* McpToolAccess.assertHouseLineSeesWills().pipe(Effect.flip);
    const crown = yield* McpToolAccess.assertHouseLineCrownable().pipe(Effect.flip);
    assert.equal(read._tag, "OrchestratorMcpFailure");
    assert.equal(read.code, "capability_denied");
    assert.equal(crown.code, "capability_denied");
  }).pipe(Effect.provide(layerDenied)),
);

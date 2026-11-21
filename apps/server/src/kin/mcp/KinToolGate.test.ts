import * as NodeUtil from "node:util";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Predicate from "effect/Predicate";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";

import * as Kin from "../layer.ts";
import { KinDocumentToolkit } from "../gendocs/mcp.ts";
import { TURN_EVENT_TOOLS } from "../lead/eventIds.ts";
import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import { KinPulseToolkit } from "../pulse/mcp.ts";
import { KinDocsToolkit } from "../work/mcp/docTools.ts";
import { KinStatementToolkit } from "../work/mcp/statementTools.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";
import { callCounts } from "./KinToolGate.ts";

it("fills the event of every Kin tool that takes one, and of no other", () => {
  const takes = [
    KinLeadToolkit,
    KinWorkToolkit,
    KinDocsToolkit,
    KinStatementToolkit,
    KinDocumentToolkit,
    KinPulseToolkit,
  ].flatMap((toolkit) =>
    Object.values(toolkit.tools).flatMap((tool) =>
      Predicate.hasProperty(tool.parametersSchema, "fields") &&
      Predicate.hasProperty(tool.parametersSchema.fields, "sourceEventId")
        ? [tool.name]
        : [],
    ),
  );
  assert.isDefined(Kin.layer);
  assert.deepStrictEqual([...TURN_EVENT_TOOLS].toSorted(), takes.toSorted());
});

const Invented = Toolkit.make(
  ...["invented_read", "invented_write"].map((name) =>
    Tool.make(name, {
      description: "Invented: a tool an agent calls.",
      success: Schema.Struct({ ran: Schema.String }),
      failure: OrchestratorMcpFailure,
      failureMode: "return",
    }),
  ),
);
const inventedHandlers = McpToolAccess.toLayer(Invented, {
  invented_read: McpToolAccess.reads(() => Effect.succeed({ ran: "read" })),
  invented_write: McpToolAccess.reads(() => Effect.succeed({ ran: "write" })),
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("counts each tool's calls in memory and logs them in one line an hour", () => {
  const lines: Array<string> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string) =>
      server.callTool({ name, arguments: {} }).pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          requestNamespace: "lead",
          issuedAt: 0,
          capabilities: new Set(),
          client: undefined,
          thread: {
            threadId: ThreadId.make("lead-thread"),
            providerSessionId: "lead",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
        }),
      );
    yield* call("invented_read");
    yield* call("invented_read");
    yield* call("invented_write");
    assert.deepStrictEqual(lines, []);
    yield* TestClock.adjust("1 hour");
    assert.lengthOf(lines, 1);
    assert.include(lines[0], "Kin tool calls");
    assert.include(lines[0], "invented_read: 2");
    assert.include(lines[0], "invented_write: 1");
    // A quiet hour logs nothing; the next hour counts afresh.
    yield* TestClock.adjust("1 hour");
    yield* call("invented_write");
    yield* TestClock.adjust("1 hour");
    assert.lengthOf(lines, 2);
    assert.notInclude(lines[1], "invented_read");
    assert.include(lines[1], "invented_write: 1");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        callCounts,
        McpHttpServer.toolkitRegistration(Invented, inventedHandlers),
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provideMerge(
          Logger.layer(
            [
              Logger.make(
                (options) => void lines.push(NodeUtil.inspect(options.message, { depth: 8 })),
              ),
            ],
            { mergeWithExisting: false },
          ),
        ),
      ),
    ),
  );
});

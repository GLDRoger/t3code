import { KinChatError, OrchestratorMcpFailure } from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { withAlwaysLoaded } from "../lead/deferredTools.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { PipelineInput, PipelineResult, pipelineRead } from "./pipeline.ts";
import { WebPageInput, WebPageResult, webPage } from "./read.ts";
import { PIPELINE_READ_DESCRIPTION, WEB_PAGE_DESCRIPTION } from "./text.ts";
import * as WebPages from "./webPage.ts";

// tools/list runs this before handler services are provided; the Kin MCP endpoint provides `KinIdentity`.
const enabled = McpToolAccess.threadBoundGate(() => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const scope = Context.getOrUndefined(fiber.context, McpInvocationContext);
  const identity = Context.getOrUndefined(fiber.context, KinIdentity);
  return (
    scope?.thread !== undefined &&
    scope.thread.subagent !== true &&
    identity?.isLeadThread(scope.thread.threadId) === true
  );
});
const shared = {
  failure: Schema.Union([KinChatError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [McpInvocationContext, KinIdentity, KinRecords, SqlClient.SqlClient],
};

/** The sales seat's tools: the pipeline as the turn's people see it, and one public page. */
export const KinSalesToolkit = Toolkit.make(
  Tool.make("pipeline_read", {
    ...shared,
    description: PIPELINE_READ_DESCRIPTION,
    parameters: PipelineInput,
    success: PipelineResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("web_page", {
    ...shared,
    dependencies: [...shared.dependencies, WebPages.KinWebPages],
    description: WEB_PAGE_DESCRIPTION,
    parameters: WebPageInput,
    success: WebPageResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
);

const isKinChatError = Schema.is(KinChatError);
const failure = (error: unknown) =>
  isKinChatError(error)
    ? error
    : new KinChatError({ reason: "unavailable", message: "Kin couldn't do that right now." });

// Kin's services check the persisted lead and wake-up, rather than T3 thread-control grants.
const handlers = McpToolAccess.toLayer(KinSalesToolkit, {
  pipeline_read: McpToolAccess.reads(
    Effect.fn("KinSalesToolkit.pipeline")(function* (input) {
      return yield* pipelineRead(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  web_page: McpToolAccess.reads(
    Effect.fn("KinSalesToolkit.webPage")(function* (input) {
      return yield* webPage(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
});

export const registration = McpHttpServer.toolkitRegistration(
  withAlwaysLoaded(KinSalesToolkit),
  handlers,
).pipe(
  Layer.provide(WebPages.layer),
);

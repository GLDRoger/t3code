import { KinChatError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { ServerConfig } from "../../config.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinDocRenderer } from "../gendocs/render.ts";
import { deferredMeta } from "../lead/deferredTools.ts";
import * as Lead from "../lead/LeadMemory.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { makePicture, PictureInput, PictureResult } from "./picture.ts";
import { KinPictureRenderer } from "./renderer.ts";

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

export const KinPictureToolkit = Toolkit.make(
  Tool.make("kin_picture", {
    failure: Schema.Union([KinChatError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [
      Lead.LeadMemory,
      McpInvocationContext,
      ThreadManagementService,
      KinIdentity,
      KinRecords,
      KinDocRenderer,
      KinLevelGate,
      KinPictureRenderer,
      SqlClient.SqlClient,
      FileSystem.FileSystem,
      ServerConfig,
    ],
    description: "Make a picture file from one page of HTML, drawn at a named size.",
    parameters: PictureInput,
    success: PictureResult,
  })
    .annotate(McpSchema.EnabledWhen, enabled)
    .annotate(Tool.Meta, deferredMeta),
);

const isKinChatError = Schema.is(KinChatError);
const failure = (error: unknown) =>
  isKinChatError(error)
    ? error
    : new KinChatError({
        reason: "unavailable",
        message: "Kin can't make pictures right now, so nothing was made.",
      });

// Kin's service checks the persisted lead and wake-up, rather than T3 thread-control grants.
export const handlers = McpToolAccess.toLayer(KinPictureToolkit, {
  kin_picture: McpToolAccess.actsAsCaller(
    Effect.fn("KinPictureToolkit.picture")(function* (input) {
      return yield* makePicture(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
});

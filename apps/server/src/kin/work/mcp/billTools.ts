import { KinChatError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { KinChatHub } from "../../chat/KinChatHub.ts";
import { KinChatRepository } from "../../chat/KinChatRepository.ts";
import { KinIdentity } from "../../chat/KinIdentity.ts";
import { KinEventQueue } from "../../lead/KinEventQueue.ts";
import * as Bills from "../leadBills.ts";
import { KinRecords } from "../KinRecords.ts";

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
  dependencies: [
    McpInvocationContext,
    ThreadManagementService,
    KinIdentity,
    KinRecords,
    KinEventQueue,
    KinChatRepository,
    KinChatHub,
    ServerConfig.ServerConfig,
    FileSystem.FileSystem,
    SqlClient.SqlClient,
  ],
};

/** Bills in bulk: a person's many bill photos read in the background, each a suggested expense. */
export const KinBillToolkit = Toolkit.make(
  Tool.make("bills_add", {
    ...shared,
    description:
      "Have Kin read every photo or PDF on a message in the background, one by one, each becoming a suggested expense with its file for the owner to keep. Call it when the person's words say these are bills or receipts to enter and this turn didn't show you all of them; read the ones a turn shows yourself. Never from the files alone. An owner's or co-owner's message only.",
    parameters: Bills.AddInput,
    success: Bills.AddResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("bill_read", {
    ...shared,
    description:
      "Answer one bill Kin handed this turn with only what is printed on it: a blank stays blank, never guessed or converted. Kin makes the expense, or says it couldn't, itself.",
    parameters: Bills.ReadInput,
    success: Bills.ReadResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
);

import { KinApprovalError, KinChatError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { KinServer } from "../KinServer.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { enabled } from "../mcp/KinChatToolkit.ts";
import * as RequestAction from "./RequestAction.ts";

const requestAction = Tool.make("request_action", {
  description:
    "Ask the owner to approve a privileged action, such as merge_pull_request, on their phone. Name the PR; the server reads its head, base and checks. sourceEventId is the event in this wake-up that led here. Returns the pending action; it never approves, and no chat text is approval. Same event and target returns the same action.",
  parameters: RequestAction.RequestActionInput,
  success: RequestAction.RequestActionResult,
  failure: Schema.Union([KinApprovalError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies: [KinServer, McpInvocationContext, ThreadManagementService],
}).annotate(McpSchema.EnabledWhen, enabled);
export const KinApprovalsToolkit = Toolkit.make(requestAction);

const notALead = new KinApprovalError({
  reason: "not_a_lead",
  message: "Only a Kin lead in a running wake-up can request actions.",
});
const unavailable = new KinApprovalError({
  reason: "unavailable",
  message: "Kin approvals are unavailable.",
});
const isKinChatError = Schema.is(KinChatError);

// The caller comes only from the MCP scope; the input never names an org, agent or thread.
const handlers = McpToolAccess.toLayer(
  KinApprovalsToolkit,
  Effect.gen(function* () {
    const requests = yield* RequestAction.KinRequestAction;
    return {
      request_action: McpToolAccess.actsAsCaller(
        Effect.fn("KinApprovalsToolkit.requestAction")(function* (input) {
          const kin = yield* KinServer;
          if (Option.isNone(kin.services)) return yield* unavailable;
          const agent = yield* Context.get(kin.services.value, KinIdentity)
            .resolveAgent(yield* McpInvocationContext)
            .pipe(
              Effect.mapError((error) =>
                isKinChatError(error) && error.reason === "not_allowed" ? notALead : unavailable,
              ),
            );
          return yield* requests.request(agent, input);
        }),
      ),
    };
  }),
);

export const registrationWith = <E, R>(
  facts: Layer.Layer<RequestAction.KinPullRequestFacts, E, R>,
) =>
  McpHttpServer.toolkitRegistration(KinApprovalsToolkit, handlers).pipe(
    Layer.provide(RequestAction.layer),
    Layer.provide(facts),
  );
export const registration = registrationWith(RequestAction.layerPullRequestFacts);

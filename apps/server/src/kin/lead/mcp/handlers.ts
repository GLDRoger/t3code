// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous retry-key hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import { KinChatError, KinWakeupId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { laneFor } from "../../reply/KinReplyBridge.ts";
import { KinLevelGate } from "../LevelGate.ts";
import { LeadMemory, resolveLead } from "../LeadMemory.ts";
import { KinWorkers } from "../Workers.ts";
import { KinLeadToolkit } from "./tools.ts";

const isKinChatError = Schema.is(KinChatError);
const failure = (error: unknown) =>
  isKinChatError(error)
    ? error
    : new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });

// Kin's service checks the persisted lead and wake-up, rather than T3 thread-control grants.
export const handlers = McpToolAccess.toLayer(KinLeadToolkit, {
  kin_delegate: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.delegate")(function* (input) {
      return yield* (yield* KinWorkers).delegate(yield* McpInvocationContext, input);
    }),
  ),
  kin_follow_up: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.followUp")(function* (input) {
      return yield* (yield* KinWorkers).followUp(yield* McpInvocationContext, input);
    }),
  ),
  kin_worker_stop: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.workerStop")(function* (input) {
      return yield* (yield* KinWorkers).stop(yield* McpInvocationContext, input);
    }),
  ),
  kin_ask: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.ask")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      const wakeupId = KinWakeupId.make(lead.wakeupId);
      const lane = yield* laneFor({ orgId: lead.orgId, agentId: lead.agentId, wakeupId });
      if (Option.isNone(lane))
        return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
      // An identical call in the same wake-up is a retry and returns the same card.
      const key = NodeCrypto.createHash("sha256").update(stableStringify(input)).digest("hex");
      const result = yield* (yield* KinLevelGate).ask(
        { ...lead, wakeupId },
        {
          ...input,
          chatId: lane.value.chatId,
          clientMessageId: `kin-ask:${wakeupId}:${key.slice(0, 32)}`,
        },
      );
      return "shadowed" in result
        ? result
        : { widgetId: result.widgetId, messageId: result.messageId };
    }, Effect.mapError(failure)),
  ),
  kin_react: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.react")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      const wakeupId = KinWakeupId.make(lead.wakeupId);
      const lane = yield* laneFor({ orgId: lead.orgId, agentId: lead.agentId, wakeupId });
      if (Option.isNone(lane))
        return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
      return yield* (yield* KinLevelGate).react(
        { ...lead, wakeupId },
        { ...input, chatId: lane.value.chatId },
      );
    }, Effect.mapError(failure)),
  ),
  memory_search: McpToolAccess.reads(
    Effect.fn("KinLeadToolkit.search")(function* (input) {
      return yield* (yield* LeadMemory).search(yield* McpInvocationContext, input);
    }),
  ),
  memory_read: McpToolAccess.reads(
    Effect.fn("KinLeadToolkit.read")(function* (input) {
      return yield* (yield* LeadMemory).read(yield* McpInvocationContext, input);
    }),
  ),
  memory_write: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.write")(function* (input) {
      return yield* (yield* LeadMemory).write(yield* McpInvocationContext, input);
    }),
  ),
  kin_defer: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.defer")(function* (input) {
      return yield* (yield* LeadMemory).defer(yield* McpInvocationContext, input);
    }),
  ),
  kin_journal: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.journal")(function* (input) {
      return yield* (yield* LeadMemory).journal(yield* McpInvocationContext, input);
    }),
  ),
  kin_end: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.end")(function* (input) {
      return yield* (yield* LeadMemory).end(yield* McpInvocationContext, input);
    }),
  ),
});

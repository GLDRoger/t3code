import type { KinChatActivityPhase, KinChatId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";

// The /kin/mcp middleware provides both to every tool call; other callers get no status.
const callerHub = Effect.gen(function* () {
  const hub = yield* Effect.serviceOption(KinChatHub);
  const identity = yield* Effect.serviceOption(KinIdentity);
  if (Option.isNone(hub) || Option.isNone(identity)) return Option.none();
  const agent = yield* identity.value.resolveAgent(yield* McpInvocationContext);
  return Option.some({ hub: hub.value, agent });
});

/** Shows the owner what the calling lead is doing in the chats its wake-up answers. */
export const announceToolPhase = Effect.fn("KinToolPhase.announce")(
  function* (phase: KinChatActivityPhase) {
    const caller = yield* callerHub;
    if (Option.isSome(caller))
      yield* caller.value.hub.setWorkingPhase(
        caller.value.agent.orgId,
        caller.value.agent.agentId,
        phase,
      );
  },
  // Status is best effort; it never fails the tool call.
  (effect) => Effect.ignore(effect),
);

/** The lead's reply missed its window; the chat says so until the owner writes again. */
export const announceReplyLate = Effect.fn("KinToolPhase.replyLate")(
  function* (chatId: KinChatId) {
    const caller = yield* callerHub;
    if (Option.isSome(caller))
      yield* caller.value.hub.setActivity({
        orgId: caller.value.agent.orgId,
        agentId: caller.value.agent.agentId,
        chatIds: [chatId],
        phase: "reply_late",
      });
  },
  (effect) => Effect.ignore(effect),
);

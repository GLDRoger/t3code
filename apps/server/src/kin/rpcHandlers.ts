import { KinRpcs } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { makeKinApprovalHandlers } from "./approvals/rpcHandlers.ts";
import { makeKinChatHandlers } from "./chat/rpcHandlers.ts";
import { makeKinLevelHandlers } from "./lead/rpcHandlers.ts";
import { KinServer } from "./KinServer.ts";
import { makeKinPushHandlers } from "./push/rpcHandlers.ts";
import { makeKinWebhookHandlers } from "./triggers/webhookRpcHandlers.ts";

const group = RpcGroup.make(...KinRpcs);

export const makeKinHandlers = Effect.fn("makeKinHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  return group.of({
    ...(yield* makeKinChatHandlers(session)),
    ...(yield* makeKinApprovalHandlers(
      session,
      Option.flatMap(kin, (kin) => kin.services),
    )),
    ...(yield* makeKinLevelHandlers(session)),
    ...(yield* makeKinPushHandlers(session)),
    ...(yield* makeKinWebhookHandlers(session)),
  });
});

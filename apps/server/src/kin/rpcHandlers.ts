import { KinRpcs } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { makeKinChatHandlers } from "./chat/rpcHandlers.ts";

const group = RpcGroup.make(...KinRpcs);

export const makeKinHandlers = Effect.fn("makeKinHandlers")(function* (
  session: AuthenticatedSession,
) {
  return group.of({
    ...(yield* makeKinChatHandlers(session)),
  });
});

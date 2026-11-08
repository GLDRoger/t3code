import { KinApprovalError, KinApprovalRpcs } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { ApproverKeys, type KinKeyCaller } from "./ApproverKeys.ts";
import { GrantVerifier } from "./GrantVerifier.ts";

const group = RpcGroup.make(...KinApprovalRpcs);
// Methods refuse until their task lands (APPR-3, -10). Approving only goes through GrantVerifier.
const unavailable = Effect.fail(
  new KinApprovalError({ reason: "unavailable", message: "Kin approvals are unavailable." }),
);

// The WS upgrade request, so `confirmKey` can tell a loopback socket from a proxied one.
const connectionOf = Effect.serviceOption(HttpServerRequest.HttpServerRequest).pipe(
  Effect.map(
    Option.flatMap((request) => {
      const peer = Option.getOrUndefined(request.peerAddress);
      const remote = Option.getOrUndefined(request.remoteAddress);
      if (peer !== undefined && remote !== undefined && peer !== remote) return Option.none();
      return Option.some({ remoteAddress: peer ?? remote, headers: request.headers });
    }),
  ),
);

export const makeKinApprovalHandlers = Effect.fn("makeKinApprovalHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const connection = yield* connectionOf;
  const keys = Effect.gen(function* () {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
    const services = kin.value.services.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    const caller: KinKeyCaller = { session, people, connection };
    return {
      keys: Context.get(services, ApproverKeys),
      grants: Context.get(services, GrantVerifier),
      caller,
    };
  });
  return group.of({
    "kin.approvals.list": () => Stream.fromEffect(unavailable),
    "kin.approvals.get": () => unavailable,
    "kin.approvals.challenge": (input) =>
      keys.pipe(Effect.flatMap(({ grants, caller }) => grants.challenge(caller, input))),
    "kin.approvals.submitGrant": (input) =>
      keys.pipe(Effect.flatMap(({ grants, caller }) => grants.submitGrant(caller, input))),
    "kin.approvals.reject": (input) =>
      keys.pipe(Effect.flatMap(({ grants, caller }) => grants.reject(caller, input))),
    "kin.approvals.keyChallenge": () =>
      keys.pipe(Effect.flatMap(({ keys, caller }) => keys.keyChallenge(caller))),
    "kin.approvals.registerKey": (input) =>
      keys.pipe(Effect.flatMap(({ keys, caller }) => keys.registerKey(caller, input))),
    "kin.approvals.confirmKey": (input) =>
      keys.pipe(Effect.flatMap(({ keys, caller }) => keys.confirmKey(caller, input))),
    "kin.approvals.listKeys": (input) =>
      keys.pipe(Effect.flatMap(({ keys, caller }) => keys.listKeys(caller, input))),
    "kin.approvals.revokeKey": (input) =>
      keys.pipe(Effect.flatMap(({ keys, caller }) => keys.revokeKey(caller, input))),
    "kin.audit.list": () => unavailable,
    "kin.audit.verify": () => unavailable,
  });
});

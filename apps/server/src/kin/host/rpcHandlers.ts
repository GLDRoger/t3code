import { KinChatError, KinHostRpcs, type KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { KinHostCare } from "./KinHostCare.ts";

const group = RpcGroup.make(...KinHostRpcs);
const isKinError = Schema.is(KinChatError);
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
const notFound = new KinChatError({ reason: "not_found", message: "No such org here." });

/**
 * Thin transport: the session's person in that org, then one `KinHostCare` call. Who may call
 * each method is `KIN_RPC_ACCESS` (owner level), checked before this runs.
 */
export const makeKinHostHandlers = Effect.fn("makeKinHostHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const run = Effect.fn("KinHostCare.rpc")(
    function* <A, E>(
      orgId: KinOrgId,
      method: (care: KinHostCare["Service"]) => Effect.Effect<A, E>,
    ) {
      const services = Option.flatMap(kin, (k) => k.services);
      if (Option.isNone(services)) return yield* unavailable;
      const people = yield* Context.get(services.value, KinIdentity).resolve(session);
      if (!people.some((one) => one.orgId === orgId)) return yield* notFound;
      return yield* method(Context.get(services.value, KinHostCare));
    },
    Effect.mapError((error) => (isKinError(error) ? error : unavailable)),
  );
  return group.of({
    "kin.host.status": (input) => run(input.orgId, (care) => care.status(input.orgId)),
    "kin.host.freeSpace": (input) => run(input.orgId, (care) => care.freeSpace(input.orgId)),
    "kin.host.backUpNow": (input) => run(input.orgId, (care) => care.backUpNow(input.orgId)),
    "kin.host.retry": (input) => run(input.orgId, (care) => care.retry(input.orgId)),
  });
});

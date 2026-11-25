import { KinChatError, KinWatchRpcs, type KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer, type Services } from "../KinServer.ts";
import * as FollowUps from "./followUps.ts";
import * as KinWatches from "./KinWatches.ts";
import * as WatchReads from "./readRpcs.ts";

const group = RpcGroup.make(...KinWatchRpcs);
const isKinError = Schema.is(KinChatError);
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });

/** Thin transport: the session's reader in that org, then one watch call. */
export const makeKinWatchHandlers = Effect.fn("makeKinWatchHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const run = Effect.fn("KinWatches.rpc")(
    function* <A, E>(
      orgId: KinOrgId,
      method: (reader: WatchReads.WatchReader) => Effect.Effect<A, E, Services>,
    ) {
      const services = Option.flatMap(kin, (k) => k.services);
      if (Option.isNone(services)) return yield* unavailable;
      const people = yield* Context.get(services.value, KinIdentity).resolve(session);
      return yield* WatchReads.watchReader(people, orgId).pipe(
        Effect.flatMap(method),
        Effect.provideContext(services.value),
      );
    },
    Effect.mapError((error) => (isKinError(error) ? error : unavailable)),
  );
  return group.of({
    "kin.watches.followUps": (input) =>
      run(input.orgId, (reader) => FollowUps.list(input.orgId, reader)),
    "kin.watches.list": (input) =>
      run(input.orgId, (reader) => WatchReads.list(input.orgId, reader, input)),
    "kin.watches.log": (input) =>
      run(input.orgId, (reader) => WatchReads.log(input.orgId, reader, input)),
    "kin.watches.look": (input) =>
      run(input.orgId, (reader) => KinWatches.look(input.orgId, reader, input.watchId)),
    "kin.watches.stop": (input) =>
      run(input.orgId, (reader) => KinWatches.stop(input.orgId, reader, input.watchId)),
    "kin.watches.again": (input) =>
      run(input.orgId, (reader) => KinWatches.again(input.orgId, reader, input.watchId)),
  });
});

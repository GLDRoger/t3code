import { KinChatError, KinWorkerNetworkRpcs } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../../config.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import * as Network from "./workerNetwork.ts";

const group = RpcGroup.make(...KinWorkerNetworkRpcs);
const disabled = new KinChatError({
  reason: "disabled",
  message: "Kin is not running on this host.",
});
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });

/** Thin transport: resolve the session's people, then one owner-checked network call. */
export const makeKinWorkerNetworkHandlers = Effect.fn("makeKinWorkerNetworkHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const host = Option.all({
    config: yield* Effect.serviceOption(ServerConfig),
    fs: yield* Effect.serviceOption(FileSystem.FileSystem),
  });
  const call = Effect.fn("KinWorkerNetwork.rpc.call")(
    function* <A, E>(
      run: (
        people: Effect.Success<ReturnType<KinIdentity["Service"]["resolve"]>>,
      ) => Effect.Effect<A, E, Network.Requirements>,
    ) {
      if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
      if (Option.isNone(host)) return yield* unavailable;
      const services = kin.value.services.value;
      const people = yield* Context.get(services, KinIdentity).resolve(session);
      return yield* run(people).pipe(
        Effect.provideContext(services),
        Effect.provideService(ServerConfig, host.value.config),
        Effect.provideService(FileSystem.FileSystem, host.value.fs),
      );
    },
    Effect.catchDefect((cause) =>
      Effect.logWarning("Kin RPC defect.", cause).pipe(Effect.andThen(Effect.fail(unavailable))),
    ),
  );
  return group.of({
    "kin.workers.network.get": (input) => call((people) => Network.get(people, input)),
    "kin.workers.network.allow": (input) => call((people) => Network.allow(people, input)),
    "kin.workers.network.remove": (input) => call((people) => Network.remove(people, input)),
  });
});

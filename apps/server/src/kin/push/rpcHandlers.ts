import { KinPushError, KinPushRpcs } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { KinPushDevices } from "./KinPushDevices.ts";
import { KinPushSender } from "./KinPushSender.ts";

const group = RpcGroup.make(...KinPushRpcs);
const unavailable = Effect.fail(
  new KinPushError({ reason: "unavailable", message: "Kin notifications are unavailable." }),
);

export const makeKinPushHandlers = Effect.fn("makeKinPushHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const caller = Effect.gen(function* () {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
    const services = kin.value.services.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    return {
      devices: Context.get(services, KinPushDevices),
      sending: Context.get(services, KinPushSender).status,
      caller: { session, people },
    };
  });
  return group.of({
    "kin.push.registerDevice": (input) =>
      caller.pipe(
        Effect.flatMap(({ devices, sending, caller }) =>
          devices
            .register(caller, input)
            .pipe(Effect.map(({ deviceId }) => ({ deviceId, sending }))),
        ),
      ),
    "kin.push.unregisterDevice": (input) =>
      caller.pipe(Effect.flatMap(({ devices, caller }) => devices.unregister(caller, input))),
  });
});

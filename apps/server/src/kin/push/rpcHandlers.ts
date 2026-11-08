import { KinPushError, KinPushRpcs } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { KinPushDevices } from "./KinPushDevices.ts";
import { KinPushPresence } from "./KinPushPresence.ts";
import { KinPushSender } from "./KinPushSender.ts";

const group = RpcGroup.make(...KinPushRpcs);
const disabled = Effect.fail(
  new KinPushError({ reason: "disabled", message: "Kin is not running on this host." }),
);

export const makeKinPushHandlers = Effect.fn("makeKinPushHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const caller = Effect.gen(function* () {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    const services = kin.value.services.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    return {
      devices: Context.get(services, KinPushDevices),
      sending: Context.get(services, KinPushSender).status,
      presence: Context.get(services, KinPushPresence),
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
    // Only ever quiets this session's own pushes, so it needs no access check on the chat.
    "kin.push.watch": (input) =>
      Stream.unwrap(
        caller.pipe(Effect.map(({ presence }) => presence.watch(session.sessionId, input.chatId))),
      ),
  });
});

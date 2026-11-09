import { KinChatError, KinMemoryRpcs } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { KinMemoryChanges } from "./MemoryChanges.ts";

const group = RpcGroup.make(...KinMemoryRpcs);
const disabled = new KinChatError({
  reason: "disabled",
  message: "Kin is not running on this host.",
});
const defect = (cause: unknown) =>
  Effect.logWarning("Kin RPC defect.", cause).pipe(
    Effect.andThen(
      Effect.fail(new KinChatError({ reason: "unavailable", message: "Kin is unavailable." })),
    ),
  );

/** Thin transport: resolve the session's people, then one owner-checked `KinMemoryChanges` call. */
export const makeKinMemoryHandlers = Effect.fn("makeKinMemoryHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  return group.of({
    "kin.memory.undo": Effect.fn("KinMemory.rpc.undo")(function* (input) {
      if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
      const services = kin.value.services.value;
      const people = yield* Context.get(services, KinIdentity).resolve(session);
      return yield* Context.get(services, KinMemoryChanges).undo(people, input);
    }, Effect.catchDefect(defect)),
  });
});

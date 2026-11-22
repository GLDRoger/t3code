import { KinChatError, KinShellRpcs } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { KinShell } from "./KinShell.ts";

const group = RpcGroup.make(...KinShellRpcs);
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
const missing = new KinChatError({ reason: "not_found", message: "Kin couldn't find that." });

export const makeKinShellHandlers = Effect.fn("makeKinShellHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  return group.of({
    "kin.shell.set": Effect.fnUntraced(function* (input) {
      const services = Option.flatMap(kin, (entry) => entry.services);
      if (Option.isNone(services)) return yield* unavailable;
      const identity = Context.get(services.value, KinIdentity);
      const caller = (yield* identity.resolve(session)).find(
        (person) => person.orgId === input.orgId,
      );
      if (caller === undefined) return yield* missing;
      return yield* Context.get(services.value, KinShell).set(
        input.orgId,
        caller.personId,
        input.rev,
        input.shell.sections,
      );
    }),
  });
});

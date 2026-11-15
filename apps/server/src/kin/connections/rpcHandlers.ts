import { KinChatError, KinConnectionRpcs } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { KinConnections } from "./ConnectionsService.ts";

const group = RpcGroup.make(...KinConnectionRpcs);
const disabled = new KinChatError({
  reason: "disabled",
  message: "Kin is not running on this host.",
});

/** Thin transport: the session's people, then one owner-checked connections call. */
export const makeKinConnectionHandlers = Effect.fn("makeKinConnectionHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const call = Effect.fn("KinConnections.rpc")(function* <A>(
    run: (
      connections: KinConnections["Service"],
      people: ReadonlyArray<PersonIdentity>,
    ) => Effect.Effect<A, KinChatError>,
  ) {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    const services = kin.value.services.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    return yield* run(Context.get(services, KinConnections), people);
  });
  return group.of({
    "kin.connections.list": (input) => call((c, people) => c.list(people, input)),
    "kin.connections.get": (input) => call((c, people) => c.get(people, input)),
    "kin.connections.add": (input) => call((c, people) => c.add(people, input)),
    "kin.connections.setKey": (input) => call((c, people) => c.setKey(people, input)),
    "kin.connections.refreshTools": (input) => call((c, people) => c.refreshTools(people, input)),
    "kin.connections.setToolModes": (input) => call((c, people) => c.setToolModes(people, input)),
    "kin.connections.acceptToolChanges": (input) =>
      call((c, people) => c.acceptToolChanges(people, input)),
    "kin.connections.update": (input) => call((c, people) => c.update(people, input)),
    "kin.connections.setReach": (input) => call((c, people) => c.setReach(people, input)),
    "kin.connections.remove": (input) => call((c, people) => c.remove(people, input)),
    "kin.connections.calls": (input) => call((c, people) => c.calls(people, input)),
  });
});

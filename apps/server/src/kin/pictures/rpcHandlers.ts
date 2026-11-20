import { KinChatError, KinPicturesRpcs } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { KinPictures } from "./KinPictures.ts";

const group = RpcGroup.make(...KinPicturesRpcs);
const disabled = new KinChatError({
  reason: "disabled",
  message: "Kin is not running on this host.",
});

/** Thin transport: the session's people, then one owner-checked picture settings call. */
export const makeKinPicturesHandlers = Effect.fn("makeKinPicturesHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const call = Effect.fn("KinPictures.rpc")(function* <A>(
    run: (
      pictures: KinPictures["Service"],
      people: ReadonlyArray<PersonIdentity>,
    ) => Effect.Effect<A, KinChatError>,
  ) {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    const services = kin.value.services.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    return yield* run(Context.get(services, KinPictures), people);
  });
  return group.of({
    "kin.pictures.get": (input) => call((p, people) => p.get(people, input)),
    "kin.pictures.set": (input) => call((p, people) => p.set(people, input)),
  });
});

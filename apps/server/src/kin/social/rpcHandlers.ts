import { KinChatError, KinSocialRpcs } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { KinSocial } from "./SocialService.ts";

const group = RpcGroup.make(...KinSocialRpcs);
const disabled = new KinChatError({
  reason: "disabled",
  message: "Kin is not running on this host.",
});

/** Thin transport: the session's people, then one owner-checked social call. */
export const makeKinSocialHandlers = Effect.fn("makeKinSocialHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const call = Effect.fn("KinSocial.rpc")(function* <A>(
    run: (
      social: KinSocial["Service"],
      people: ReadonlyArray<PersonIdentity>,
    ) => Effect.Effect<A, KinChatError>,
  ) {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    const services = kin.value.services.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    return yield* run(Context.get(services, KinSocial), people);
  });
  return group.of({
    "kin.social.list": (input) => call((s, people) => s.list(people, input)),
    "kin.social.check": (input) => call((s, people) => s.check(people, input)),
    "kin.social.connect": (input) => call((s, people) => s.connect(people, input)),
    "kin.social.refresh": (input) => call((s, people) => s.refresh(people, input)),
    "kin.social.remove": (input) => call((s, people) => s.remove(people, input)),
    "kin.social.link": (input) => call((s, people) => s.link(people, input)),
  });
});

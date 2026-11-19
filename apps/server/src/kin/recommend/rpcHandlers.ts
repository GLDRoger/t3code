import { KinChatError, KinRecommendationRpcs, type KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinServer, type Services } from "../KinServer.ts";
import * as KinRecommend from "./KinRecommend.ts";

const group = RpcGroup.make(...KinRecommendationRpcs);
const isKinError = Schema.is(KinChatError);
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
const notFound = new KinChatError({ reason: "not_found", message: "No such org here." });

/** Thin transport: the session's person in that org, then one `KinRecommend` call. */
export const makeKinRecommendHandlers = Effect.fn("makeKinRecommendHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const run = Effect.fn("KinRecommend.rpc")(
    function* <A, E>(
      orgId: KinOrgId,
      method: (person: PersonIdentity) => Effect.Effect<A, E, Services>,
    ) {
      const services = Option.flatMap(kin, (k) => k.services);
      if (Option.isNone(services)) return yield* unavailable;
      const people = yield* Context.get(services.value, KinIdentity).resolve(session);
      const person = people.find((one) => one.orgId === orgId);
      if (person === undefined) return yield* notFound;
      return yield* method(person).pipe(Effect.provideContext(services.value));
    },
    Effect.mapError((error) => (isKinError(error) ? error : unavailable)),
  );
  return group.of({
    "kin.recommendations.list": (input) =>
      run(input.orgId, (person) => KinRecommend.list(input.orgId, person.personId)),
    "kin.recommendations.undo": (input) =>
      run(input.orgId, (person) => KinRecommend.undo(input.orgId, person.personId, input.recId)),
    "kin.recommendations.askAgain": (input) =>
      run(input.orgId, (person) =>
        KinRecommend.askAgain(input.orgId, person.personId, input.recId),
      ),
  });
});

import { KinChatError, KinLevelRpcs } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { KinPromotion } from "./Promotion.ts";

const group = RpcGroup.make(...KinLevelRpcs);
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

/** Thin transport: resolve the session's people, then one `KinPromotion` call (owner-checked). */
export const makeKinLevelHandlers = Effect.fn("makeKinLevelHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const call = Effect.fn("KinLevels.rpc")(function* <A>(
    method: (
      promotion: KinPromotion["Service"],
      people: ReadonlyArray<PersonIdentity>,
    ) => Effect.Effect<A, KinChatError>,
  ) {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    const services = kin.value.services.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    return yield* method(Context.get(services, KinPromotion), people);
  }, Effect.catchDefect(defect));
  return group.of({
    "kin.levels.get": (input) => call((promotion, people) => promotion.view(people, input)),
    "kin.levels.review": (input) => call((promotion, people) => promotion.review(people, input)),
    "kin.levels.lower": (input) => call((promotion, people) => promotion.lower(people, input)),
    "kin.levels.raise": (input) => call((promotion, people) => promotion.raise(people, input)),
    "kin.levels.deferPromotion": (input) =>
      call((promotion, people) => promotion.deferPromotion(people, input)),
    "kin.levels.shadowMemory": (input) =>
      call((promotion, people) => promotion.shadowMemory(people, input)),
  });
});

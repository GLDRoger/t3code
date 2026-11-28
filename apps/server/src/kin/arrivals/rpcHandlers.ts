import { KinChatError, KinMailRuleRpcs } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { KinMailRules } from "./KinMailRules.ts";

const group = RpcGroup.make(...KinMailRuleRpcs);
const disabled = new KinChatError({
  reason: "disabled",
  message: "Kin is not running on this host.",
});

export const makeKinMailRuleHandlers = Effect.fn("makeKinMailRuleHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const services = Option.flatMap(kin, (host) => host.services);
  const call = Effect.fn("KinMailRules.rpc")(function* <A>(
    run: (
      rules: KinMailRules["Service"],
      people: ReadonlyArray<PersonIdentity>,
    ) => Effect.Effect<A, KinChatError>,
  ) {
    if (Option.isNone(services)) return yield* disabled;
    const people = yield* Context.get(services.value, KinIdentity).resolve(session);
    return yield* run(Context.get(services.value, KinMailRules), people);
  });
  return group.of({
    "kin.mailRules.create": (input) => call((rules, people) => rules.createFromTap(people, input)),
    "kin.mailRules.pause": (input) => call((rules, people) => rules.pause(people, input)),
    "kin.mailRules.setLimit": (input) => call((rules, people) => rules.setLimit(people, input)),
    "kin.mailRules.resume": (input) => call((rules, people) => rules.resume(people, input)),
    "kin.mailRules.remove": (input) => call((rules, people) => rules.remove(people, input)),
    "kin.mailRules.list": (input) => call((rules, people) => rules.list(people, input)),
    "kin.mailRules.history": (input) => call((rules, people) => rules.history(people, input)),
    "kin.mailRules.preview": (input) => call((rules, people) => rules.preview(people, input)),
    "kin.mailRules.runNow": (input) => call((rules, people) => rules.runNow(people, input)),
  });
});

import { KinBankSenderRpcs, KinChatError, type KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import type { AuthenticatedSession } from "../../../auth/EnvironmentAuth.ts";
import { KinIdentity, type PersonIdentity } from "../../chat/KinIdentity.ts";
import { KinServer, type Services } from "../../KinServer.ts";
import * as BankSenders from "./bankSenders.ts";

const group = RpcGroup.make(...KinBankSenderRpcs);
const isKinError = Schema.is(KinChatError);
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
const notFound = new KinChatError({ reason: "not_found", message: "No such org here." });

export const makeKinBankSenderHandlers = Effect.fn("makeKinBankSenderHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const run = Effect.fn("KinBankSenders.rpc")(
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
    "kin.bankSenders.list": ({ orgId }) =>
      run(orgId, (person) => BankSenders.list(orgId, person.personId)),
    "kin.bankSenders.add": ({ orgId, ...input }) =>
      run(orgId, (person) => BankSenders.add(orgId, person.personId, input)),
    "kin.bankSenders.remove": ({ orgId, address }) =>
      run(orgId, (person) => BankSenders.remove(orgId, person.personId, address)),
  });
});

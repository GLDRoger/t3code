import { KinChatError, KinNumbersRpcs, type KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinServer } from "../KinServer.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinNumbers } from "./KinNumbers.ts";
import * as Definitions from "./numberDefinitions.ts";

const group = RpcGroup.make(...KinNumbersRpcs);

export const makeKinNumbersHandlers = Effect.fn("makeKinNumbersHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const resolve = Effect.fn("KinNumbers.rpc.resolve")(function* (orgId: KinOrgId) {
    const services = Option.flatMap(kin, (entry) => entry.services);
    if (Option.isNone(services))
      return yield* new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
    const identity = Context.get(services.value, KinIdentity);
    const caller = (yield* identity.resolve(session)).find((person) => person.orgId === orgId);
    if (caller === undefined)
      return yield* new KinChatError({ reason: "not_found", message: "Kin couldn't find that." });
    return { caller, numbers: Context.get(services.value, KinNumbers) };
  });
  const owned = Effect.fn("KinNumbers.rpc.owned")(function* <A, E, R>(
    run: (people: ReadonlyArray<PersonIdentity>) => Effect.Effect<A, E, R>,
  ) {
    const services = Option.flatMap(kin, (entry) => entry.services);
    if (Option.isNone(services))
      return yield* new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
    const people = yield* Context.get(services.value, KinIdentity).resolve(session);
    return yield* run(people).pipe(Effect.provideContext(services.value));
  });
  return group.of({
    "kin.numbers.list": Effect.fn("KinNumbers.rpc.list")(function* ({ orgId }) {
      const { caller, numbers } = yield* resolve(orgId);
      return yield* numbers.list(caller);
    }),
    "kin.numbers.values": Effect.fn("KinNumbers.rpc.values")(function* ({
      orgId,
      number,
      from,
      to,
    }) {
      const { caller, numbers } = yield* resolve(orgId);
      return yield* numbers.values(caller, number, from, to);
    }),
    "kin.numbers.record": Effect.fn("KinNumbers.rpc.record")(function* ({
      orgId,
      clientRequestId,
      ...value
    }) {
      const { caller, numbers } = yield* resolve(orgId);
      return yield* numbers.record(caller, [value], clientRequestId);
    }),
    "kin.numbers.definitions": Effect.fn("KinNumbers.rpc.definitions")(function* ({ orgId }) {
      return yield* owned((people) => Definitions.definitions(people, orgId));
    }),
    "kin.numbers.save": Effect.fn("KinNumbers.rpc.save")(function* (input) {
      return yield* owned((people) => Definitions.save(people, input));
    }),
  });
});

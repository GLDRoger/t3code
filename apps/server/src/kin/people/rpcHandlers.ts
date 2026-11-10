import * as Schema from "effect/Schema";
import { KinChatError, KinPeopleRpcs } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinServer } from "../KinServer.ts";
import * as People from "./KinPeople.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { KinPeople } from "./KinPeople.ts";

const group = RpcGroup.make(...KinPeopleRpcs);
const isKinError = Schema.is(KinChatError);
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
export const makeKinPeopleHandlers = Effect.fn("makeKinPeopleHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const sessions = yield* Effect.serviceOption(SessionStore);
  const people = Effect.gen(function* () {
    const services = Option.flatMap(kin, (k) => k.services);
    if (Option.isNone(services)) return yield* unavailable;
    if (Option.isNone(sessions)) return yield* unavailable;
    return yield* People.make.pipe(
      Effect.provideContext(services.value),
      Effect.provideService(SessionStore, sessions.value),
      Effect.mapError(() => unavailable),
    );
  });
  const run = <A>(body: (service: KinPeople["Service"]) => Effect.Effect<A, unknown>) =>
    people.pipe(
      Effect.flatMap(body),
      Effect.mapError((e) => (isKinError(e) ? e : unavailable)),
    );
  return group.of({
    "kin.people.list": (input) => run((p) => p.list(session, input.orgId)),
    "kin.people.createInvite": (input) => run((p) => p.createInvite(session, input)),
    "kin.people.listDevices": (input) => run((p) => p.listDevices(session, input)),
    "kin.people.revokeDevice": (input) => run((p) => p.revokeDevice(session, input)),
    "kin.people.setGithubLogin": (input) => run((p) => p.setGithubLogin(session, input)),
  });
});

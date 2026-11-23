import * as Schema from "effect/Schema";
import { KinChatError, KinPeopleRpcs, type KinAgentId, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinServer } from "../KinServer.ts";
import * as People from "./KinPeople.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { CloudLink } from "../../cloud/CloudLink.ts";
import { KinPeople } from "./KinPeople.ts";
import * as LeadProvision from "../lead/KinLeadProvision.ts";
import { toLeadError } from "../chat/rpcHandlers.ts";

const group = RpcGroup.make(...KinPeopleRpcs);
const isKinError = Schema.is(KinChatError);
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
export const makeKinPeopleHandlers = Effect.fn("makeKinPeopleHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const sessions = yield* Effect.serviceOption(SessionStore);
  const cloud = yield* Effect.serviceOption(CloudLink);
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
  // `kin.access.me` names the tunnel's address from it.
  const withCloud = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Option.isSome(cloud) ? Effect.provideService(effect, CloudLink, cloud.value) : effect;
  const run = <A>(body: (service: KinPeople["Service"]) => Effect.Effect<A, unknown>) =>
    people.pipe(
      Effect.flatMap(body),
      Effect.mapError((e) => (isKinError(e) ? e : unavailable)),
    );
  const setTeamAgent = Effect.fn("kin.org.setTeamAgent")(
    function* (input: { readonly orgId: KinOrgId; readonly agentId: KinAgentId | null }) {
      const services = Option.flatMap(kin, (k) => k.services);
      if (Option.isNone(services)) return yield* unavailable;
      return yield* LeadProvision.setTeamAgent({
        editor: { _tag: "session", session },
        ...input,
      }).pipe(Effect.provideContext(services.value));
    },
    Effect.mapError(toLeadError),
    Effect.tapError((e) => (isKinError(e) ? Effect.void : Effect.logWarning("Kin RPC failed.", e))),
    Effect.mapError((e) => (isKinError(e) ? e : unavailable)),
  );
  return group.of({
    "kin.people.listInvites": (input) => run((p) => p.listInvites(session, input.orgId)),
    "kin.people.revokeInvite": (input) => run((p) => p.revokeInvite(session, input)),
    "kin.people.list": (input) => run((p) => p.list(session, input.orgId)),
    "kin.people.createInvite": (input) => run((p) => p.createInvite(session, input)),
    "kin.people.listDevices": (input) => run((p) => p.listDevices(session, input)),
    "kin.people.revokeDevice": (input) => run((p) => p.revokeDevice(session, input)),
    "kin.people.linkDevice": (input) => run((p) => p.linkDevice(session, input)),
    "kin.people.removeAccess": (input) => run((p) => p.removeAccess(session, input)),
    "kin.people.setGithubLogin": (input) => run((p) => p.setGithubLogin(session, input)),
    "kin.people.setAccess": (input) => run((p) => p.setAccess(session, input)),
    "kin.people.setPlaces": (input) => run((p) => p.setPlaces(session, input)),
    "kin.access.me": (input) => run((p) => withCloud(p.accessMe(session, input))),
    "kin.people.setOwnerName": (input) => run((p) => p.setOwnerName(session, input)),
    "kin.people.profiles": (input) => run((p) => p.profiles(session, input.orgId)),
    "kin.people.updateProfile": (input) => run((p) => p.updateProfile(session, input)),
    "kin.org.setTeamAgent": setTeamAgent,
  });
});

import { makeKinPeopleHandlers } from "./people/rpcHandlers.ts";
import {
  AuthKinChatScope,
  EnvironmentAuthorizationError,
  KinRpcs,
  authScopeRequiredResponse,
  kinRpcAccess,
  type KinRpcAccess,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { makeKinApprovalHandlers } from "./approvals/rpcHandlers.ts";
import { KinIdentity } from "./chat/KinIdentity.ts";
import { makeKinChatHandlers } from "./chat/rpcHandlers.ts";
import { makeKinConnectionHandlers } from "./connections/rpcHandlers.ts";
import { makeKinSocialHandlers } from "./social/rpcHandlers.ts";
import { makeKinLevelHandlers } from "./levels/rpcHandlers.ts";
import { makeKinMemoryHandlers } from "./memory/rpcHandlers.ts";
import { KinServer, type Services } from "./KinServer.ts";
import { accessOf } from "./people/KinAccess.ts";
import { makeKinPushHandlers } from "./push/rpcHandlers.ts";
import { makeKinRecommendHandlers } from "./recommend/rpcHandlers.ts";
import { makeKinWorkHandlers } from "./work/rpcHandlers.ts";
import { makeKinTasksKeyHandlers } from "./tasksKey/rpcHandlers.ts";

const group = RpcGroup.make(...KinRpcs);
// Every Kin group's error union holds this, and a member's client already reads it as a refusal.
const refusal = (message: string) =>
  new EnvironmentAuthorizationError({ message, ...authScopeRequiredResponse(AuthKinChatScope) });
const refused = refusal("Only the owner or a co-owner can do that.");
const ownerOnly = refusal("Only the owner can do that.");
const unavailable = refusal("Kin is unavailable.");

/** `KIN_RPC_ACCESS` for this session's person, from their stored kind, before any handler runs. */
export const admits = Effect.fn("KinRpc.admits")(function* (
  session: AuthenticatedSession,
  services: Option.Option<Context.Context<Services>>,
  access: KinRpcAccess | undefined,
) {
  if (access === "person") return;
  if (Option.isNone(services)) return yield* unavailable;
  const kind = yield* Effect.gen(function* () {
    const identity = yield* KinIdentity;
    const person = (yield* identity.resolve(session)).find(
      (candidate) => candidate.orgId === identity.owner.orgId,
    );
    return person === undefined ? undefined : yield* accessOf(person.orgId, person.personId);
  }).pipe(
    Effect.provideContext(services.value),
    Effect.mapError(() => unavailable),
  );
  if (kind === "owner") return;
  if (kind === "co_owner" && access === "owner_level") return;
  return yield* access === "org_owner" && kind === "co_owner" ? ownerOnly : refused;
});

export const makeKinHandlers = Effect.fn("makeKinHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const services = Option.flatMap(kin, (kin) => kin.services);
  const handlers = group.of({
    ...(yield* makeKinPeopleHandlers(session)),
    ...(yield* makeKinTasksKeyHandlers(session)),
    ...(yield* makeKinChatHandlers(session)),
    ...(yield* makeKinApprovalHandlers(session, services)),
    ...(yield* makeKinLevelHandlers(session)),
    ...(yield* makeKinMemoryHandlers(session)),
    ...(yield* makeKinWorkHandlers(session)),
    ...(yield* makeKinPushHandlers(session)),
    ...(yield* makeKinConnectionHandlers(session)),
    ...(yield* makeKinSocialHandlers(session)),
    ...(yield* makeKinRecommendHandlers(session)),
  });
  const guarded: Record<string, unknown> = {};
  for (const [tag, handler] of Object.entries(handlers)) {
    const check = admits(session, services, kinRpcAccess(tag));
    guarded[tag] = (...args: ReadonlyArray<unknown>) => {
      const result: unknown = Reflect.apply(handler, undefined, args);
      return Stream.isStream(result)
        ? Stream.unwrap(Effect.as(check, result))
        : Effect.andThen(check, result as Effect.Effect<unknown, EnvironmentAuthorizationError>);
    };
  }
  // Every entry keeps its handler's signature; only a refusal is added, typed as the group's error.
  return guarded as typeof handlers;
});

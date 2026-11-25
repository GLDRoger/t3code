import { makeKinPeopleHandlers } from "./people/rpcHandlers.ts";
import {
  AuthKinChatScope,
  EnvironmentAuthorizationError,
  KinChatError,
  KinRpcs,
  kinOwnerLevel,
  authScopeRequiredResponse,
  kinAccessAllows,
  kinRpcAccess,
  type KinRpcAccess,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSchema from "effect/rpc/RpcSchema";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { makeKinApprovalHandlers } from "./approvals/rpcHandlers.ts";
import { KinIdentity } from "./chat/KinIdentity.ts";
import { makeKinChatHandlers } from "./chat/rpcHandlers.ts";
import { makeKinConnectionHandlers } from "./connections/rpcHandlers.ts";
import { makeKinSocialHandlers } from "./social/rpcHandlers.ts";
import { makeKinPicturesHandlers } from "./pictures/rpcHandlers.ts";
import { makeKinLevelHandlers } from "./levels/rpcHandlers.ts";
import { makeKinMemoryHandlers } from "./memory/rpcHandlers.ts";
import { KinServer, type Services } from "./KinServer.ts";
import { accessOf } from "./people/KinAccess.ts";
import { makeKinPushHandlers } from "./push/rpcHandlers.ts";
import { KIN_READ_RPCS, readOnlyStream } from "./readRpcs.ts";
import { makeKinRecommendHandlers } from "./recommend/rpcHandlers.ts";
import { makeKinHostHandlers } from "./host/rpcHandlers.ts";
import { makeKinWorkHandlers } from "./work/rpcHandlers.ts";
import { makeKinTasksKeyHandlers } from "./tasksKey/rpcHandlers.ts";
import { makeKinNumbersHandlers } from "./numbers/rpcHandlers.ts";
import { makeKinShellHandlers } from "./shell/rpcHandlers.ts";
import { makeKinWatchHandlers } from "./watches/rpcHandlers.ts";
import { countryFirstForPerson, isCountryFirst } from "./work/companyProfile.ts";

const group = RpcGroup.make(...KinRpcs);
const isKinChatError = Schema.is(KinChatError);
// Every Kin group's error union holds this, and a member's client already reads it as a refusal.
const refusal = (message: string) =>
  new EnvironmentAuthorizationError({ message, ...authScopeRequiredResponse(AuthKinChatScope) });
const refused = refusal("Only the owner or a co-owner can do that.");
const ownerOnly = refusal("Only the owner can do that.");
const unavailable = refusal("Kin is unavailable.");
// Says nothing of the payload's shape: who may not make the call never gets this far.
const unreadable = refusal("Kin couldn't read that request.");

/**
 * The socket's group with Kin's payloads passed through undecoded: the RPC server would turn a
 * bad one into a defect before any check runs, so `makeKinHandlers` decodes it after access.
 */
export const decodeKinAfterAccess = <R extends Rpc.Any>(
  wire: RpcGroup.RpcGroup<R>,
): RpcGroup.RpcGroup<R> =>
  wire.add(
    ...Array.from(wire.requests.values() as Iterable<Rpc.Rpc<string, Schema.Top>>)
      .filter((rpc) => group.requests.has(rpc._tag))
      .map((rpc) => rpc.setPayload(Schema.Unknown)),
  ) as unknown as RpcGroup.RpcGroup<R>;

/** Decodes what the socket passed through raw; a caller in this process hands it decoded. */
const payloadDecoder = (rpc: Rpc.AnyWithProps) => {
  // Kin's payload schemas need no services to decode.
  const decode = Schema.decodeUnknownEffect(
    Schema.toCodecJson(rpc.payloadSchema as Schema.Codec<unknown, unknown>),
    Context.get(rpc.annotations, Rpc.ParseOptions),
  );
  return (payload: unknown, options: unknown) =>
    (options as { readonly rpc?: Rpc.AnyWithProps } | undefined)?.rpc?.payloadSchema ===
    Schema.Unknown
      ? Effect.mapError(decode(payload), () => unreadable)
      : Effect.succeed(payload);
};

const kindOf = Effect.fn("KinRpc.kindOf")(function* (
  session: AuthenticatedSession,
  services: Context.Context<Services>,
) {
  return yield* Effect.gen(function* () {
    const identity = yield* KinIdentity;
    const person = (yield* identity.resolve(session)).find(
      (candidate) => candidate.orgId === identity.owner.orgId,
    );
    return person === undefined ? undefined : yield* accessOf(person.orgId, person.personId);
  }).pipe(Effect.provideContext(services));
});

/** `KIN_RPC_ACCESS` for this session's person, from their stored kind, before any handler runs. */
export const admits = Effect.fn("KinRpc.admits")(function* (
  session: AuthenticatedSession,
  services: Option.Option<Context.Context<Services>>,
  access: KinRpcAccess | undefined,
) {
  if (access === "person") return;
  if (Option.isNone(services)) return yield* unavailable;
  const kind = yield* kindOf(session, services.value).pipe(Effect.mapError(() => unavailable));
  if (kinAccessAllows(kind, access ?? "org_owner")) return;
  return yield* access === "org_owner" && kind === "co_owner" ? ownerOnly : refused;
});

/** A person reads the country refusal without the owner's name, which an agent is given. */
export const forPerson =
  (session: AuthenticatedSession, services: Option.Option<Context.Context<Services>>) =>
  (error: EnvironmentAuthorizationError | KinChatError) =>
    isKinChatError(error) && isCountryFirst(error) && Option.isSome(services)
      ? kindOf(session, services.value).pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap((kind) =>
            Effect.fail(
              new KinChatError({
                reason: "invalid_state",
                message: countryFirstForPerson(kinOwnerLevel(kind)),
              }),
            ),
          ),
        )
      : Effect.fail(error);

export const makeKinHandlers = Effect.fn("makeKinHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const services = Option.flatMap(kin, (kin) => kin.services);
  const handlers = group.of({
    ...(yield* makeKinPeopleHandlers(session)),
    ...(yield* makeKinShellHandlers(session)),
    ...(yield* makeKinNumbersHandlers(session)),
    ...(yield* makeKinTasksKeyHandlers(session)),
    ...(yield* makeKinChatHandlers(session)),
    ...(yield* makeKinApprovalHandlers(session, services)),
    ...(yield* makeKinLevelHandlers(session)),
    ...(yield* makeKinMemoryHandlers(session)),
    ...(yield* makeKinWorkHandlers(session)),
    ...(yield* makeKinPushHandlers(session)),
    ...(yield* makeKinConnectionHandlers(session)),
    ...(yield* makeKinSocialHandlers(session)),
    ...(yield* makeKinPicturesHandlers(session)),
    ...(yield* makeKinRecommendHandlers(session)),
    ...(yield* makeKinHostHandlers(session)),
    ...(yield* makeKinWatchHandlers(session)),
  });
  const personSees = forPerson(session, services);
  const guarded: Record<string, unknown> = {};
  for (const [tag, handler] of Object.entries(handlers)) {
    const rpc = group.requests.get(tag) as Rpc.AnyWithProps;
    const check = admits(session, services, kinRpcAccess(tag));
    const reads = KIN_READ_RPCS.has(tag);
    const decode = payloadDecoder(rpc);
    const handle = (payload: unknown, options: unknown): unknown =>
      Reflect.apply(handler, undefined, [payload, options]);
    guarded[tag] = RpcSchema.isStreamSchema(rpc.successSchema)
      ? (payload: unknown, options: unknown) => {
          const stream = Stream.unwrap(
            Effect.andThen(check, decode(payload, options)).pipe(
              Effect.map((decoded) => handle(decoded, options) as Stream.Stream<unknown>),
            ),
          );
          return reads ? readOnlyStream(stream) : stream;
        }
      : (payload: unknown, options: unknown) => {
          const effect = Effect.andThen(check, decode(payload, options)).pipe(
            Effect.flatMap((decoded) =>
              Effect.catch(
                handle(decoded, options) as Effect.Effect<
                  unknown,
                  EnvironmentAuthorizationError | KinChatError
                >,
                personSees,
              ),
            ),
          );
          return reads ? NodeSqliteClient.readOnly(effect) : effect;
        };
  }
  // Every entry keeps its handler's signature; only a refusal is added, typed as the group's error.
  return guarded as typeof handlers;
});

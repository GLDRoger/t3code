import { KinChatError, KinWorkRpcs } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import * as Clients from "./ownerClients.ts";
import * as Work from "./ownerWork.ts";

const group = RpcGroup.make(...KinWorkRpcs);
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

/** Thin transport: resolve the session's people, then one owner-checked Work call. */
export const makeKinWorkHandlers = Effect.fn("makeKinWorkHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const call = Effect.fn("KinWork.rpc.call")(function* <A, E, R>(
    run: (
      people: Effect.Success<ReturnType<KinIdentity["Service"]["resolve"]>>,
    ) => Effect.Effect<A, E, R>,
  ) {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    const services = kin.value.services.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    return yield* run(people).pipe(Effect.provideContext(services as Context.Context<R>));
  }, Effect.catchDefect(defect));
  return group.of({
    "kin.work.summary": Effect.fn("KinWork.rpc.summary")(function* (input) {
      return yield* call((people) => Work.summary(people, input));
    }),
    "kin.work.list": Effect.fn("KinWork.rpc.list")(function* (input) {
      return yield* call((people) => Work.list(people, input));
    }),
    "kin.work.get": Effect.fn("KinWork.rpc.get")(function* (input) {
      return yield* call((people) => Work.get(people, input));
    }),
    "kin.work.subscribe": (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
          const services = kin.value.services.value;
          const people = yield* Context.get(services, KinIdentity).resolve(session);
          return Work.subscribe(people, input).pipe(Stream.provideContext(services));
        }),
      ),
    "kin.work.create": Effect.fn("KinWork.rpc.create")(function* (input) {
      return yield* call((people) => Work.create(people, input));
    }),
    "kin.work.assign": Effect.fn("KinWork.rpc.assign")(function* (input) {
      return yield* call((people) => Work.assign(people, input));
    }),
    "kin.work.update": Effect.fn("KinWork.rpc.update")(function* (input) {
      return yield* call((people) => Work.update(people, input));
    }),
    "kin.work.confirm": Effect.fn("KinWork.rpc.confirm")(function* (input) {
      return yield* call((people) => Work.confirm(people, input));
    }),
    "kin.work.decline": Effect.fn("KinWork.rpc.decline")(function* (input) {
      return yield* call((people) => Work.decline(people, input));
    }),
    "kin.work.parties": Effect.fn("KinWork.rpc.parties")(function* (input) {
      return yield* call((people) => Clients.parties(people, input));
    }),
    "kin.work.party": Effect.fn("KinWork.rpc.party")(function* (input) {
      return yield* call((people) => Clients.party(people, input));
    }),
    "kin.work.projects": Effect.fn("KinWork.rpc.projects")(function* (input) {
      return yield* call((people) => Clients.projects(people, input));
    }),
    "kin.work.project": Effect.fn("KinWork.rpc.project")(function* (input) {
      return yield* call((people) => Clients.project(people, input));
    }),
    "kin.work.history": Effect.fn("KinWork.rpc.history")(function* (input) {
      return yield* call((people) => Clients.history(people, input));
    }),
    "kin.work.createParty": Effect.fn("KinWork.rpc.createParty")(function* (input) {
      return yield* call((people) => Clients.createParty(people, input));
    }),
    "kin.work.updateParty": Effect.fn("KinWork.rpc.updateParty")(function* (input) {
      return yield* call((people) => Clients.updateParty(people, input));
    }),
    "kin.work.createContact": Effect.fn("KinWork.rpc.createContact")(function* (input) {
      return yield* call((people) => Clients.createContact(people, input));
    }),
    "kin.work.updateContact": Effect.fn("KinWork.rpc.updateContact")(function* (input) {
      return yield* call((people) => Clients.updateContact(people, input));
    }),
    "kin.work.createProject": Effect.fn("KinWork.rpc.createProject")(function* (input) {
      return yield* call((people) => Clients.createProject(people, input));
    }),
    "kin.work.updateProject": Effect.fn("KinWork.rpc.updateProject")(function* (input) {
      return yield* call((people) => Clients.updateProject(people, input));
    }),
  });
});

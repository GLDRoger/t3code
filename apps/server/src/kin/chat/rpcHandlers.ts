import { KinChatAndBudgetRpcs, KinChatError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinServer } from "../KinServer.ts";
import { KinBudget } from "../lead/KinBudget.ts";
import { KinStop } from "../lead/KinStop.ts";
import { KinOwnerTimeZone } from "../triggers/ownerTimeZone.ts";
import { KinIdentity } from "./KinIdentity.ts";
import { KinChatService } from "./KinChatService.ts";

const group = RpcGroup.make(...KinChatAndBudgetRpcs);
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
const disabled = new KinChatError({
  reason: "disabled",
  message: "Kin is not running on this host.",
});
const isKinChatError = Schema.is(KinChatError);
const mapError = (error: unknown) => (isKinChatError(error) ? error : unavailable);
const logInfra = (error: unknown) =>
  isKinChatError(error) ? Effect.void : Effect.logWarning("Kin RPC failed.", error);
const defect = (cause: unknown) =>
  Effect.logWarning("Kin RPC defect.", cause).pipe(Effect.andThen(Effect.fail(unavailable)));

export const makeKinChatHandlers = Effect.fn("makeKinChatHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const services = Effect.gen(function* () {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    return {
      identity: Context.get(kin.value.services.value, KinIdentity),
      budget: Context.get(kin.value.services.value, KinBudget),
      stop: Context.get(kin.value.services.value, KinStop),
      timeZone: Context.get(kin.value.services.value, KinOwnerTimeZone),
      chat: Context.get(kin.value.services.value, KinChatService),
    };
  });
  const viewer = Effect.gen(function* () {
    const { identity, chat } = yield* services;
    return { chat, people: yield* identity.resolve(session) };
  });
  return group.of({
    "kin.budget.get": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, budget }) =>
          identity
            .resolve(session)
            .pipe(Effect.flatMap((people) => budget.view(people, input.orgId))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.budget.set": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, budget }) =>
          identity.resolve(session).pipe(Effect.flatMap((people) => budget.set(people, input))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.org.get": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, stop }) =>
          identity
            .resolve(session)
            .pipe(Effect.flatMap((people) => stop.view(people, input.orgId))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.org.pause": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, stop }) =>
          identity.resolve(session).pipe(Effect.flatMap((people) => stop.pause(people, input))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.org.resume": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, stop }) =>
          identity.resolve(session).pipe(Effect.flatMap((people) => stop.resume(people, input))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.triggers.getTimeZone": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, timeZone }) =>
          identity.resolve(session).pipe(Effect.flatMap((people) => timeZone.get(people, input))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.triggers.setTimeZone": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, timeZone }) =>
          identity.resolve(session).pipe(Effect.flatMap((people) => timeZone.set(people, input))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.orgs.list": () =>
      services.pipe(
        Effect.flatMap(({ identity, chat }) =>
          identity.resolve(session).pipe(Effect.flatMap(chat.orgs)),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.chats.subscribe": (input) =>
      Stream.unwrap(
        services.pipe(
          Effect.flatMap(({ identity, chat }) =>
            identity
              .resolve(session)
              .pipe(Effect.map((people) => chat.subscribeChats(people, input))),
          ),
        ),
      ).pipe(
        Stream.tapError(logInfra),
        Stream.mapError(mapError),
        Stream.catchDefect((cause) => Stream.fromEffect(defect(cause))),
      ),
    "kin.chat.subscribe": (input) =>
      Stream.unwrap(
        viewer.pipe(Effect.map(({ chat, people }) => chat.subscribe(people, input))),
      ).pipe(
        Stream.tapError(logInfra),
        Stream.mapError(mapError),
        Stream.catchDefect((cause) => Stream.fromEffect(defect(cause))),
      ),
    "kin.chats.createDirect": (input) =>
      viewer.pipe(
        Effect.flatMap(({ chat, people }) => chat.createDirect(people, input)),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.chat.history": (input) =>
      viewer.pipe(
        Effect.flatMap(({ chat, people }) => chat.history(people, input)),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.messages.send": (input) =>
      viewer.pipe(
        Effect.flatMap(({ chat, people }) => chat.send(people, input)),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.messages.markRead": (input) =>
      viewer.pipe(
        Effect.flatMap(({ chat, people }) => chat.markRead(people, input)),
        Effect.as({}),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.widgets.act": (input) =>
      viewer.pipe(
        Effect.flatMap(({ chat, people }) => chat.act(people, input)),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
  });
});

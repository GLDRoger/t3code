import { type KinChatId, KinPushError, KinPushRpcs } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { KinPushDevices } from "./KinPushDevices.ts";
import { KinPushPresence } from "./KinPushPresence.ts";
import { KinPushSender } from "./KinPushSender.ts";

const group = RpcGroup.make(...KinPushRpcs);
const disabled = Effect.fail(
  new KinPushError({ reason: "disabled", message: "Kin is not running on this host." }),
);

const unchecked = (cause: unknown) =>
  Effect.logWarning("KinPush.inChat failed", cause).pipe(
    Effect.andThen(
      Effect.fail(new KinPushError({ reason: "unavailable", message: "Couldn't check the chat." })),
    ),
  );

/** Presence slots are keyed by the chat id, so only a chat the caller is still in gets one. */
const inChat = Effect.fn("KinPush.inChat")(
  function* (
    chats: KinChatRepository["Service"],
    people: ReadonlyArray<PersonIdentity>,
    chatId: KinChatId,
  ) {
    for (const person of people) {
      const chat = yield* chats.getChat({ orgId: person.orgId, chatId });
      if (Option.isNone(chat) || chat.value.archivedAt !== null) continue;
      const member = yield* chats.activeMember({ orgId: person.orgId, chatId, principal: person });
      if (Option.isSome(member)) return;
    }
    return yield* new KinPushError({ reason: "not_member", message: "You aren't in this chat." });
  },
  Effect.catchTags({
    PersistenceSqlError: (cause) => unchecked(cause),
    PersistenceDecodeError: (cause) => unchecked(cause),
    KinChatError: (cause) => unchecked(cause),
  }),
);
export const makeKinPushHandlers = Effect.fn("makeKinPushHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const caller = Effect.gen(function* () {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    const services = kin.value.services.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    return {
      devices: Context.get(services, KinPushDevices),
      sending: Context.get(services, KinPushSender).status,
      presence: Context.get(services, KinPushPresence),
      chats: Context.get(services, KinChatRepository),
      caller: { session, people },
    };
  });
  return group.of({
    "kin.push.registerDevice": (input) =>
      caller.pipe(
        Effect.flatMap(({ devices, sending, caller }) =>
          devices
            .register(caller, input)
            .pipe(Effect.map(({ deviceId }) => ({ deviceId, sending }))),
        ),
      ),
    "kin.push.unregisterDevice": (input) =>
      caller.pipe(Effect.flatMap(({ devices, caller }) => devices.unregister(caller, input))),
    "kin.push.watch": (input) =>
      Stream.unwrap(
        caller.pipe(
          Effect.tap(({ chats, caller }) => inChat(chats, caller.people, input.chatId)),
          Effect.map(({ presence }) => presence.watch(session.sessionId, input.chatId)),
        ),
      ),
  });
});

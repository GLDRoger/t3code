import {
  KinChatError,
  type KinChatId,
  type KinMessage,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { KinChatHub } from "../chat/KinChatHub.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { wakeEvent } from "../lead/ChatWake.ts";
import { codingAgentSource, stampEvent } from "../lead/OutsideContent.ts";
import { requestHashOf } from "../work/KinRecords.ts";
import { workFailure } from "../work/recordRows.ts";
import { orgOwner, toolName, toolNamesOf } from "../work/toolNames.ts";
import { MATERIAL } from "../you/projection.ts";
import { whoNamed } from "./people.ts";
import { keyed } from "./tasks.ts";
import type { TasksKeyHolder } from "./TasksKeys.ts";

/** How long `ask_agent` waits for the agent's reply before saying it is still working. */
export const ASK_WAIT = Duration.seconds(45);
const PAGE = 20;

/**
 * A message a person's coding agent sent through its key: its request id starts `key:`, so no
 * check counts it as the person's own words in person (`KinAccess.ownerLevelAsked`).
 */
const KEY_MESSAGE_PREFIX = "key:";

const notAnAgent = new KinChatError({
  reason: "invalid_state",
  message:
    "ask_agent asks one of Kin's agents. To reach a person, comment on a task or give them one.",
});

const personOf = (holder: TasksKeyHolder): PersonIdentity => ({
  _tag: "person",
  orgId: holder.orgId,
  personId: holder.personId,
});

const keyLabel = Effect.fn("KinTasksKeyChat.keyLabel")(function* (holder: TasksKeyHolder) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ label: string }>`SELECT label FROM kin_tasks_keys
    WHERE org_id = ${holder.orgId} AND session_id = ${holder.sessionId}`.pipe(workFailure);
  const label = row?.label.trim() ?? "";
  return label === "" ? "Coding agent" : label;
});

/** One message as the outside agent reads it: who by name, when, and its words. */
const lineOf = (name: (who: KinWorkPrincipal) => string) => (message: KinMessage) => ({
  seq: message.seq,
  by:
    message.author._tag === "human"
      ? name({ _tag: "person", personId: message.author.personId })
      : message.author._tag === "agent"
        ? name({ _tag: "agent", agentId: message.author.agentId })
        : "Kin",
  at: message.createdAt,
  text: message.body,
});
const namesFor = Effect.fn("KinTasksKeyChat.names")(function* (holder: TasksKeyHolder) {
  const names = yield* orgOwner(holder.orgId).pipe(
    Effect.flatMap((owner) => toolNamesOf(holder.orgId, owner)),
    workFailure,
  );
  return (who: KinWorkPrincipal) =>
    toolName(who, names, { _tag: "person", personId: holder.personId });
});

/** The person's own direct chat with the agent `name` names, opened as their app opens it. */
const directChat = Effect.fn("KinTasksKeyChat.directChat")(function* (
  holder: TasksKeyHolder,
  name: string,
) {
  const who = yield* whoNamed(holder, name);
  if (who._tag !== "agent") return yield* notAnAgent;
  const chats = yield* KinChatService;
  const chat = yield* keyed(holder, () =>
    chats.createDirect(personOf(holder), { orgId: holder.orgId, agentId: who.agentId }),
  );
  return { chatId: chat.chatId, agentId: who.agentId };
});

/**
 * The person's words to one of Kin's agents, in their own direct chat with it, as they would
 * send them, with a first line saying their coding agent wrote them. The message and the stamp
 * that tells the turn so commit together, so the turn never starts without it. Then the agent's
 * reply, waited for as long as `ASK_WAIT`; a turn still going says so, with the chat to read later.
 */
export const askAgent = Effect.fn("KinTasksKeyChat.ask")(function* (
  holder: TasksKeyHolder,
  input: { readonly agent: string; readonly text: string },
) {
  const { chatId, agentId } = yield* directChat(holder, input.agent);
  const chats = yield* KinChatService;
  const hub = yield* KinChatHub;
  const label = yield* keyLabel(holder);
  const name = yield* namesFor(holder);
  const me = personOf(holder);
  const asked = { clientRequestId: "", agentId, text: input.text };
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const replies = yield* hub.subscribeForViewer(me, chatId);
      // The wait runs from the send, so its clock starts before the message goes.
      const waited = yield* Deferred.make<void>();
      yield* Effect.sleep(ASK_WAIT).pipe(
        Effect.andThen(Deferred.succeed(waited, undefined)),
        Effect.forkScoped,
      );
      const sent = yield* keyed(holder, () =>
        chats
          .send(me, {
            chatId,
            clientMessageId: `${KEY_MESSAGE_PREFIX}${holder.sessionId}:${requestHashOf(asked).slice(0, 40)}`,
            body: `*Sent by my coding agent, ${label}.*\n\n${input.text}`,
          })
          .pipe(
            Effect.tap((message) =>
              stampEvent(
                holder.orgId,
                wakeEvent(message, agentId, undefined).eventId,
                codingAgentSource(label),
              ),
            ),
          ),
      );
      const isReply = (message: KinMessage) =>
        message.author._tag === "agent" &&
        message.author.agentId === agentId &&
        message.seq > sent.seq &&
        message.kind === "text" &&
        message.body.trim() !== "";
      // The same request again may already have its answer.
      const earlier = (yield* keyed(holder, () =>
        chats.history(me, { chatId, beforeSeq: Number.MAX_SAFE_INTEGER, limit: PAGE }),
      )).messages.find(isReply);
      const reply =
        earlier !== undefined
          ? Option.some(earlier)
          : yield* Effect.raceFirst(
              replies.pipe(
                Stream.flatMap((event) =>
                  event.type === "message.posted" && isReply(event.message)
                    ? Stream.make(event.message)
                    : Stream.empty,
                ),
                Stream.runHead,
                Effect.mapError(
                  () => new KinChatError({ reason: "unavailable", message: "Kin is unavailable." }),
                ),
              ),
              Deferred.await(waited).pipe(Effect.as(Option.none<KinMessage>())),
            );
      return {
        chat: chatId,
        sent: sent.seq,
        replied: Option.isSome(reply),
        reply: Option.isSome(reply) ? lineOf(name)(reply.value) : null,
        note: Option.isSome(reply)
          ? null
          : "The agent is still working on it. Read its answer later with read_chat and this chat.",
        material: MATERIAL,
      };
    }),
  );
});

/**
 * The newest messages of a chat the person reads, newest last, text only: by `chat` id, or their
 * direct chat with an agent by name. A page at a time: `before` is the oldest `seq` shown.
 */
export const readChat = Effect.fn("KinTasksKeyChat.read")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly agent?: string | undefined;
    readonly chat?: KinChatId | undefined;
    readonly before?: number | undefined;
  },
) {
  const chatId =
    input.chat ??
    (input.agent === undefined
      ? yield* new KinChatError({
          reason: "invalid_state",
          message: "Name the chat: its id from ask_agent, or the agent's name.",
        })
      : (yield* directChat(holder, input.agent)).chatId);
  const chats = yield* KinChatService;
  const name = yield* namesFor(holder);
  const page = yield* keyed(holder, () =>
    chats.history(personOf(holder), {
      chatId,
      beforeSeq: input.before ?? Number.MAX_SAFE_INTEGER,
      limit: PAGE,
    }),
  );
  const messages = page.messages
    .filter((message) => message.status !== "deleted" && message.body.trim() !== "")
    .toSorted((a, b) => a.seq - b.seq)
    .map(lineOf(name));
  return {
    chat: chatId,
    messages,
    more: page.hasMore,
    before: page.hasMore ? (messages[0]?.seq ?? null) : null,
    material: MATERIAL,
  };
});

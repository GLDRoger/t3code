import {
  KinChatError,
  type KinAgentIntent,
  type KinChatId,
  type KinMessage,
  type KinMessageId,
  type KinMessagesSendInput,
  type KinReaction,
  type KinReactionEmoji,
  type KinWidget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import type { AgentIdentity } from "../chat/KinIdentity.ts";
import { AUDIENCE_MOVED, SHARED_OTHER_CHAT, audienceChanged, turnAudience } from "./Audience.ts";
import * as KinLevels from "./KinLevels.ts";

type PostInput = KinMessagesSendInput & { readonly intent: KinAgentIntent };
type WidgetInput = Parameters<KinChatService["Service"]["upsertWidget"]>[1];
type AskInput = Parameters<KinChatService["Service"]["ask"]>[1];
type ReadInput = Parameters<KinChatService["Service"]["read"]>[1];

/**
 * A lead's posts, cards, questions and reactions behind its permission in the chat: below L1 it
 * is refused, except in its own direct chat with its owner, where it always talks.
 */
export class KinLevelGate extends Context.Service<
  KinLevelGate,
  {
    readonly post: (
      agent: AgentIdentity,
      input: PostInput,
    ) => Effect.Effect<KinMessage, KinChatError>;
    readonly upsertWidget: (
      agent: AgentIdentity,
      input: WidgetInput,
    ) => Effect.Effect<KinWidget, KinChatError>;
    /** `kin_ask`'s choice card, gated like a post: it is the lead's reply too. */
    readonly ask: (agent: AgentIdentity, input: AskInput) => Effect.Effect<KinWidget, KinChatError>;
    /** `kin_react`: the lead's reaction, gated like a post since it can stand for its reply. */
    readonly react: (
      agent: AgentIdentity,
      input: {
        readonly chatId: KinChatId;
        readonly messageId: KinMessageId;
        readonly emoji: KinReactionEmoji;
      },
    ) => Effect.Effect<KinReaction, KinChatError>;
    /** `kin_chat_read`: a turn someone besides the owner reads reads only the chat it was asked in. */
    readonly read: (
      agent: AgentIdentity,
      input: ReadInput,
    ) => Effect.Effect<ReadonlyArray<KinMessage>, KinChatError>;
  }
>()("t3/kin/lead/LevelGate/KinLevelGate") {}

const isChatError = Schema.is(KinChatError);
const isLevelRefused = Schema.is(KinLevels.KinLevelRefused);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* KinChatService;

  // The lead's own direct chat with its owner, read from stored rows only.
  const isOwnerChat = Effect.fn("KinLevelGate.isOwnerChat")(
    function* (agent: AgentIdentity, chatId: KinChatId) {
      const rows = yield* sql<{ chatId: string }>`
        SELECT c.chat_id AS "chatId" FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = l.owner_chat_id
        WHERE l.org_id = ${agent.orgId} AND l.agent_id = ${agent.agentId}
          AND a.role = 'lead' AND a.retired_at IS NULL
          AND c.kind = 'direct' AND c.chat_id = ${chatId}
        ORDER BY l.agent_id`;
      return rows.length > 0;
    },
    Effect.mapError(toPersistenceSqlError("KinLevelGate.isOwnerChat")),
  );

  // The running wake-up of the calling lead thread; the reply bridge names its own.
  const turnOf = Effect.fn("KinLevelGate.turnOf")(
    function* (agent: AgentIdentity) {
      if (agent.wakeupId !== undefined)
        return { orgId: agent.orgId, agentId: agent.agentId, wakeupId: agent.wakeupId };
      const [row] = yield* sql<{ wakeupId: string }>`SELECT wakeup_id AS "wakeupId"
        FROM kin_wakeups WHERE org_id = ${agent.orgId} AND agent_id = ${agent.agentId}
          AND thread_id = ${agent.threadId} AND status = 'running'
        ORDER BY wakeup_id`;
      return row === undefined
        ? undefined
        : { orgId: agent.orgId, agentId: agent.agentId, wakeupId: row.wakeupId };
    },
    Effect.mapError(toPersistenceSqlError("KinLevelGate.turnOf")),
  );

  const notAllowed = new KinChatError({
    reason: "not_allowed",
    message: "You can't post in this chat. Nothing was sent.",
  });

  /**
   * Runs `allowed` in one transaction with the check; refuses below L1 outside the owner's DM.
   * The level is the lower of the target chat's and the asking wake-up's, so a chat can't post
   * through the lead where it couldn't itself.
   */
  const gated = <A, E>(
    operation: string,
    agent: AgentIdentity,
    chatId: KinChatId,
    allowed: Effect.Effect<A, E>,
  ): Effect.Effect<A, KinChatError> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const target = yield* KinLevels.effectiveLevel({
            orgId: agent.orgId,
            agentId: agent.agentId,
            chatId,
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          const level =
            agent.wakeupId === undefined
              ? target
              : KinLevels.lowest(
                  target,
                  yield* KinLevels.wakeupLevel({
                    orgId: agent.orgId,
                    agentId: agent.agentId,
                    wakeupId: agent.wakeupId,
                  }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
                );
          if (!KinLevels.atLeast(level, "L1") && !(yield* isOwnerChat(agent, chatId)))
            return yield* notAllowed;
          // A prompt built for the owner alone says nothing once someone else can read it.
          const turn = yield* turnOf(agent);
          if (
            turn !== undefined &&
            (yield* audienceChanged(turn).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
          )
            return yield* new KinChatError({ reason: "not_allowed", message: AUDIENCE_MOVED });
          return yield* allowed;
        }),
      )
      .pipe(
        Effect.catch((error) =>
          isChatError(error)
            ? Effect.fail(error)
            : isLevelRefused(error)
              ? Effect.fail(notAllowed)
              : Effect.logError(`Kin ${operation} failed`, error).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new KinChatError({ reason: "unavailable", message: "Kin is unavailable." }),
                    ),
                  ),
                ),
        ),
      );

  const read = Effect.fn("KinLevelGate.read")(
    function* (agent: AgentIdentity, input: ReadInput) {
      const turn = yield* turnOf(agent);
      if (turn === undefined) return yield* notAllowed;
      const audience = yield* turnAudience(turn).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      if (audience !== "owner_only") {
        const asked = yield* sql`SELECT 1 FROM kin_events
          WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId} AND wakeup_id = ${turn.wakeupId}
            AND tag IN ('chat.message', 'widget.action', 'chat.reaction')
            AND json_extract(json, '$.chatId') = ${input.chatId}
          LIMIT 1`.pipe(Effect.mapError(toPersistenceSqlError("KinLevelGate.read")));
        if (asked.length === 0)
          return yield* new KinChatError({ reason: "not_allowed", message: SHARED_OTHER_CHAT });
      }
      return yield* chat.read(agent, input);
    },
    Effect.catchIf(
      (error) => !isChatError(error),
      (error) =>
        Effect.logError("Kin gated read failed", error).pipe(
          Effect.andThen(
            Effect.fail(
              new KinChatError({ reason: "unavailable", message: "Kin is unavailable." }),
            ),
          ),
        ),
    ),
  );

  return KinLevelGate.of({
    read,
    post: Effect.fn("KinLevelGate.post")((agent, input) =>
      gated("gated post", agent, input.chatId, chat.send(agent, input)),
    ),
    upsertWidget: Effect.fn("KinLevelGate.upsertWidget")((agent, input) =>
      gated("gated widget upsert", agent, input.chatId, chat.upsertWidget(agent, input)),
    ),
    ask: Effect.fn("KinLevelGate.ask")((agent, input) =>
      gated("gated ask", agent, input.chatId, chat.ask(agent, input)),
    ),
    react: Effect.fn("KinLevelGate.react")((agent, input) =>
      gated("gated reaction", agent, input.chatId, chat.react(agent, { ...input, on: true })),
    ),
  });
});

export const layer = Layer.effect(KinLevelGate, make);

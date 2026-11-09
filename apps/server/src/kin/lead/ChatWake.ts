import {
  KinAgentId,
  KinEventId,
  KinMessageId,
  KinOrgId,
  TrimmedNonEmptyString,
  type KinEvent,
  type KinMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../../serverActivation.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinEventQueue } from "./KinEventQueue.ts";

const decodeTap = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ actionId: TrimmedNonEmptyString })),
);
// Matches the resume expiry: older unanswered messages are not worth a wake-up after downtime.
const CATCH_UP_WINDOW = { hours: 24 } as const;
const CATCH_UP_LIMIT = 200;

/**
 * Turns committed human chat posts and widget taps into `chat.message` and `widget.action`
 * events for the lead the floor manager would wake: mentioned leads, else the chat's lead.
 */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hub = yield* KinChatHub;
  const repo = yield* KinChatRepository;
  const queue = yield* KinEventQueue;

  const wake = Effect.fn("KinChatWake.wake")(
    function* (message: KinMessage) {
      if (message.author._tag !== "human" || message.status !== "posted") return;
      if (message.kind !== "text" && message.kind !== "widget_action") return;
      const leads = yield* sql<{ agentId: string; memberId: string }>`
        SELECT l.agent_id AS "agentId", m.member_id AS "memberId" FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id AND a.retired_at IS NULL
        JOIN kin_chat_members m ON m.org_id = l.org_id AND m.chat_id = ${message.chatId}
          AND m.principal_kind = 'agent' AND m.agent_id = l.agent_id AND m.left_at IS NULL
        WHERE l.org_id = ${message.orgId}
        ORDER BY CASE a.role WHEN 'lead' THEN 0 ELSE 1 END, m.joined_at, l.agent_id`;
      const mentioned = leads.filter((lead) =>
        message.mentions.some((memberId) => memberId === lead.memberId),
      );
      const targets = mentioned.length > 0 ? mentioned : leads.slice(0, 1);
      if (targets.length === 0) return;
      const actionId =
        message.kind === "widget_action"
          ? (yield* decodeTap(message.body).pipe(Effect.option)).pipe(
              Option.map((tap) => tap.actionId),
            )
          : Option.none();
      if (message.kind === "widget_action" && Option.isNone(actionId))
        return yield* Effect.logWarning("Kin widget action has no readable action id", {
          orgId: message.orgId,
          messageId: message.messageId,
        });
      for (const target of targets) {
        const agentId = KinAgentId.make(target.agentId);
        // Every field comes from the stored message, so a replay enqueues byte-identical JSON.
        const eventId = KinEventId.make(
          `${message.kind === "widget_action" ? "widget-action" : "chat-message"}:${message.messageId}:${agentId}`,
        );
        const base = {
          orgId: message.orgId,
          eventId,
          agentId,
          receivedAt: DateTime.makeUnsafe(message.createdAt),
          dedupeKey: eventId,
          provenance: message.author,
          chatId: message.chatId,
          messageId: message.messageId,
        };
        const event: KinEvent = Option.isSome(actionId)
          ? { ...base, _tag: "widget.action", actionId: actionId.value }
          : { ...base, _tag: "chat.message" };
        yield* queue.enqueue(event).pipe(
          Effect.catchTags({
            KinEventQueueRetiredAgent: () => Effect.void,
            KinEventQueueUnknownAgent: () => Effect.void,
            KinEventQueueConflict: (error) =>
              Effect.logWarning("Kin chat wake-up conflicts with a stored event", error),
          }),
        );
      }
    },
    Effect.catchCause((cause) => Effect.logError("Kin chat wake-up failed", { cause })),
  );

  // Messages posted while the server was down or Kin was off never reached the hub.
  const catchUp = Effect.fn("KinChatWake.catchUp")(
    function* () {
      const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, CATCH_UP_WINDOW));
      const rows = yield* sql<{ orgId: string; messageId: string; createdAt: string }>`
      SELECT DISTINCT m.org_id AS "orgId", m.message_id AS "messageId", m.created_at AS "createdAt"
      FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id AND a.retired_at IS NULL
      JOIN kin_chat_members am ON am.org_id = l.org_id AND am.principal_kind = 'agent'
        AND am.agent_id = l.agent_id AND am.left_at IS NULL
      JOIN kin_messages m ON m.org_id = am.org_id AND m.chat_id = am.chat_id
      WHERE m.author_kind = 'human' AND m.status = 'posted' AND m.kind IN ('text', 'widget_action')
        AND m.created_at > ${since}
        AND m.seq > COALESCE((SELECT MAX(x.seq) FROM kin_messages x
          WHERE x.org_id = m.org_id AND x.chat_id = m.chat_id AND x.author_kind = 'agent'
            AND x.author_agent_id = l.agent_id), 0)
      ORDER BY m.created_at DESC, m.message_id DESC LIMIT ${CATCH_UP_LIMIT}`;
      for (const row of rows) {
        const message = yield* repo.getMessage({
          orgId: KinOrgId.make(row.orgId),
          messageId: KinMessageId.make(row.messageId),
        });
        if (Option.isSome(message)) yield* wake(message.value);
      }
    },
    Effect.catchCause((cause) => Effect.logError("Kin chat wake-up catch-up failed", { cause })),
  );

  // Subscribe before activation so nothing posted from here on is missed.
  const events = yield* hub.subscribeAll;
  yield* catchUp().pipe(
    Effect.andThen(
      Stream.runForEach(events, (event) =>
        event.type === "message.posted" ? wake(event.message) : Effect.void,
      ),
    ),
    forkParked,
  );
});

export const layer = Layer.effectDiscard(make);

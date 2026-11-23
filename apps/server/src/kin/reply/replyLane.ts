import {
  KIN_TEAM_ROOM_TEAM_ID,
  KinChatId,
  type KinOrgId,
  type KinAgentId,
  type KinWakeupId,
} from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { owedNotice } from "../floor/KinFloor.ts";
import { CHAT_ANSWER_TAGS } from "../lead/Audience.ts";
import { outsideReview } from "../lead/outsideReview.ts";

/**
 * Where a wake-up's text goes. One wake-up answers one chat: the chat of its highest-priority
 * human message, card tap or reported work, else (a notice wake-up) the lead's direct chat with
 * its owner. `owed`: someone is waiting on words, so silence gets a rescue and then a plain line.
 */
export type Lane = {
  readonly chatId: KinChatId;
  readonly mode: "reply" | "notice";
  readonly owed: boolean;
  readonly leadName: string;
  /** A Team-room turn: it speaks only through `team_say`, and passing says nothing. */
  readonly team?: true;
  /** An outsider's pull request's review: Kin tells the owner from the post (`askedFor.ts`). */
  readonly quiet?: true;
};

/** The same turn-level reply/notice split, for a live reply or a recorded wake-up. */
export const turnAsked = (sql: SqlClient.SqlClient, row: "e" | "w") =>
  sql`EXISTS (SELECT 1 FROM kin_events h
    WHERE h.org_id = ${sql.literal(`${row}.org_id`)}
      AND h.agent_id = ${sql.literal(`${row}.agent_id`)}
      AND h.wakeup_id = ${sql.literal(`${row}.wakeup_id`)}
      AND h.tag IN ('chat.message', 'widget.action', 'chat.reaction'))`;

/** The lane of a running wake-up, from its stored events; `kin_ask` posts its card there too. */
export const laneFor = Effect.fn("KinReplyBridge.lane")(
  function* (input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly wakeupId: KinWakeupId;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const [lead] = yield* sql<{ ownerChatId: string; name: string }>`
      SELECT owner_chat_id AS "ownerChatId", name FROM kin_leads
      WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} ORDER BY agent_id`;
    // A worker's report answers where its work was asked for, as a notice: it owes no reply.
    const [first] = yield* sql<{ chatId: string; asked: number }>`
      SELECT json_extract(json, '$.chatId') AS "chatId",
        ${turnAsked(sql, "e")} AS asked
      FROM kin_events e
      WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND wakeup_id = ${input.wakeupId}
        AND tag IN ${sql.in(CHAT_ANSWER_TAGS)} AND json_extract(json, '$.chatId') IS NOT NULL
      ORDER BY priority, received_at, event_id LIMIT 1`;
    const chatId = first?.chatId ?? lead?.ownerChatId;
    if (chatId === undefined) return Option.none<Lane>();
    // Nothing the model writes there reaches a chat, so no reply can become a question either.
    if ((yield* outsideReview(input)) !== undefined)
      return Option.some<Lane>({
        chatId: KinChatId.make(chatId),
        mode: "notice",
        owed: false,
        leadName: lead?.name ?? "Agent",
        quiet: true,
      });
    // Only discussion turns Kin handed on in the Team room (`team:` keys), nothing else there.
    const [team] = yield* sql<{ others: number }>`SELECT COUNT(e.event_id) FILTER (
        WHERE e.dedupe_key IS NULL OR e.dedupe_key NOT LIKE 'team:%') AS others
      FROM kin_events e JOIN kin_chats c ON c.org_id = e.org_id
        AND c.chat_id = json_extract(e.json, '$.chatId') AND c.team_id = ${KIN_TEAM_ROOM_TEAM_ID}
      WHERE e.org_id = ${input.orgId} AND e.agent_id = ${input.agentId}
        AND e.wakeup_id = ${input.wakeupId} AND c.chat_id = ${chatId}
      HAVING COUNT(e.event_id) > 0`;
    if (team !== undefined && team.others === 0)
      return Option.some<Lane>({
        chatId: KinChatId.make(chatId),
        mode: "notice",
        owed: false,
        leadName: lead?.name ?? "Agent",
        team: true,
      });
    const mode = first !== undefined && first.asked === 1 ? "reply" : "notice";
    const waiting = yield* sql`SELECT 1 FROM kin_events e
      WHERE e.org_id = ${input.orgId} AND e.agent_id = ${input.agentId}
        AND e.wakeup_id = ${input.wakeupId} AND ${sql.literal(owedNotice("e"))} LIMIT 1`;
    return Option.some<Lane>({
      chatId: KinChatId.make(chatId),
      mode,
      owed: mode === "reply" || waiting.length > 0,
      leadName: lead?.name ?? "Agent",
    });
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin reply lane unavailable", { cause }).pipe(Effect.as(Option.none<Lane>())),
  ),
);

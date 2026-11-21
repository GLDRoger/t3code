import { KIN_TEAM_ROOM_TEAM_ID, KinChatId, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { linkMatcher } from "../chat/messageLinks.ts";

export const TEAM_ROOM_TITLE = "Team room";
/** The owner side's mute in the Team room: it lasts until they unmute, which nothing offers. */
export const TEAM_ROOM_MUTED = "9999-12-31T23:59:59.999Z";

/** The org's Team room, or null before agents first talk there. */
export const teamRoomOf = Effect.fn("KinTeamRoom.of")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ chatId: string }>`SELECT chat_id AS "chatId" FROM kin_chats
    WHERE org_id = ${orgId} AND kind = 'team_group' AND team_id = ${KIN_TEAM_ROOM_TEAM_ID}
      AND archived_at IS NULL ORDER BY created_at LIMIT 1`;
  return row === undefined ? null : KinChatId.make(row.chatId);
});

/** The agents `body` names, first-named first: the names the clients draw as links. */
export const namedAgents = <A extends { readonly name: string; readonly ownerChatId: string }>(
  body: string,
  agents: ReadonlyArray<A>,
): ReadonlyArray<A> => {
  const match = linkMatcher(
    agents.map((agent) => ({
      name: agent.name,
      to: { _tag: "chat" as const, chatId: agent.ownerChatId },
      note: null,
      chat: true,
    })),
    new Map(),
    false,
  );
  const named: Array<A> = [];
  for (const link of match(body)) {
    const agent = agents.find(
      (one) => link.to._tag === "chat" && one.ownerChatId === link.to.chatId,
    );
    if (agent !== undefined && !named.includes(agent)) named.push(agent);
  }
  return named;
};

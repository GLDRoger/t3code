import { KIN_TEAM_ROOM_TEAM_ID, KinChatId, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

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


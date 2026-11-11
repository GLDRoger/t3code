import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * SQL over trusted column names: `person` is not the chat's owner, its `owner` member. Every
 * lead a chat holds is that person's (`KinGroups.ownersLead`, `createDirect`).
 */
const notOwnerSql = (org: string, chat: string, person: string) =>
  `NOT EXISTS (SELECT 1 FROM kin_chat_members owner WHERE owner.org_id = ${org}
    AND owner.chat_id = ${chat} AND owner.role = 'owner' AND owner.principal_kind = 'person'
    AND owner.person_id = ${person})`;

/**
 * In the transaction that makes a member active: a person besides the owner reads from the next
 * seq on, and their chat is shared from then, once and for good (`shared_at`). Everything before
 * `shared_from_seq` was written for the owner alone. Returns whether this join shared the chat.
 */
export const recordJoin = Effect.fn("KinChatSharing.recordJoin")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly orgId: string; readonly chatId: string; readonly memberId: string },
) {
  const now = yield* Clock.currentTimeMillis;
  yield* sql`UPDATE kin_chat_members AS m SET joined_seq = CASE
      WHEN m.principal_kind = 'person' AND ${sql.literal(notOwnerSql("m.org_id", "m.chat_id", "m.person_id"))}
      THEN (SELECT c.last_seq + 1 FROM kin_chats c WHERE c.org_id = m.org_id AND c.chat_id = m.chat_id)
      ELSE 0 END
    WHERE m.org_id = ${input.orgId} AND m.member_id = ${input.memberId} AND m.left_at IS NULL`;
  const shared = yield* sql`UPDATE kin_chats AS c SET shared_at = ${now},
      shared_from_seq = c.last_seq + 1
    WHERE c.org_id = ${input.orgId} AND c.chat_id = ${input.chatId} AND c.shared_at IS NULL
      AND EXISTS (SELECT 1 FROM kin_chat_members m WHERE m.org_id = c.org_id
        AND m.chat_id = c.chat_id AND m.member_id = ${input.memberId} AND m.left_at IS NULL
        AND m.principal_kind = 'person' AND ${sql.literal(notOwnerSql("m.org_id", "m.chat_id", "m.person_id"))})
    RETURNING chat_id`;
  return shared.length > 0;
});

/** The first seq `memberId` may read: their join's, 0 for the owner; no member reads from 0. */
const joinedFrom = (sql: SqlClient.SqlClient, orgId: string, memberId: string) =>
  sql`COALESCE((SELECT joined.joined_seq FROM kin_chat_members joined
    WHERE joined.org_id = ${orgId} AND joined.member_id = ${memberId}), 0)`;

/**
 * Whether a row of `kin_messages` (unaliased) is one `memberId` may read: from their join on,
 * and not a tap on a card from before it, whose text would carry that card's. Undefined: any.
 */
export const readableBy = (
  sql: SqlClient.SqlClient,
  orgId: string,
  memberId: string | undefined,
) => {
  if (memberId === undefined) return sql`1 = 1`;
  const from = joinedFrom(sql, orgId, memberId);
  return sql`(kin_messages.seq >= ${from} AND (kin_messages.widget_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM kin_widgets card JOIN kin_messages anchor ON anchor.org_id = card.org_id
      AND anchor.message_id = card.message_id
    WHERE card.org_id = ${orgId} AND card.widget_id = kin_messages.widget_id
      AND anchor.seq < ${from})))`;
};

/** Whether `memberId` may read `messageId`, by `readableBy`. */
export const memberReads = Effect.fn("KinChatSharing.memberReads")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly orgId: string; readonly memberId: string; readonly messageId: string },
) {
  const rows = yield* sql`SELECT 1 FROM kin_messages WHERE kin_messages.org_id = ${input.orgId}
    AND kin_messages.message_id = ${input.messageId}
    AND ${readableBy(sql, input.orgId, input.memberId)} LIMIT 1`;
  return rows.length > 0;
});

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import { ownerLevelSql } from "../people/KinAccess.ts";

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

/**
 * Whether anyone below owner level (`KinAccess`), other than the owner member of the chat's
 * leads, reads the chat now, or did once it was shared (`shared_at`). A co-owner's own chat with a
 * lead is theirs as the owner's is his. None found is shared.
 */
export const chatShared = Effect.fn("KinChatSharing.chatShared")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly orgId: string; readonly chatId: string },
) {
  const rows = yield* sql`SELECT 1 FROM kin_chats c
    WHERE c.org_id = ${input.orgId} AND c.chat_id = ${input.chatId}
      AND NOT EXISTS (SELECT 1 FROM kin_chat_members m WHERE m.org_id = c.org_id
        AND m.chat_id = c.chat_id AND m.principal_kind = 'person'
        AND (m.left_at IS NULL OR c.shared_at IS NOT NULL)
        AND NOT ${sql.literal(ownerLevelSql("m.org_id", "m.person_id"))}
        AND NOT (m.role = 'owner' AND EXISTS (SELECT 1 FROM kin_agents a
          WHERE a.org_id = m.org_id AND a.owner_person_id = m.person_id)))
    LIMIT 1`;
  return rows.length === 0;
});

/**
 * The chat's history floor: the first seq a shared turn may see of it. The latest join among the
 * people in it now besides its owner, never below where it was first shared; a re-join raises it.
 * NULL for a chat never shared or not found, so a shared turn sees none of it.
 */
export const historyFloor = (
  sql: SqlClient.SqlClient,
  orgId: string | Statement.Fragment,
  chatId: string | Statement.Fragment,
) =>
  sql`(SELECT MAX(c.shared_from_seq, COALESCE((SELECT MAX(m.joined_seq) FROM kin_chat_members m
      WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id AND m.principal_kind = 'person'
        AND m.left_at IS NULL AND ${sql.literal(notOwnerSql("m.org_id", "m.chat_id", "m.person_id"))}), 0))
    FROM kin_chats c WHERE c.org_id = ${orgId} AND c.chat_id = ${chatId})`;

/** The first seq `memberId` may read: their join's, 0 for the owner; no member reads from 0. */
const joinedFrom = (sql: SqlClient.SqlClient, orgId: string, memberId: string) =>
  sql`COALESCE((SELECT joined.joined_seq FROM kin_chat_members joined
    WHERE joined.org_id = ${orgId} AND joined.member_id = ${memberId}), 0)`;

/**
 * Whether a row of `kin_messages` (unaliased) is one `memberId` may read: from their join on,
 * and not a tap on a card from before it, whose text would carry that card's. Undefined: any.
 * `floorOf`, a shared turn's read of that chat: from its history floor on too.
 */
export const readableBy = (
  sql: SqlClient.SqlClient,
  orgId: string,
  memberId: string | undefined,
  floorOf?: string,
) => {
  const floor = floorOf === undefined ? undefined : historyFloor(sql, orgId, floorOf);
  const joined = memberId === undefined ? undefined : joinedFrom(sql, orgId, memberId);
  const from =
    joined === undefined ? floor : floor === undefined ? joined : sql`MAX(${joined}, ${floor})`;
  return from === undefined ? sql`1 = 1` : readableFrom(sql, orgId, from);
};

/** `readableBy` from the seq `from` (SQL) on; a query's own member row can give it. */
export const readableFrom = (
  sql: SqlClient.SqlClient,
  orgId: string | Statement.Fragment,
  from: Statement.Fragment,
) =>
  sql`(kin_messages.seq >= ${from} AND (kin_messages.widget_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM kin_widgets card JOIN kin_messages anchor ON anchor.org_id = card.org_id
      AND anchor.message_id = card.message_id
    WHERE card.org_id = ${orgId} AND card.widget_id = kin_messages.widget_id
      AND anchor.seq < ${from})))`;

/** A row of `kin_messages` (unaliased) this person reads now: in its chat, from their join on. */
export const personReads = (sql: SqlClient.SqlClient, personId: string | Statement.Fragment) =>
  sql`EXISTS (SELECT 1 FROM kin_chat_members reader WHERE reader.org_id = kin_messages.org_id
    AND reader.chat_id = kin_messages.chat_id AND reader.principal_kind = 'person'
    AND reader.person_id = ${personId} AND reader.left_at IS NULL
    AND ${readableFrom(sql, sql`kin_messages.org_id`, sql`COALESCE(reader.joined_seq, 0)`)})`;

/** Whether `memberId` may read `messageId`, by `readableBy`; `floorOf` as there. */
export const memberReads = Effect.fn("KinChatSharing.memberReads")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly orgId: string;
    readonly memberId: string;
    readonly messageId: string;
    readonly floorOf?: string | undefined;
  },
) {
  const rows = yield* sql`SELECT 1 FROM kin_messages WHERE kin_messages.org_id = ${input.orgId}
    AND kin_messages.message_id = ${input.messageId}
    AND ${readableBy(sql, input.orgId, input.memberId, input.floorOf)} LIMIT 1`;
  return rows.length > 0;
});

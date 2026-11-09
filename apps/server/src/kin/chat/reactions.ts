import {
  KIN_NO_REACTIONS,
  KIN_YES_REACTIONS,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  KinReactionEmoji,
  type KinChoiceCardState,
  type KinReaction,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";

/** An owner reaction wakes the lead at most this often per chat. */
const KIN_REACTION_COOLDOWN_MS = 30_000;
/** The backlog carries a chat's newest live reactions, at most this many. */
const BACKLOG_REACTIONS = 1_000;

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const Row = Schema.Struct({
  orgId: KinOrgId,
  chatId: KinChatId,
  messageId: KinMessageId,
  memberId: KinMemberId,
  emoji: KinReactionEmoji,
  createdAt: Schema.Number,
  removedAt: Schema.NullOr(Schema.Number),
});
const toReaction = (row: typeof Row.Type): KinReaction => ({
  ...row,
  createdAt: iso(row.createdAt),
  removedAt: row.removedAt === null ? null : iso(row.removedAt),
});
const columns = `org_id AS "orgId", chat_id AS "chatId", message_id AS "messageId",
  member_id AS "memberId", emoji, created_at AS "createdAt", removed_at AS "removedAt"`;

type Key = {
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
  readonly messageId: KinMessageId;
  readonly memberId: KinMemberId;
  readonly emoji: KinReactionEmoji;
};

/** 👍 ✅ read as yes, 👎 ❌ as no; ❤️ 👀 are feelings and answer nothing. */
export const reactionAnswer = (emoji: KinReactionEmoji): "yes" | "no" | null =>
  (KIN_YES_REACTIONS as ReadonlyArray<string>).includes(emoji)
    ? "yes"
    : (KIN_NO_REACTIONS as ReadonlyArray<string>).includes(emoji)
      ? "no"
      : null;

/** The option a yes/no reaction picks: only a card with exactly one yes and one no option. */
export const reactionOption = (card: KinChoiceCardState, emoji: KinReactionEmoji) => {
  const answer = reactionAnswer(emoji);
  if (answer === null) return undefined;
  const yes = card.options.filter((option) => option.kind === "yes");
  const no = card.options.filter((option) => option.kind === "no");
  if (yes.length !== 1 || no.length !== 1) return undefined;
  return answer === "yes" ? yes[0] : no[0];
};

/**
 * Turns the member's reaction on or off. `changed` is false when it already was; a re-added
 * reaction gets a fresh `created_at`, so it reads as new.
 */
export const setReaction = Effect.fn("KinReactions.set")(
  function* (input: Key & { readonly on: boolean; readonly now: number; readonly woke: boolean }) {
    const sql = yield* SqlClient.SqlClient;
    const rows = input.on
      ? yield* sql`INSERT INTO kin_reactions
          (org_id, chat_id, message_id, member_id, emoji, created_at, removed_at, woke_at)
        VALUES (${input.orgId}, ${input.chatId}, ${input.messageId}, ${input.memberId}, ${input.emoji},
          ${input.now}, NULL, ${input.woke ? input.now : null})
        ON CONFLICT (org_id, chat_id, message_id, member_id, emoji) DO UPDATE SET
          created_at = excluded.created_at, removed_at = NULL, woke_at = excluded.woke_at
        WHERE kin_reactions.removed_at IS NOT NULL
        RETURNING 1 AS changed`
      : yield* sql`UPDATE kin_reactions SET removed_at = ${input.now}
        WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND message_id = ${input.messageId}
          AND member_id = ${input.memberId} AND emoji = ${input.emoji} AND removed_at IS NULL
        RETURNING 1 AS changed`;
    const [stored] = yield* SqlSchema.findAll({
      Request: Schema.Unknown,
      Result: Row,
      execute: () => sql`SELECT ${sql.literal(columns)} FROM kin_reactions
        WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND message_id = ${input.messageId}
          AND member_id = ${input.memberId} AND emoji = ${input.emoji}
        ORDER BY created_at`,
    })(input);
    return { reaction: stored === undefined ? null : toReaction(stored), changed: rows.length > 0 };
  },
  Effect.mapError(toPersistenceSqlError("KinReactions.set")),
);

/** Whether an owner reaction woke the lead in this chat within the cooldown. */
export const recentlyWoke = Effect.fn("KinReactions.recentlyWoke")(
  function* (input: {
    readonly orgId: KinOrgId;
    readonly chatId: KinChatId;
    readonly now: number;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT 1 FROM kin_reactions
      WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}
        AND woke_at > ${input.now - KIN_REACTION_COOLDOWN_MS}
      ORDER BY woke_at DESC LIMIT 1`;
    return rows.length > 0;
  },
  Effect.mapError(toPersistenceSqlError("KinReactions.recentlyWoke")),
);

/** Live reactions in a chat, newest first; with `messageIds`, only on those messages. */
export const liveReactions = Effect.fn("KinReactions.live")(
  function* (input: {
    readonly orgId: KinOrgId;
    readonly chatId: KinChatId;
    readonly messageIds?: ReadonlyArray<KinMessageId>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    if (input.messageIds !== undefined && input.messageIds.length === 0) return [];
    const rows = yield* SqlSchema.findAll({
      Request: Schema.Unknown,
      Result: Row,
      execute: () => sql`SELECT ${sql.literal(columns)} FROM kin_reactions
        WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND removed_at IS NULL
          ${input.messageIds === undefined ? sql`` : sql`AND message_id IN ${sql.in(input.messageIds)}`}
        ORDER BY created_at DESC, message_id, member_id, emoji LIMIT ${BACKLOG_REACTIONS}`,
    })(input);
    return rows.map(toReaction);
  },
  Effect.mapError(toPersistenceSqlError("KinReactions.live")),
);

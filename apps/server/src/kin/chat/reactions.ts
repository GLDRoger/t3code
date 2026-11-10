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

/** A first owner reaction wakes the lead at most this often per chat; a changed answer skips it. */
const KIN_REACTION_COOLDOWN_MS = 30_000;
/** Reactions on one message wake the lead at most this many times; after that they are feedback. */
export const KIN_REACTION_WAKES_PER_MESSAGE = 3;
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

/** 👍 ✅ read as yes, 👎 ❌ as no; every other reaction is a feeling and answers nothing. */
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

/** The reaction that asks the lead what was wrong with an ordinary message. */
export const KIN_CLARIFY_REACTION = "👎" satisfies KinReactionEmoji;

/**
 * Turns the member's reaction on or off. Turning one on withdraws the member's other reactions
 * on the message, returned as `replaced`: one reaction per person per message. `changed` is
 * false when it already was; a re-added reaction gets a fresh `created_at`, so it reads as new,
 * and keeps the `woke_at` of an earlier wake.
 */
export const setReaction = Effect.fn("KinReactions.set")(
  function* (input: Key & { readonly on: boolean; readonly now: number; readonly woke: boolean }) {
    const sql = yield* SqlClient.SqlClient;
    const replaced = input.on
      ? yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: Row,
          execute: () => sql`UPDATE kin_reactions SET removed_at = ${input.now}
            WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}
              AND message_id = ${input.messageId} AND member_id = ${input.memberId}
              AND emoji != ${input.emoji} AND removed_at IS NULL
            RETURNING ${sql.literal(columns)}`,
        })(input)
      : [];
    const rows = input.on
      ? yield* sql`INSERT INTO kin_reactions
          (org_id, chat_id, message_id, member_id, emoji, created_at, removed_at, woke_at)
        VALUES (${input.orgId}, ${input.chatId}, ${input.messageId}, ${input.memberId}, ${input.emoji},
          ${input.now}, NULL, ${input.woke ? input.now : null})
        ON CONFLICT (org_id, chat_id, message_id, member_id, emoji) DO UPDATE SET
          created_at = excluded.created_at, removed_at = NULL,
          woke_at = COALESCE(kin_reactions.woke_at, excluded.woke_at)
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
    return {
      reaction: stored === undefined ? null : toReaction(stored),
      changed: rows.length > 0,
      replaced: replaced.map(toReaction),
    };
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
    const rows = yield* sql`SELECT 1 FROM kin_reaction_wakes
      WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}
        AND woke_at > ${input.now - KIN_REACTION_COOLDOWN_MS}
      ORDER BY woke_at DESC LIMIT 1`;
    return rows.length > 0;
  },
  Effect.mapError(toPersistenceSqlError("KinReactions.recentlyWoke")),
);

const WakeRow = Schema.Struct({
  emoji: KinReactionEmoji,
  answer: Schema.NullOr(Schema.Literals(["yes", "no"])),
  wakes: Schema.Number,
  latest: Schema.Number,
});

/**
 * The owner reactions that woke the lead on a message: the emoji and answer the last wake carried,
 * how many there were, and whether this message is the one a reaction last woke the chat for.
 */
export const reactionWake = Effect.fn("KinReactions.wake")(
  function* (input: {
    readonly orgId: KinOrgId;
    readonly chatId: KinChatId;
    readonly messageId: KinMessageId;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* SqlSchema.findAll({
      Request: Schema.Unknown,
      Result: WakeRow,
      execute: () => sql`SELECT w.emoji, w.answer, w.wakes,
          w.message_id = (SELECT l.message_id FROM kin_reaction_wakes l
            WHERE l.org_id = w.org_id AND l.chat_id = w.chat_id
            ORDER BY l.woke_at DESC, l.message_id LIMIT 1) AS latest
        FROM kin_reaction_wakes w
        WHERE w.org_id = ${input.orgId} AND w.chat_id = ${input.chatId}
          AND w.message_id = ${input.messageId}
        ORDER BY w.message_id LIMIT 1`,
    })(input);
    return row === undefined ? undefined : { ...row, latest: row.latest === 1 };
  },
  Effect.mapError(toPersistenceSqlError("KinReactions.wake")),
);

/** Records a reaction wake on the message: `answer` is null for a withdrawn yes. */
export const recordWake = Effect.fn("KinReactions.recordWake")(
  function* (input: {
    readonly orgId: KinOrgId;
    readonly chatId: KinChatId;
    readonly messageId: KinMessageId;
    readonly emoji: KinReactionEmoji;
    readonly answer: "yes" | "no" | null;
    readonly now: number;
  }) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_reaction_wakes
        (org_id, chat_id, message_id, emoji, answer, wakes, woke_at)
      VALUES (${input.orgId}, ${input.chatId}, ${input.messageId}, ${input.emoji}, ${input.answer},
        1, ${input.now})
      ON CONFLICT (org_id, message_id) DO UPDATE SET emoji = excluded.emoji,
        answer = excluded.answer, wakes = kin_reaction_wakes.wakes + 1, woke_at = excluded.woke_at`;
  },
  Effect.mapError(toPersistenceSqlError("KinReactions.recordWake")),
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

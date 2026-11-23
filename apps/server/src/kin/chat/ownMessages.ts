import {
  KinChatError,
  KinChatId,
  KinMessageId,
  KinWaitingId,
  type KinAgentId,
  type KinOrgId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevelSql } from "../people/KinAccess.ts";
import * as Questions from "../questions/openQuestions.ts";
import type { KinEventQueue } from "../lead/KinEventQueue.ts";
import { KinChatHub } from "./KinChatHub.ts";
import { KinChatRepository } from "./KinChatRepository.ts";
import { encodeNames, nameKeys, nameThreads } from "./messageLinks.ts";

/** Unread messages of its own an agent's turn lists, newest first; older ones are counted. */
export const OWN_UNREAD_SHOWN = 20;
/** How much of each one's text a turn shows. */
export const OWN_UNREAD_CLIP = 200;

/**
 * No person in the chat now has read message `m`: it is past every one's read mark. The same
 * messages leave the unread count once withdrawn (`status`), so both read one rule.
 */
export const unreadByAll = (
  sql: SqlClient.SqlClient,
) => sql`m.seq > COALESCE((SELECT MAX(r.last_read_seq)
    FROM kin_chat_members p JOIN kin_read_state r ON r.org_id = p.org_id AND r.chat_id = p.chat_id
      AND r.member_id = p.member_id
    WHERE p.org_id = m.org_id AND p.chat_id = m.chat_id AND p.principal_kind = 'person'
      AND p.left_at IS NULL), 0)
  AND EXISTS (SELECT 1 FROM kin_chat_members p WHERE p.org_id = m.org_id
    AND p.chat_id = m.chat_id AND p.principal_kind = 'person' AND p.left_at IS NULL)`;

/** An agent's message people see as one: posted, not silent, not a closed card's status. */
export const agentMessage = (sql: SqlClient.SqlClient) => sql`m.author_kind = 'agent'
  AND m.status = 'posted' AND m.silent = 0 AND m.kind = 'text'
  AND NOT (m.body = '' AND EXISTS (SELECT 1 FROM kin_widgets w
    WHERE w.org_id = m.org_id AND w.message_id = m.message_id AND w.closed_at IS NOT NULL))`;

export interface OwnUnread {
  readonly messageId: KinMessageId;
  readonly chatId: KinChatId;
  readonly createdAt: number;
  readonly body: string;
  /** Its card's kind and whether it still takes an answer; absent without one. */
  readonly card?: { readonly type: string; readonly open: boolean };
}

/**
 * This agent's messages in these chats that no person there has read yet, newest first, at most
 * `OWN_UNREAD_SHOWN`, and how many in all. From stored rows: read marks, never notifications.
 */
export const ownUnread = Effect.fn("KinOwnMessages.unread")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatIds: ReadonlyArray<KinChatId>;
}) {
  if (input.chatIds.length === 0) return { shown: [] as ReadonlyArray<OwnUnread>, total: 0 };
  const sql = yield* SqlClient.SqlClient;
  const where = sql`m.org_id = ${input.orgId} AND m.chat_id IN ${sql.in(input.chatIds)}
    AND m.author_agent_id = ${input.agentId} AND ${agentMessage(sql)} AND ${unreadByAll(sql)}`;
  const [count] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM kin_messages m
    WHERE ${where}`;
  const rows = yield* sql<{
    messageId: string;
    chatId: string;
    createdAt: string;
    body: string;
    cardType: string | null;
    cardOpen: number | null;
  }>`SELECT m.message_id AS "messageId", m.chat_id AS "chatId", m.created_at AS "createdAt",
      substr(m.body, 1, ${OWN_UNREAD_CLIP * 2}) AS body, w.type AS "cardType",
      (w.closed_at IS NULL) AS "cardOpen"
    FROM kin_messages m
    LEFT JOIN kin_widgets w ON w.org_id = m.org_id AND w.widget_id = (SELECT g.widget_id
      FROM kin_widgets g WHERE g.org_id = m.org_id
        AND (g.message_id = m.message_id OR g.widget_id = m.widget_id)
      ORDER BY g.widget_id LIMIT 1)
    WHERE ${where}
    ORDER BY m.seq DESC, m.chat_id LIMIT ${OWN_UNREAD_SHOWN}`;
  return {
    shown: rows.map((row): OwnUnread => ({
      messageId: KinMessageId.make(row.messageId),
      chatId: KinChatId.make(row.chatId),
      createdAt: Date.parse(row.createdAt),
      body: Array.from(row.body).slice(0, OWN_UNREAD_CLIP).join(""),
      ...(row.cardType === null ? {} : { card: { type: row.cardType, open: row.cardOpen === 1 } }),
    })),
    total: count?.total ?? 0,
  };
});

/**
 * The chats a check-in looks at for one person: the turn's own, and each other chat with this
 * agent where every person is owner-level, so nothing there leaves the owner's side.
 */
export const ownerSideChats = Effect.fn("KinOwnMessages.ownerSideChats")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly personId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ chatId: string }>`SELECT c.chat_id AS "chatId" FROM kin_chats c
    JOIN kin_chat_members a ON a.org_id = c.org_id AND a.chat_id = c.chat_id
      AND a.principal_kind = 'agent' AND a.agent_id = ${input.agentId} AND a.left_at IS NULL
    JOIN kin_chat_members p ON p.org_id = c.org_id AND p.chat_id = c.chat_id
      AND p.principal_kind = 'person' AND p.person_id = ${input.personId} AND p.left_at IS NULL
    WHERE c.org_id = ${input.orgId} AND c.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM kin_chat_members o WHERE o.org_id = c.org_id
        AND o.chat_id = c.chat_id AND o.principal_kind = 'person' AND o.left_at IS NULL
        AND NOT ${sql.literal(ownerLevelSql("o.org_id", "o.person_id"))})
    ORDER BY c.chat_id`;
  return rows.map((row) => KinChatId.make(row.chatId));
});

const refuse = (message: string, reason: "not_found" | "not_allowed" = "not_allowed") =>
  new KinChatError({ reason, message });

/** The refusals an agent reads; each says what to do instead. */
export const OWN_MESSAGE_REFUSALS = {
  unknown: "No such message.",
  person:
    "A person wrote that message, and their words are theirs: answer it in a new message instead.",
  otherAuthor: "Only the agent that wrote that message can withdraw or replace it.",
  notMember: "You're no longer in that chat, so you can't change your messages there.",
  withdrawn: "That message was already withdrawn.",
  read: (name: string) =>
    `${name} has read that message. Say what changed in a new message instead.`,
  confirm:
    "That message carries a Confirm card for money or mail. It is withdrawn through its card, not here.",
  openCard:
    "That message carries a card that still waits on someone. Close the card first, or say what changed in a new message.",
  brief: "That message is a brief's page. Withdraw it, or say what changed in a new message.",
} as const;

type Stored = {
  chatId: string;
  authorKind: string;
  agentId: string | null;
  status: string;
  seq: number;
  kind: string;
  body: string;
  form: string | null;
  withdrawn: string | null;
};

/** The message, checked as the agent's own, in a chat it is in, that no person there has read. */
const ownUnreadMessage = Effect.fnUntraced(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly messageId: KinMessageId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<Stored>`SELECT m.chat_id AS "chatId", m.author_kind AS "authorKind",
      m.author_agent_id AS "agentId", m.status, m.seq, m.kind, m.body, m.form,
      json_extract(m.withdrawn_json, '$.why') AS withdrawn
    FROM kin_messages m WHERE m.org_id = ${input.orgId} AND m.message_id = ${input.messageId}`;
  if (row === undefined) return yield* refuse(OWN_MESSAGE_REFUSALS.unknown, "not_found");
  if (row.authorKind === "human") return yield* refuse(OWN_MESSAGE_REFUSALS.person);
  if (row.authorKind !== "agent" || row.agentId !== input.agentId)
    return yield* refuse(OWN_MESSAGE_REFUSALS.otherAuthor);
  const member = yield* sql`SELECT 1 FROM kin_chat_members WHERE org_id = ${input.orgId}
    AND chat_id = ${row.chatId} AND principal_kind = 'agent' AND agent_id = ${input.agentId}
    AND left_at IS NULL`;
  if (member.length === 0) return yield* refuse(OWN_MESSAGE_REFUSALS.notMember);
  const [reader] = yield* sql<{ name: string }>`SELECT p.display_name AS name
    FROM kin_chat_members c
    JOIN kin_read_state r ON r.org_id = c.org_id AND r.chat_id = c.chat_id
      AND r.member_id = c.member_id
    JOIN kin_people p ON p.org_id = c.org_id AND p.person_id = c.person_id
    WHERE c.org_id = ${input.orgId} AND c.chat_id = ${row.chatId} AND c.principal_kind = 'person'
      AND c.left_at IS NULL AND r.last_read_seq >= ${row.seq}
    ORDER BY r.updated_at, p.display_name LIMIT 1`;
  return { ...row, chatId: KinChatId.make(row.chatId), reader: reader?.name };
});

/** The cards on a message: a Confirm refuses both tools, as one still waiting on someone does. */
const cardsOf = Effect.fnUntraced(function* (orgId: KinOrgId, messageId: KinMessageId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    widgetId: string;
    type: string;
    open: number;
    awaiting: number;
  }>`SELECT g.widget_id AS "widgetId", g.type, (g.closed_at IS NULL) AS open,
      (g.closed_at IS NULL AND g.awaiting_json <> '[]') AS awaiting
    FROM kin_widgets g WHERE g.org_id = ${orgId} AND (g.message_id = ${messageId}
      OR g.widget_id = (SELECT widget_id FROM kin_messages WHERE org_id = ${orgId}
        AND message_id = ${messageId}))
    ORDER BY g.widget_id`;
});

/** Publishes the message as it now reads, and any Waiting on you rows it settled, after commit. */
const told = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  messageId: KinMessageId,
  waiting: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const hub = yield* Effect.serviceOption(KinChatHub);
  const repo = yield* KinChatRepository;
  const message = yield* repo
    .getMessage({ orgId, messageId })
    .pipe(Effect.mapError(() => refuse("Kin is unavailable.")));
  if (Option.isNone(hub) || Option.isNone(message)) return message;
  yield* sql.afterCommit(
    hub.value.publish({ type: "message.changed", orgId, message: message.value }),
  );
  for (const waitingId of waiting) {
    const item = yield* repo
      .getWaiting({ orgId, waitingId: KinWaitingId.make(waitingId) })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(item))
      yield* sql.afterCommit(
        hub.value.publish({ type: "waiting.updated", orgId, item: item.value }),
      );
  }
  return message;
});

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * `message_withdraw`, inside `KinLevelGate.amend`'s transaction. The words stay stored; people see
 * one line with `why`. An open question goes by its own path; a Confirm or other waiting card
 * refuses. A retry with the same `why` answers as the first did.
 */
export const withdrawOwn = Effect.fn("KinOwnMessages.withdraw")(function* (
  input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly wakeupId: string;
    readonly messageId: KinMessageId;
    readonly why: string;
    readonly now: number;
  },
  chat: Parameters<typeof Questions.closeQuestion>[1],
  queue: Pick<KinEventQueue["Service"], "enqueue">,
) {
  const sql = yield* SqlClient.SqlClient;
  const why = input.why.replace(/\s+/g, " ").trim();
  const row = yield* ownUnreadMessage(input);
  if (row.status !== "posted") {
    if (row.withdrawn === why) return { messageId: input.messageId, withdrawn: true } as const;
    return yield* refuse(OWN_MESSAGE_REFUSALS.withdrawn);
  }
  if (row.reader !== undefined) return yield* refuse(OWN_MESSAGE_REFUSALS.read(row.reader));
  const cards = yield* cardsOf(input.orgId, input.messageId);
  if (cards.some((card) => card.type === "approval"))
    return yield* refuse(OWN_MESSAGE_REFUSALS.confirm);
  const ids = cards.map((card) => card.widgetId);
  const asked =
    ids.length === 0
      ? []
      : yield* sql<{ questionId: string; widgetId: string | null; raiseWidgetId: string | null }>`
          SELECT question_id AS "questionId", widget_id AS "widgetId",
            raise_widget_id AS "raiseWidgetId"
          FROM kin_questions WHERE org_id = ${input.orgId} AND state = 'open'
            AND (widget_id IN ${sql.in(ids)} OR raise_widget_id IN ${sql.in(ids)})
          ORDER BY question_id`;
  const questionCards = new Set(asked.flatMap((q) => [q.widgetId, q.raiseWidgetId]));
  if (cards.some((card) => card.awaiting === 1 && !questionCards.has(card.widgetId)))
    return yield* refuse(OWN_MESSAGE_REFUSALS.openCard);
  for (const question of asked)
    yield* Questions.closeQuestion(
      {
        orgId: input.orgId,
        agentId: input.agentId,
        wakeupId: input.wakeupId,
        questionId: question.questionId,
        outcome: "withdrawn",
        now: input.now,
      },
      chat,
      queue,
    );
  const at = iso(input.now);
  const changed = yield* sql`UPDATE kin_messages SET status = 'deleted',
      withdrawn_json = json_object('why', ${why}, 'at', ${at})
    WHERE org_id = ${input.orgId} AND message_id = ${input.messageId} AND status = 'posted'
    RETURNING message_id`;
  if (changed.length === 0) return yield* refuse(OWN_MESSAGE_REFUSALS.withdrawn);
  const settled = yield* sql<{ waitingId: string }>`UPDATE kin_waiting
    SET resolved_at = ${at}, resolution = 'withdrawn'
    WHERE org_id = ${input.orgId} AND message_id = ${input.messageId} AND resolved_at IS NULL
    RETURNING waiting_id AS "waitingId"`;
  yield* told(
    input.orgId,
    input.messageId,
    settled.map((one) => one.waitingId),
  );
  return { messageId: input.messageId, withdrawn: true } as const;
});

/**
 * `message_replace`: the agent puts the current version in place of its own message that no
 * person in the chat has read. It shows in place, marked updated (`editedAt`). Its words are named
 * as a new post's are. Run inside the post gate's transaction (`KinLevelGate.amend`).
 */
export const replaceOwn = Effect.fn("KinOwnMessages.replace")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly messageId: KinMessageId;
  readonly body: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* ownUnreadMessage(input);
  if (row.status !== "posted") return yield* refuse(OWN_MESSAGE_REFUSALS.withdrawn);
  if (row.reader !== undefined) return yield* refuse(OWN_MESSAGE_REFUSALS.read(row.reader));
  if (row.form === "brief") return yield* refuse(OWN_MESSAGE_REFUSALS.brief);
  const cards = yield* cardsOf(input.orgId, input.messageId);
  if (cards.some((card) => card.type === "approval"))
    return yield* refuse(OWN_MESSAGE_REFUSALS.confirm);
  const named = yield* nameKeys(
    input.orgId,
    row.chatId,
    yield* nameThreads(input.orgId, row.chatId, input.body.trim()),
  );
  if (named.body === row.body) return { messageId: input.messageId, replaced: true } as const;
  yield* sql`UPDATE kin_messages SET body = ${named.body}, edited_at = ${iso(input.now)}
    WHERE org_id = ${input.orgId} AND message_id = ${input.messageId} AND status = 'posted'`;
  yield* named.names.length === 0
    ? sql`DELETE FROM kin_message_names WHERE org_id = ${input.orgId}
        AND message_id = ${input.messageId}`
    : sql`INSERT INTO kin_message_names (org_id, message_id, names_json)
        VALUES (${input.orgId}, ${input.messageId}, ${encodeNames(named.names)})
        ON CONFLICT (org_id, message_id) DO UPDATE SET names_json = excluded.names_json`;
  yield* told(input.orgId, input.messageId, []);
  return { messageId: input.messageId, replaced: true } as const;
});

/** Which chat a message is in, for the gate to check before the change; unknown reads as none. */
export const chatOfMessage = Effect.fn("KinOwnMessages.chatOf")(function* (
  orgId: KinOrgId,
  messageId: KinMessageId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ chatId: string }>`SELECT chat_id AS "chatId" FROM kin_messages
    WHERE org_id = ${orgId} AND message_id = ${messageId}`;
  return row === undefined ? undefined : KinChatId.make(row.chatId);
});

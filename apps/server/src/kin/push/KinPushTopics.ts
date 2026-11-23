// @effect-diagnostics nodeBuiltinImport:off -- synchronous SHA-256 for collapse ids.
import * as NodeCrypto from "node:crypto";

import {
  KinActionId,
  KinChatId,
  type KinMemberId,
  type KinMessageId,
  type KinOrgId,
  type KinPersonId,
  type KinPushTopic,
  type KinPushWithdrawn,
  type KinRecordKey,
  type KinWidgetId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ApproverKeys } from "../approvals/ApproverKeys.ts";
import { KinPendingActions } from "../approvals/PendingActions.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { withLinks } from "../chat/messageLinks.ts";
import { memberReads } from "../chat/sharing.ts";
import { factsStand } from "../pulse/factState.ts";
import { aboutOf, noteAbout } from "./pushAbout.ts";
import { canHearRecord } from "../work/recordComments.ts";

/** How long the host remembers a push it sent. */
const KIN_PUSH_SENT_KEPT = Duration.days(7);

export const chatTopic = (chatId: KinChatId) => `c:${chatId}` as KinPushTopic;
export const cardTopic = (widgetId: KinWidgetId) => `w:${widgetId}` as KinPushTopic;
export const questionTopic = (questionId: string) => `q:${questionId}` as KinPushTopic;
export const approvalTopic = (actionId: KinActionId) => `a:${actionId}` as KinPushTopic;
export const taskTopic = (key: KinRecordKey | string) => `r:${key}` as KinPushTopic;
export const noticeTopic = (messageId: KinMessageId) => `f:${messageId}` as KinPushTopic;
export const troubleTopic = (cause: string) => `t:${cause}` as KinPushTopic;
/** Task news held through quiet hours, released as one banner: one per release. */
export const bundleTopic = (holdIds: ReadonlyArray<string>) =>
  `b:${NodeCrypto.createHash("sha256")
    .update([...holdIds].toSorted().join("\u0000"))
    .digest("hex")
    .slice(0, 32)}` as KinPushTopic;
export const uniqueTopic = (id: string) => `u:${id}` as KinPushTopic;

/**
 * `apns-collapse-id` and Android's `tag` for a topic: a newer push with it replaces the shown one.
 * Of this host and company only: two hosts' `kin-default` never replace each other's. 38 bytes,
 * within APNs' 64, and apart from the per-message ids older builds are sent.
 */
export const kinTopicCollapseId = (environmentId: string, orgId: KinOrgId, topic: KinPushTopic) =>
  `kin:t:${NodeCrypto.createHash("sha256")
    .update(`${environmentId}\u0000${orgId}\u0000${topic}`)
    .digest("hex")
    .slice(0, 32)}`;

export type KinPushSentRow = {
  readonly personId: KinPersonId;
  readonly topic: KinPushTopic;
  /** The last push's version of the topic for this person. */
  readonly version: number;
  readonly chatId: KinChatId | null;
  readonly messageId: KinMessageId | null;
  /** A chat's banner: the newest message position it covers. */
  readonly seq: number | null;
  readonly sentAt: number;
  readonly withdrawnAt: number | null;
};

/** Which live rows a commit may have settled: any that matches one of these, for anyone or one person. */
export type KinPushSettled = {
  readonly topics?: ReadonlyArray<KinPushTopic>;
  /** Pushes that came from these messages. */
  readonly messageIds?: ReadonlyArray<KinMessageId>;
  /** Pushes that came from this chat. */
  readonly chatId?: KinChatId;
  /** Topics of these kinds, such as `f`. */
  readonly kinds?: ReadonlyArray<string>;
  /** Notices and bundles about any of these (`task:<record key>`, `fact:<fact key>`). */
  readonly keys?: ReadonlyArray<string>;
  readonly personId?: KinPersonId;
};

const ROW = `person_id AS "personId", topic, version, chat_id AS "chatId", message_id AS "messageId",
  seq, sent_at AS "sentAt", withdrawn_at AS "withdrawnAt"`;
const PRUNE_BATCH = 5_000;
const PRUNE_BATCHES = 20;

/** The topic store, read and written in the caller's services. */
export const makeKinPushTopics = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const chats = yield* KinChatRepository;
  const actions = yield* KinPendingActions;
  const keys = yield* ApproverKeys;
  const provide = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.provideService(effect, SqlClient.SqlClient, sql);

  /**
   * `personId` is about to be sent a push about `topic`: its next version, which stands until
   * settled. Taken before the send, so the push can carry it.
   */
  const reserve = Effect.fn("KinPushTopics.reserve")(function* (input: {
    readonly orgId: KinOrgId;
    readonly personId: KinPersonId;
    readonly topic: KinPushTopic;
    readonly chatId: KinChatId | undefined;
    readonly messageId: KinMessageId | undefined;
    readonly seq?: number | undefined;
    /** What it is about (`task:` keys); Kin's notice of several tasks finds its own. */
    readonly about?: ReadonlyArray<string> | undefined;
  }) {
    const now = yield* Clock.currentTimeMillis;
    const about =
      input.about ??
      (input.topic.startsWith("f:") && input.messageId !== undefined
        ? (yield* noticeTasks(input.orgId, input.personId, input.messageId)).map(
            (key) => `task:${key}`,
          )
        : []);
    yield* provide(noteAbout(input.orgId, input.topic, about));
    const [row] = yield* sql<{ version: number }>`INSERT INTO kin_push_sent (org_id, person_id,
        topic, version, chat_id, message_id, seq, sent_at)
      VALUES (${input.orgId}, ${input.personId}, ${input.topic}, 1, ${input.chatId ?? null},
        ${input.messageId ?? null}, ${input.seq ?? null}, ${now})
      ON CONFLICT (org_id, person_id, topic) DO UPDATE SET version = kin_push_sent.version + 1,
        sent_at = excluded.sent_at, chat_id = excluded.chat_id, message_id = excluded.message_id,
        seq = excluded.seq, withdrawn_at = NULL
      RETURNING version`;
    return row?.version ?? 1;
  });

  const memberOf = (orgId: KinOrgId, personId: KinPersonId, chatId: KinChatId) =>
    sql<{ memberId: KinMemberId }>`SELECT member_id AS "memberId" FROM kin_chat_members
      WHERE org_id = ${orgId} AND chat_id = ${chatId} AND principal_kind = 'person'
        AND person_id = ${personId} AND left_at IS NULL
      ORDER BY member_id LIMIT 1`.pipe(Effect.map(([row]) => row?.memberId));

  /** Whether `personId` may still read `messageId` and has not read it on any device. */
  const unread = Effect.fn("KinPushTopics.unread")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
    chatId: KinChatId,
    messageId: KinMessageId,
  ) {
    const memberId = yield* memberOf(orgId, personId, chatId);
    if (memberId === undefined) return false;
    const [row] = yield* sql<{ one: number }>`SELECT 1 AS one FROM kin_messages m
      JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
      WHERE m.org_id = ${orgId} AND m.chat_id = ${chatId} AND m.message_id = ${messageId}
        AND m.status = 'posted' AND m.seq > c.cleared_seq
        AND m.seq > COALESCE((SELECT r.last_read_seq FROM kin_read_state r
          WHERE r.org_id = m.org_id AND r.chat_id = m.chat_id AND r.member_id = ${memberId}), 0)`;
    return row !== undefined && (yield* memberReads(sql, { orgId, memberId, messageId }));
  });

  /** A task they hold or were told of: still open, theirs to see, and not handed on since. */
  const taskStands = Effect.fn("KinPushTopics.taskStands")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
    key: string,
    since: number,
  ) {
    const [record] = yield* sql<{
      recordId: string;
      ownerKind: string;
      ownerId: string;
      assignedAt: number | null;
    }>`SELECT record_id AS "recordId", owner_kind AS "ownerKind", owner_id AS "ownerId",
        assigned_at AS "assignedAt"
      FROM kin_records WHERE org_id = ${orgId} AND key = ${key}
        AND state NOT IN ('done', 'dropped')
      ORDER BY record_id LIMIT 1`;
    if (record === undefined) return false;
    const handedOn =
      !(record.ownerKind === "person" && record.ownerId === personId) &&
      record.assignedAt !== null &&
      record.assignedAt >= since;
    return !handedOn && (yield* provide(canHearRecord(orgId, personId, record.recordId)));
  });

  const keysOf = (orgId: KinOrgId, ref: string, prefix: string) =>
    provide(aboutOf(orgId, ref, prefix));

  /** A notice of pulse facts stands while one of them does, as the pulse tells holders. */
  const factsOk = Effect.fn("KinPushTopics.factsOk")(function* (
    orgId: KinOrgId,
    row: KinPushSentRow,
  ) {
    if (row.messageId === null) return true;
    const facts = yield* keysOf(orgId, row.messageId, "fact:");
    return (
      facts.length === 0 ||
      (yield* provide(factsStand(orgId, row.personId, facts, yield* Clock.currentTimeMillis)))
    );
  });

  /** Whether any task in `ref`'s keys still stands for them. */
  const anyTaskStands = Effect.fn("KinPushTopics.anyTaskStands")(function* (
    orgId: KinOrgId,
    row: KinPushSentRow,
  ) {
    for (const key of yield* keysOf(orgId, row.topic, "task:"))
      if (yield* taskStands(orgId, row.personId, key, row.sentAt)) return true;
    return false;
  });

  /** The tasks Kin's notice names for its reader (`subjectFor`'s read). */
  const noticeTasks = Effect.fn("KinPushTopics.noticeTasks")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
    messageId: KinMessageId,
  ) {
    const message = yield* chats.getMessage({ orgId, messageId });
    if (Option.isNone(message)) return [];
    const [listed] = yield* provide(
      withLinks(orgId, { _tag: "person", personId }, [{ ...message.value, kind: "text" }]),
    );
    return (listed?.links ?? []).flatMap(({ to }) =>
      to._tag === "record" && to.kind === "task" ? [to.key] : [],
    );
  });

  /**
   * Whether the topic of `row` still needs its person, from the rows as they are now. A notice
   * (`r:` `f:` `t:`) from a chat message is settled once read; a card, question or approval once
   * decided, read or not.
   */
  const stands = Effect.fn("KinPushTopics.stands")(function* (
    orgId: KinOrgId,
    row: KinPushSentRow,
  ) {
    const { personId } = row;
    const kind = row.topic.slice(0, 1);
    const id = row.topic.slice(2);
    const fromMessage = row.chatId !== null && row.messageId !== null;
    const notRead = () =>
      row.chatId === null || row.messageId === null
        ? Effect.succeed(true)
        : unread(orgId, personId, row.chatId, row.messageId);
    switch (kind) {
      // About the messages it covers, not the chat: one of them still unread for them.
      case "c": {
        const chatId = KinChatId.make(id);
        const memberId = yield* memberOf(orgId, personId, chatId);
        if (memberId === undefined) return false;
        const [left] = yield* sql`SELECT 1 FROM kin_messages m
          JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
          WHERE m.org_id = ${orgId} AND m.chat_id = ${chatId} AND m.status = 'posted'
            AND m.seq <= ${row.seq ?? Number.MAX_SAFE_INTEGER} AND m.seq > c.cleared_seq
            AND m.seq > COALESCE((SELECT r.last_read_seq FROM kin_read_state r
              WHERE r.org_id = m.org_id AND r.chat_id = m.chat_id AND r.member_id = ${memberId}), 0)
          LIMIT 1`;
        return left !== undefined;
      }
      case "w": {
        const [card] = yield* sql<{ chatId: KinChatId; awaiting: string }>`SELECT w.chat_id AS
            "chatId", w.awaiting_json AS awaiting FROM kin_widgets w
          JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
            AND m.status = 'posted'
          WHERE w.org_id = ${orgId} AND w.widget_id = ${id} AND w.closed_at IS NULL`;
        return (
          card !== undefined &&
          awaits(card.awaiting, personId) &&
          (yield* memberOf(orgId, personId, card.chatId)) !== undefined
        );
      }
      case "q": {
        const cards = yield* sql<{ chatId: KinChatId; awaiting: string }>`SELECT w.chat_id AS
            "chatId", w.awaiting_json AS awaiting
          FROM kin_questions q JOIN kin_widgets w ON w.org_id = q.org_id
            AND (w.widget_id = q.widget_id OR w.widget_id = q.raise_widget_id)
            AND w.closed_at IS NULL
          WHERE q.org_id = ${orgId} AND q.question_id = ${id} AND q.state = 'open'
          ORDER BY w.widget_id`;
        for (const card of cards)
          if (
            awaits(card.awaiting, personId) &&
            (yield* memberOf(orgId, personId, card.chatId)) !== undefined
          )
            return true;
        return false;
      }
      case "a": {
        const action = yield* actions.get({ orgId, actionId: KinActionId.make(id) });
        if (Option.isNone(action) || action.value.state !== "awaiting_approval") return false;
        return (yield* keys.activeApprovers(orgId)).includes(personId);
      }
      case "t": {
        const [open] = yield* sql`SELECT 1 FROM kin_troubles
          WHERE org_id = ${orgId} AND cause = ${id} AND closed_at IS NULL`;
        return open !== undefined && (yield* notRead());
      }
      case "r":
        return (
          (yield* notRead()) &&
          (yield* taskStands(orgId, personId, id, row.sentAt)) &&
          (yield* factsOk(orgId, row))
        );
      case "f":
        return (
          fromMessage &&
          (yield* notRead()) &&
          (yield* anyTaskStands(orgId, row)) &&
          (yield* factsOk(orgId, row))
        );
      case "b":
        return yield* anyTaskStands(orgId, row);
      // Nothing settles it but the person: the phone drops it when it is opened.
      default:
        return true;
    }
  });

  /** Live rows a commit may have settled, oldest first. */
  const live = Effect.fn("KinPushTopics.live")(function* (
    orgId: KinOrgId,
    settled: KinPushSettled,
  ) {
    const any = [
      ...(settled.topics !== undefined && settled.topics.length > 0
        ? [sql`topic IN ${sql.in(settled.topics)}`]
        : []),
      ...(settled.messageIds !== undefined && settled.messageIds.length > 0
        ? [sql`message_id IN ${sql.in(settled.messageIds)}`]
        : []),
      ...(settled.chatId === undefined ? [] : [sql`chat_id = ${settled.chatId}`]),
      ...(settled.kinds ?? []).map((kind) => sql`substr(topic, 1, 2) = ${`${kind}:`}`),
      ...(settled.keys !== undefined && settled.keys.length > 0
        ? [
            sql`topic IN (SELECT ref FROM kin_push_about WHERE org_id = ${orgId}
              AND key IN ${sql.in(settled.keys)})`,
            sql`message_id IN (SELECT ref FROM kin_push_about WHERE org_id = ${orgId}
              AND key IN ${sql.in(settled.keys)})`,
          ]
        : []),
    ];
    if (any.length === 0) return [];
    return yield* sql<KinPushSentRow>`SELECT ${sql.literal(ROW)} FROM kin_push_sent
      WHERE org_id = ${orgId} AND withdrawn_at IS NULL AND (${sql.or(any)})
        ${settled.personId === undefined ? sql`` : sql`AND person_id = ${settled.personId}`}
      ORDER BY sent_at, person_id, topic`;
  });

  /** Marks the topic withdrawn for them at `row`'s version, once: true when this call did. */
  const withdraw = Effect.fn("KinPushTopics.withdraw")(function* (
    orgId: KinOrgId,
    row: KinPushSentRow,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const moved = yield* sql`UPDATE kin_push_sent SET withdrawn_at = ${now}
      WHERE org_id = ${orgId} AND person_id = ${row.personId} AND topic = ${row.topic}
        AND version = ${row.version} AND withdrawn_at IS NULL
      RETURNING topic`;
    return moved.length > 0;
  });

  /**
   * Of the topics a phone still shows, those the host sent `personId` that are settled now. A
   * topic it never sent them, or no longer remembers, is not theirs to ask about.
   */
  const settledOf = Effect.fn("KinPushTopics.settledOf")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
    topics: ReadonlyArray<KinPushTopic>,
  ) {
    if (topics.length === 0) return [];
    const rows = yield* sql<KinPushSentRow>`SELECT ${sql.literal(ROW)} FROM kin_push_sent
      WHERE org_id = ${orgId} AND person_id = ${personId} AND topic IN ${sql.in([...new Set(topics)])}
      ORDER BY topic`;
    const remove: Array<KinPushWithdrawn> = [];
    for (const row of rows)
      if (row.withdrawnAt !== null || !(yield* stands(orgId, row)))
        remove.push({ topic: row.topic, version: row.version });
    return remove;
  });

  /** Live rows after `after`, oldest first, across orgs: the recovery pass's next page. */
  const due = Effect.fn("KinPushTopics.due")(function* (
    after: { readonly sentAt: number; readonly rowid: number } | undefined,
    limit: number,
  ) {
    // Scheduler maintenance over every org's live rows, bounded by `limit` (`recover`).
    return yield* sql<KinPushSentRow & { readonly orgId: KinOrgId; readonly rowid: number }>`
      SELECT org_id AS "orgId", rowid, ${sql.literal(ROW)} FROM kin_push_sent
      WHERE withdrawn_at IS NULL ${
        after === undefined
          ? sql``
          : sql`AND (sent_at > ${after.sentAt} OR (sent_at = ${after.sentAt} AND rowid > ${after.rowid}))`
      }
      ORDER BY sent_at, rowid LIMIT ${limit}`;
  });

  /** Their unread count in `chatId`, 0 when they are not in it. */
  const unreadIn = Effect.fn("KinPushTopics.unreadIn")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
    chatId: KinChatId,
  ) {
    const memberId = yield* memberOf(orgId, personId, chatId);
    return memberId === undefined ? 0 : yield* chats.unreadCount({ orgId, chatId, memberId });
  });

  return { reserve, stands, live, withdraw, settledOf, unreadIn, due };
});

const decodeIds = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));
const awaits = (awaitingJson: string, personId: KinPersonId) =>
  Option.match(decodeIds(awaitingJson), {
    onNone: () => false,
    onSome: (ids) => ids.includes(personId),
  });

/** Rows older than `KIN_PUSH_SENT_KEPT` go, a bounded batch at a time (`KinRetention`). */
export const prunePushSent = Effect.fn("KinPushTopics.prune")(function* (now: number) {
  const sql = yield* SqlClient.SqlClient;
  const before = now - Duration.toMillis(KIN_PUSH_SENT_KEPT);
  for (let batch = 0; batch < PRUNE_BATCHES; batch++) {
    // Every org: a sweep by age, bounded by the batch size.
    const gone = yield* sql`DELETE FROM kin_push_sent WHERE rowid IN (
        SELECT rowid FROM kin_push_sent WHERE sent_at < ${before} ORDER BY sent_at LIMIT ${PRUNE_BATCH})
      RETURNING 1`;
    if (gone.length < PRUNE_BATCH) break;
  }
  for (let batch = 0; batch < PRUNE_BATCHES; batch++) {
    const gone = yield* sql`DELETE FROM kin_push_about WHERE rowid IN (
        SELECT rowid FROM kin_push_about WHERE at < ${before} LIMIT ${PRUNE_BATCH})
      RETURNING 1`;
    if (gone.length < PRUNE_BATCH) return;
  }
});

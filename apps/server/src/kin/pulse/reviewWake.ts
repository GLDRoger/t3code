// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous event-id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KinAgentId,
  KinChatId,
  KinEvent,
  KinEventId,
  KinPersonId,
  type KinOrgId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { agentMessage, unreadByAll } from "../chat/ownMessages.ts";
import { keysIn } from "../chat/messageLinks.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { personQuietUntil } from "../triggers/quietHold.ts";
import { listDef, stateLabel } from "../work/registers.ts";

/** How long a person has had an agent's messages unread before Kin may wake it to look again. */
export const REVIEW_UNREAD_MS = 2 * 60 * 60_000;
/** A record title shorter than this ("Retainer") names too much to count as naming the record. */
const TITLE_MIN = 12;
/** How long before someone's quiet hours end their coming working day counts as a change. */
export const REVIEW_BEFORE_DAY_MS = 30 * 60_000;

const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const shortHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
const joined = (parts: ReadonlyArray<string>) =>
  parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

type Pending = {
  readonly messageId: string;
  readonly createdAt: number;
  readonly body: string;
};

/** What changed about these messages since each was posted, as of `at`, newest change last. */
export interface ReviewChanges {
  /** Records they name by key whose state moved since: the key and its state now. */
  readonly records: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly state: string;
    readonly at: number;
  }>;
  /** When the latest card on one of them closed. */
  readonly cardClosedAt?: number;
  /** When the latest pulse fact one of them was told for cleared. */
  readonly factClearedAt?: number;
  /** A person there whose working day starts within `REVIEW_BEFORE_DAY_MS`: when that window opened. */
  readonly dayStartsAt?: number;
}

/** The latest moment in `changes`, or undefined when nothing changed. */
export const changedAt = (changes: ReviewChanges) => {
  const all = [
    ...changes.records.map((one) => one.at),
    changes.cardClosedAt,
    changes.factClearedAt,
    changes.dayStartsAt,
  ].filter((at): at is number => at !== undefined);
  return all.length === 0 ? undefined : Math.max(...all);
};

/**
 * What changed about an agent's unread messages in a chat since they were posted: a record one
 * names by key changed state, a card on one closed, a pulse fact one was told for cleared, or a
 * person there is about to start their working day after quiet hours. From stored rows.
 */
export const reviewChanges = Effect.fn("KinReview.changes")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: string;
  readonly messages: ReadonlyArray<Pending>;
  readonly at: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, messages } = input;
  const ids = messages.map((one) => one.messageId);
  const posted = new Map(messages.map((one) => [one.messageId, one.createdAt] as const));
  const named = yield* sql<{ messageId: string; key: string }>`SELECT n.message_id AS "messageId",
      json_extract(k.value, '$.key') AS key
    FROM kin_message_names n, json_each(n.names_json) k
    WHERE n.org_id = ${orgId} AND n.message_id IN ${sql.in(ids)}
    UNION
    -- Agents name a record by its number ("INV/26-27/004") or its title more often than its key.
    SELECT m.message_id AS "messageId", r.key FROM kin_messages m JOIN kin_records r
      ON r.org_id = m.org_id AND (instr(m.body, json_extract(r.fields_json, '$.number')) > 0
        OR (length(r.title) >= ${TITLE_MIN} AND instr(lower(m.body), lower(r.title)) > 0))
    WHERE m.org_id = ${orgId} AND m.message_id IN ${sql.in(ids)}
    ORDER BY 1, 2`;
  const since = new Map<string, number>();
  const note = (key: string, at: number) => since.set(key, Math.min(since.get(key) ?? at, at));
  for (const one of messages) for (const key of keysIn(one.body)) note(key, one.createdAt);
  for (const row of named) note(row.key, posted.get(row.messageId) ?? input.at);
  const records: Array<{ key: string; title: string; state: string; at: number }> = [];
  if (since.size > 0) {
    const moved = yield* sql<{
      key: string;
      title: string;
      list: string;
      state: string;
      at: number;
    }>`SELECT r.key, r.title, r.register_id AS list, r.state, MAX(c.at) AS at
      FROM kin_records r JOIN kin_record_changes c ON c.org_id = r.org_id
        AND c.record_id = r.record_id
      WHERE r.org_id = ${orgId} AND r.key IN ${sql.in([...since.keys()])}
        AND EXISTS (SELECT 1 FROM json_each(c.fields_json) f
          WHERE json_extract(f.value, '$.field') = 'state')
      GROUP BY r.record_id ORDER BY r.key`;
    for (const row of moved) {
      if (row.at <= (since.get(row.key) ?? Infinity) || row.at > input.at) continue;
      const def = yield* listDef(orgId, row.list);
      records.push({
        key: row.key,
        title: row.title,
        state: def === undefined ? row.state : stateLabel(def, row.state).toLowerCase(),
        at: row.at,
      });
    }
  }
  const cards = yield* sql<{ messageId: string; closedAt: string }>`SELECT m.message_id AS
      "messageId", g.closed_at AS "closedAt"
    FROM kin_messages m JOIN kin_widgets g ON g.org_id = m.org_id
      AND (g.message_id = m.message_id OR g.widget_id = m.widget_id)
    WHERE m.org_id = ${orgId} AND m.message_id IN ${sql.in(ids)} AND g.closed_at IS NOT NULL
    ORDER BY m.message_id`;
  const closed = cards
    .map((row) => ({ at: Date.parse(row.closedAt), from: posted.get(row.messageId) ?? Infinity }))
    .filter((row) => row.at > row.from && row.at <= input.at)
    .map((row) => row.at);
  // The facts the turn that posted each one was woken for, or told of in a check-in.
  const facts = yield* sql<{ messageId: string; clearedAt: number }>`SELECT m.message_id AS
      "messageId", f.cleared_at AS "clearedAt"
    FROM kin_messages m JOIN kin_events e ON e.org_id = m.org_id
      AND e.wakeup_id = m.source_wakeup_id AND e.tag = 'pulse'
    JOIN kin_pulse_facts f ON f.org_id = e.org_id AND f.cleared_at IS NOT NULL
      AND (f.fact_key IN (SELECT k.value FROM json_each(e.json, '$.factKeys') k)
        OR f.fact_key IN (SELECT t.fact_key FROM kin_pulse_told t
          WHERE t.org_id = e.org_id AND t.event_id = e.event_id))
    WHERE m.org_id = ${orgId} AND m.message_id IN ${sql.in(ids)}
    ORDER BY m.message_id`;
  const cleared = facts
    .filter((row) => row.clearedAt > (posted.get(row.messageId) ?? Infinity))
    .filter((row) => row.clearedAt <= input.at)
    .map((row) => row.clearedAt);
  const people = yield* sql<{ personId: string }>`SELECT person_id AS "personId"
    FROM kin_chat_members WHERE org_id = ${orgId} AND chat_id = ${input.chatId}
      AND principal_kind = 'person' AND left_at IS NULL ORDER BY person_id`;
  let dayStartsAt: number | undefined;
  for (const { personId } of people) {
    const ends = yield* personQuietUntil(orgId, KinPersonId.make(personId), input.at);
    if (ends !== undefined && ends - input.at <= REVIEW_BEFORE_DAY_MS)
      dayStartsAt = Math.max(dayStartsAt ?? 0, ends - REVIEW_BEFORE_DAY_MS);
  }
  return {
    records,
    ...(closed.length === 0 ? {} : { cardClosedAt: Math.max(...closed) }),
    ...(cleared.length === 0 ? {} : { factClearedAt: Math.max(...cleared) }),
    ...(dayStartsAt === undefined ? {} : { dayStartsAt }),
  } satisfies ReviewChanges;
});

/** Each agent and chat with messages no person there has read, the oldest first, from stored rows. */
const unreadByChat = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  agentId?: string,
  chatId?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    agentId: string;
    chatId: string;
    messageId: string;
    createdAt: string;
    body: string;
  }>`SELECT m.author_agent_id AS "agentId", m.chat_id AS "chatId", m.message_id AS "messageId",
      m.created_at AS "createdAt", m.body
    FROM kin_messages m
    JOIN kin_chat_members a ON a.org_id = m.org_id AND a.chat_id = m.chat_id
      AND a.principal_kind = 'agent' AND a.agent_id = m.author_agent_id AND a.left_at IS NULL
    WHERE m.org_id = ${orgId} AND ${agentMessage(sql)} AND ${unreadByAll(sql)}
      ${agentId === undefined ? sql`` : sql`AND m.author_agent_id = ${agentId}`}
      ${chatId === undefined ? sql`` : sql`AND m.chat_id = ${chatId}`}
    ORDER BY m.author_agent_id, m.chat_id, m.seq`;
  const groups = new Map<string, { agentId: string; chatId: string; messages: Array<Pending> }>();
  for (const row of rows) {
    const key = `${row.agentId}\u0000${row.chatId}`;
    const group = groups.get(key) ?? { agentId: row.agentId, chatId: row.chatId, messages: [] };
    group.messages.push({
      messageId: row.messageId,
      createdAt: Date.parse(row.createdAt),
      body: row.body,
    });
    groups.set(key, group);
  }
  return [...groups.values()];
});

const REVIEW_KEY = (agentId: string, chatId: string) => `review:${agentId}:${chatId}:`;

/**
 * The sweep's one review wake per agent and chat (`KinPulse.tick`): when a person there has had
 * its messages unread for `REVIEW_UNREAD_MS`, something they are about changed since the oldest
 * was posted (`reviewChanges`), no review of that chat is queued or running, and the last one was
 * before that change. Plain code from stored rows; the turn decides what to keep.
 */
export const reviewWakes = Effect.fn("KinPulse.reviewWakes")(function* (ctx: {
  readonly orgId: KinOrgId;
  readonly at: number;
}) {
  const { orgId, at } = ctx;
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue.KinEventQueue;
  const woken: Array<{ readonly agentId: string; readonly chatId: string }> = [];
  for (const group of yield* unreadByChat(orgId)) {
    const oldest = group.messages[0]!.createdAt;
    if (at - oldest < REVIEW_UNREAD_MS) continue;
    const change = changedAt(
      yield* reviewChanges({ orgId, chatId: group.chatId, messages: group.messages, at }),
    );
    if (change === undefined) continue;
    const key = REVIEW_KEY(group.agentId, group.chatId);
    const [last] = yield* sql<{ open: number; lastAt: number | null }>`SELECT
        COUNT(*) FILTER (WHERE state IN ('queued', 'claimed')) AS open,
        MAX(received_at) AS "lastAt"
      FROM kin_events WHERE org_id = ${orgId} AND agent_id = ${group.agentId}
        AND tag = 'pulse' AND substr(dedupe_key, 1, ${key.length}) = ${key}`;
    if ((last?.open ?? 0) > 0 || (last?.lastAt ?? -Infinity) >= change) continue;
    const agentId = KinAgentId.make(group.agentId);
    const chatId = KinChatId.make(group.chatId);
    const dedupeKey = `${key}${change}`;
    const queued = yield* queue
      .enqueue(
        yield* decodeEvent({
          _tag: "pulse",
          orgId,
          eventId: KinEventId.make(`pulse-${shortHash(`${orgId}\0${dedupeKey}`)}`),
          agentId,
          receivedAt: iso(at),
          dedupeKey,
          provenance: { _tag: "system" },
          factKeys: [],
          chatId,
          origin: { agentId, chatId },
          review: true,
        }),
      )
      .pipe(
        Effect.map((result) => !result.duplicate),
        Effect.catchTags({
          KinEventQueueUnknownAgent: () => Effect.succeed(false),
          KinEventQueueRetiredAgent: () => Effect.succeed(false),
        }),
      );
    if (queued) woken.push({ agentId: group.agentId, chatId: group.chatId });
  }
  return woken;
});

/** The review wake's own line: who hasn't read what, what changed, and what to do. */
export const REVIEW_WAKE_TEXT = (input: {
  readonly who: ReadonlyArray<string>;
  readonly count: number;
  readonly changed: string;
}) =>
  `Kin woke you to look again at what you said here. ${joined(input.who) || "No one"} ${input.who.length > 1 ? "haven't" : "hasn't"} read ${input.count === 1 ? "your message" : `your ${input.count} messages`} listed under Your messages no one has read yet, and since you wrote ${input.count === 1 ? "it" : "them"}, ${input.changed}. For each one: leave it if it still stands, take it back with message_withdraw if it no longer matters, or put the current version in its place with message_replace. Post nothing new unless something new needs them. Then write exactly NO_REPLY.`;
/** The review wake found, as it started, nothing of the agent's here unread any more. */
export const REVIEW_NOTHING_NOW =
  "Kin woke you to look again at your unread messages here, but as this turn started everything you said here had been read or taken back.";

/**
 * A review wake's text, worked out again as its turn starts: undefined when nothing of the
 * agent's in the chat is still unread.
 */
export const reviewWakeText = Effect.fn("KinReview.wakeText")(function* (
  orgId: KinOrgId,
  event: Extract<KinEvent, { readonly _tag: "pulse" }>,
  at: number,
) {
  if (event.chatId === undefined) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const [group] = yield* unreadByChat(orgId, event.agentId, event.chatId);
  if (group === undefined) return undefined;
  const changes = yield* reviewChanges({
    orgId,
    chatId: group.chatId,
    messages: group.messages,
    at,
  });
  const people = yield* sql<{ name: string }>`SELECT p.display_name AS name
    FROM kin_chat_members c JOIN kin_people p ON p.org_id = c.org_id AND p.person_id = c.person_id
    WHERE c.org_id = ${orgId} AND c.chat_id = ${group.chatId} AND c.principal_kind = 'person'
      AND c.left_at IS NULL ORDER BY p.display_name`;
  const said = [
    ...changes.records.map((one) => `${one.key} (${one.title}) is now ${one.state}`),
    ...(changes.cardClosedAt === undefined ? [] : ["a card on one of them closed"]),
    ...(changes.factClearedAt === undefined
      ? []
      : ["something one of them told of is no longer so"]),
    ...(changes.dayStartsAt === undefined ? [] : ["their working day is about to start"]),
  ];
  return REVIEW_WAKE_TEXT({
    who: people.map((one) => one.name),
    count: group.messages.length,
    changed: said.length === 0 ? "things may have moved on" : joined(said),
  });
});

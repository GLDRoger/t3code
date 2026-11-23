import { KinPersonId, type KinAgentId, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";

import { turnChat } from "../lead/Audience.ts";
import { directKey } from "../lead/LeadAccess.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { mailboxPerson } from "./turnMailbox.ts";

type Turn = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
};

/**
 * Whose own mailbox the turn read, if any (`kin_private_turns`): what it holds is that person's,
 * and its writes are fenced (`privateRefusal`). Null for every other turn.
 */
export const privateTo = Effect.fn("KinPrivateTurn.privateTo")(function* (
  turn: Pick<Turn, "orgId" | "wakeupId">,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ personId: string | null }>`SELECT person_id AS "personId"
    FROM kin_private_turns WHERE org_id = ${turn.orgId} AND wakeup_id = ${turn.wakeupId}`;
  return row?.personId ?? null;
});

/**
 * In the caller's transaction, before a read's result leaves: the turn is `personId`'s from now
 * on, and so is every connection call it made, refused ones included.
 */
export const markPrivate = Effect.fn("KinPrivateTurn.markPrivate")(function* (
  turn: Pick<Turn, "orgId" | "wakeupId">,
  personId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO kin_private_turns (org_id, wakeup_id, person_id, marked_at)
    VALUES (${turn.orgId}, ${turn.wakeupId}, ${personId}, ${now})
    ON CONFLICT (org_id, wakeup_id) DO NOTHING`;
  yield* sql`UPDATE kin_connection_calls SET private_to = ${personId}
    WHERE org_id = ${turn.orgId} AND wakeup_id = ${turn.wakeupId} AND private_to IS NULL`;
});

/**
 * A turn made from one whose wake-up was private (a reminder or schedule it set) is private to
 * the same person, before its prompt is read.
 */
export const inheritPrivacy = Effect.fn("KinPrivateTurn.inherit")(function* (
  turn: Pick<Turn, "orgId" | "wakeupId">,
  sourceEventIds: ReadonlyArray<string>,
) {
  if (sourceEventIds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const [from] = yield* sql<{ personId: string }>`SELECT p.person_id AS "personId"
    FROM kin_events e JOIN kin_private_turns p ON p.org_id = e.org_id
      AND p.wakeup_id = e.wakeup_id
    WHERE e.org_id = ${turn.orgId} AND e.event_id IN ${sql.in(sourceEventIds)}
    ORDER BY e.event_id LIMIT 1`;
  if (from !== undefined) yield* markPrivate(turn, from.personId);
});

/**
 * Whose a connection call is, for the owner's log: the turn's mailbox person once it read their
 * mailbox, or the one person below owner level a turn is for; else nobody's (the company's).
 */
export const callPrivacy = Effect.fn("KinPrivateTurn.callPrivacy")(function* (turn: Turn) {
  const marked = yield* privateTo(turn);
  if (marked !== null) return marked;
  const person = yield* mailboxPerson(turn);
  if (person === null) return null;
  return (yield* ownerLevel(turn.orgId, person)) ? null : person;
});

/** Whether `personId`'s own message, tap or reaction in their own chat with this agent woke it. */
const startedBy = Effect.fn("KinPrivateTurn.startedBy")(function* (turn: Turn, personId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_events e
    JOIN kin_chats c ON c.org_id = e.org_id AND c.chat_id = json_extract(e.json, '$.chatId')
      AND c.kind = 'direct' AND c.direct_key = ${directKey(KinPersonId.make(personId), turn.agentId)}
    WHERE e.org_id = ${turn.orgId} AND e.agent_id = ${turn.agentId}
      AND e.wakeup_id = ${turn.wakeupId}
      AND json_extract(e.json, '$.origin') IS NULL
      AND ((e.tag IN ('chat.message', 'widget.action') AND EXISTS (SELECT 1 FROM kin_messages m
          WHERE m.org_id = e.org_id AND m.message_id = json_extract(e.json, '$.messageId')
            AND m.chat_id = c.chat_id AND m.author_kind = 'human'
            AND m.author_person_id = ${personId}))
        OR (e.tag = 'chat.reaction' AND json_extract(e.json, '$.provenance._tag') = 'human'
          AND json_extract(e.json, '$.provenance.personId') = ${personId}))
    LIMIT 1`;
  return rows.length > 0;
});

/** In a private turn nobody asked in person: reads, and only into that person's own chat. */
const WOKEN_PRIVATE_TOOLS: ReadonlySet<string> = new Set([
  "records_query",
  "record_get",
  "client_read",
  "pulse_read",
  "people_read",
  "kin_leads",
  "dates_query",
  "deal_stages",
  "money_summary",
  "pipeline_read",
  "docs_search",
  "doc_read",
  "doc_history",
  "memory_search",
  "memory_read",
  "kin_chat_read",
  "kin_chat_post",
  "kin_widget_upsert",
  "kin_ask",
  "kin_ask_close",
  "kin_react",
  "kin_chart",
  "kin_visual",
  "kin_connection_tools",
  "kin_connection_call",
  // A reminder in their own chat, which runs private to them too (`inheritPrivacy`).
  "kin_defer",
  "kin_cancel",
]);
/** Memory is the owner's or the team's: nothing read in someone's own mailbox goes there. */
const MEMORY_WRITES: ReadonlySet<string> = new Set(["memory_write", "memory_label", "kin_journal"]);

export const PRIVATE_WRITE = (name: string) =>
  `This came from ${name}'s own mailbox: put it to them in this chat; they can tell you to add it.`;
export const PRIVATE_MEMORY = (name: string) =>
  `This turn read ${name}'s own mailbox, so nothing is saved to memory in it: put it to them in this chat.`;

/**
 * Why a private turn may not call `tool`, or undefined. Every turn: no memory. A turn nobody
 * asked in person (a draft wake, a reminder, another agent): only `WOKEN_PRIVATE_TOOLS`. One the
 * person started themself writes where they may, as any turn of theirs.
 */
export const privateRefusal = Effect.fn("KinPrivateTurn.refusal")(function* (
  turn: Turn,
  tool: string,
  args: unknown,
) {
  const personId = yield* privateTo(turn);
  if (personId === null) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const [person] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${turn.orgId} AND person_id = ${personId}`;
  const name = person?.name ?? "this person";
  if (MEMORY_WRITES.has(tool)) return PRIVATE_MEMORY(name);
  if (yield* startedBy(turn, personId)) return undefined;
  if (!WOKEN_PRIVATE_TOOLS.has(tool)) return PRIVATE_WRITE(name);
  // A post or card names its chat: only the turn's own, which is theirs.
  const chatId = Predicate.hasProperty(args, "chatId") ? args.chatId : undefined;
  if (chatId !== undefined && chatId !== (yield* turnChat(turn))?.chatId)
    return PRIVATE_WRITE(name);
  return undefined;
});

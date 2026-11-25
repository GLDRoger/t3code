import { KinAgentId, KinPersonId, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { aborted, CHAT_ANSWER_TAGS, effectiveAudience, peopleBehind } from "../lead/Audience.ts";
import { directKey } from "../lead/LeadAccess.ts";
import { liveConnections, personConnections, type ConnectionRow } from "./ConnectionRows.ts";

type Turn = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
};

/**
 * The one person a turn is for, when it may use their own mailbox: everyone who reads or asked
 * is that one person, and every chat it answers or was asked from is their own direct chat with
 * this agent. A turn that gains a reader loses it at the next call; an aborted turn has none.
 * An owner-level person's turn must also be owner-only, as their company mailbox needs.
 */
export const mailboxPerson = Effect.fn("KinConnections.mailboxPerson")(function* (turn: Turn) {
  if (yield* aborted(turn)) return null;
  const behind = yield* peopleBehind(turn);
  if (behind === undefined) return null;
  const people = [...new Set([...behind.readers, ...behind.askers])];
  if (people.length !== 1) return null;
  const person = KinPersonId.make(people[0]!);
  if (behind.level.has(person) && (yield* effectiveAudience(turn)) !== "owner_only") return null;
  const sql = yield* SqlClient.SqlClient;
  const chats = yield* sql<{ chatId: string }>`SELECT DISTINCT chat_id AS "chatId" FROM (
      SELECT CASE WHEN tag IN ${sql.in(CHAT_ANSWER_TAGS)} THEN json_extract(json, '$.chatId') END
        AS chat_id FROM kin_events
      WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId} AND wakeup_id = ${turn.wakeupId}
      UNION ALL SELECT json_extract(json, '$.origin.chatId') FROM kin_events
      WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId} AND wakeup_id = ${turn.wakeupId}
      UNION ALL SELECT owner_chat_id FROM kin_leads
      WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId} AND NOT EXISTS (
        SELECT 1 FROM kin_events WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId}
          AND wakeup_id = ${turn.wakeupId} AND tag IN ${sql.in(CHAT_ANSWER_TAGS)}
          AND json_extract(json, '$.chatId') IS NOT NULL))
    WHERE chat_id IS NOT NULL ORDER BY chat_id`;
  if (chats.length !== 1) return null;
  const own = yield* sql`SELECT 1 FROM kin_chats WHERE org_id = ${turn.orgId}
    AND chat_id = ${chats[0]!.chatId} AND kind = 'direct' AND archived_at IS NULL
    AND direct_key = ${directKey(person, turn.agentId)} LIMIT 1`;
  return own.length === 1 ? person : null;
});

/**
 * Which connections a turn may use, by stored rows alone; every connection tool goes through it.
 * The company's only in a turn the owner level alone reads (`effectiveAudience`); a person's own
 * mailbox only in a turn that is theirs alone (`mailboxPerson`). Theirs come first.
 */
export const turnMailboxes = Effect.fn("KinConnections.turnMailboxes")(function* (turn: Turn) {
  const company = (yield* effectiveAudience(turn)) === "owner_only";
  const person = yield* mailboxPerson(turn);
  const own: ReadonlyArray<ConnectionRow> =
    person === null ? [] : yield* personConnections(turn.orgId, person);
  const rows: ReadonlyArray<ConnectionRow> = [
    ...own,
    ...(company ? yield* liveConnections(turn.orgId) : []),
  ];
  // `alone`: the turn is one person's, mailbox or not; `person`: theirs is connected.
  return { company, person: own.length === 0 ? null : person, alone: person, rows };
});

/** Whether `chatId` is `personId`'s own direct chat with `agentId`: where their mail card may go. */
export const ownDirectChat = Effect.fn("KinConnections.ownDirectChat")(function* (
  orgId: KinOrgId,
  chatId: string,
  personId: string,
  agentId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_chats WHERE org_id = ${orgId} AND chat_id = ${chatId}
    AND kind = 'direct' AND archived_at IS NULL
    AND direct_key = ${directKey(KinPersonId.make(personId), KinAgentId.make(agentId))} LIMIT 1`;
  return rows.length === 1;
});

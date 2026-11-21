import {
  KinPersonAccess,
  kinOwnerLevel,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";

// The one owner-level rule: `kin_people.access` is owner or co_owner; a row with none set yet is
// the owner when it owns a lead, as before kinds were stored. Read per request; no agent writes it.

/** SQL over a trusted row alias, for `sql.literal`: the row's kind, unset read as above. */
export const accessSql = (p: string) =>
  `COALESCE(${p}.access, CASE WHEN EXISTS (SELECT 1 FROM kin_leads al
    JOIN kin_agents aa ON aa.org_id = al.org_id AND aa.agent_id = al.agent_id
    WHERE al.org_id = ${p}.org_id AND aa.owner_person_id = ${p}.person_id) THEN 'owner'
    ELSE 'member' END)`;

/** SQL over trusted column names, for `sql.literal`: `person` is an owner-level person of `org`. */
export const ownerLevelSql = (org: string, person: string) =>
  `EXISTS (SELECT 1 FROM kin_people ol WHERE ol.org_id = ${org} AND ol.person_id = ${person}
    AND ${accessSql("ol")} IN ('owner', 'co_owner'))`;

const decodeAccess = Schema.decodeUnknownOption(KinPersonAccess);

export const accessOf = Effect.fn("KinAccess.accessOf")(
  function* (orgId: KinOrgId, personId: KinPersonId) {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ access: string }>`SELECT ${sql.literal(accessSql("p"))} AS access
      FROM kin_people p WHERE p.org_id = ${orgId} AND p.person_id = ${personId}
      ORDER BY p.person_id`;
    return row === undefined ? undefined : Option.getOrUndefined(decodeAccess(row.access));
  },
  Effect.mapError(toPersistenceSqlError("KinAccess.accessOf")),
);

export const ownerLevel = Effect.fn("KinAccess.ownerLevel")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  return kinOwnerLevel(yield* accessOf(orgId, personId));
});

/**
 * Whether an owner-level person asked this agent's turn in person: every event that woke it is
 * a message or a card tap by someone owner-level now, none passed on by another agent. A reaction,
 * a record change, a brief, a routine, a handoff or a teammate's word among them is no ask. Only
 * this makes what an agent writes kept (`KinRecords`); `askedBy` keeps naming who asked.
 */
export const ownerLevelAsked = Effect.fn("KinAccess.ownerLevelAsked")(function* (
  orgId: KinOrgId,
  agentId: string,
  wakeupId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ direct: number }>`SELECT COALESCE(
      e.tag IN ('chat.message', 'widget.action') AND json_extract(e.json, '$.origin') IS NULL
        AND m.author_kind = 'human' AND m.chat_id = json_extract(e.json, '$.chatId')
        AND ${sql.literal(ownerLevelSql("m.org_id", "m.author_person_id"))}, 0) AS direct
    FROM kin_events e
    LEFT JOIN kin_messages m ON m.org_id = e.org_id AND e.tag IN ('chat.message', 'widget.action')
      AND m.message_id = json_extract(e.json, '$.messageId')
      AND (m.kind = 'widget_action') = (e.tag = 'widget.action')
    WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND e.wakeup_id = ${wakeupId}
    ORDER BY e.event_id`;
  return rows.length > 0 && rows.every((row) => row.direct === 1);
});

/**
 * Whether this turn is the one the agent's owner's Approve on a sent-up draft queued
 * (`approveDraft`), and only that, read off its question: what it creates starts kept, as on his
 * ask in person. It keeps nothing that already exists (`KinRecords.mayKeep` stays his ask's).
 */
export const approvedDraftTurn = Effect.fn("KinAccess.approvedDraftTurn")(function* (
  orgId: KinOrgId,
  agentId: string,
  wakeupId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ approved: number }>`SELECT (e.tag = 'deferral.due'
      AND json_extract(e.json, '$.subject.approved') = 1
      AND json_extract(e.json, '$.origin') IS NULL AND json_extract(e.json, '$.chatId') IS NULL
      AND EXISTS (SELECT 1 FROM kin_questions q
        JOIN kin_agents a ON a.org_id = q.org_id AND a.agent_id = q.agent_id
        WHERE q.org_id = e.org_id AND q.agent_id = e.agent_id
          AND q.question_id = json_extract(e.json, '$.subject.questionId')
          AND q.draft_json IS NOT NULL AND q.approved_at IS NOT NULL
          AND q.person_id = a.owner_person_id
          AND ${sql.literal(ownerLevelSql("q.org_id", "q.person_id"))})) AS approved
    FROM kin_events e
    WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND e.wakeup_id = ${wakeupId}
    ORDER BY e.event_id`;
  return rows.length > 0 && rows.every((row) => row.approved === 1);
});

/** The org's owner-level people. */
export const ownerLevelPeople = Effect.fn("KinAccess.ownerLevelPeople")(function* (
  orgId: KinOrgId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ personId: string }>`SELECT p.person_id AS "personId"
    FROM kin_people p WHERE p.org_id = ${orgId}
      AND ${sql.literal(ownerLevelSql("p.org_id", "p.person_id"))}
    ORDER BY p.person_id`;
  return new Set(rows.map((row) => row.personId));
});

/** May act as owner here: the owner himself or anyone owner-level. Authority checks ask this. */
export const mayActAsOwner = Effect.fn("KinAccess.mayActAsOwner")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  owner: { readonly personId: string },
) {
  return isOwnerHimself(owner, personId) || (yield* ownerLevel(orgId, personId));
});

/**
 * The owner himself, never a co-owner. Only for what is his alone: his private chats and own
 * leads, statement notices, and managing co-owners.
 */
export const isOwnerHimself = (
  owner: { readonly personId: string },
  personId: string | null | undefined,
) => owner.personId === personId;

/** Whether this person owns this agent (`kin_agents.owner_person_id`). */
export const ownsAgent = (
  agent: { readonly ownerPersonId: string },
  personId: string | null | undefined,
) => agent.ownerPersonId === personId;

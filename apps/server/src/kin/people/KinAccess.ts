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
 * Whether an owner-level person asked this turn in person: every event that woke it is their own
 * message or card tap, passed on by no agent, or their own act on a task (`OWN_TASK_ACT`). Only
 * this makes what an agent writes kept (`KinRecords`); `askedBy` keeps naming who asked.
 */
export const ownerLevelAsked = Effect.fn("KinAccess.ownerLevelAsked")(function* (
  orgId: KinOrgId,
  agentId: string,
  wakeupId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ direct: number }>`SELECT COALESCE(
      (e.tag IN ('chat.message', 'widget.action') AND json_extract(e.json, '$.origin') IS NULL
        AND m.author_kind = 'human' AND m.chat_id = json_extract(e.json, '$.chatId')
        -- Kin's copy of group words (KinHandoff.takePrivate) was asked among others, not here.
        AND COALESCE(m.client_message_id, '') NOT LIKE 'send:private:%'
        AND ${sql.literal(ownerLevelSql("m.org_id", "m.author_person_id"))})
      OR (e.tag = 'record.changed' AND ${sql.literal(OWN_TASK_ACT)}), 0) AS direct
    FROM kin_events e
    JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
    LEFT JOIN kin_messages m ON m.org_id = e.org_id AND e.tag IN ('chat.message', 'widget.action')
      AND m.message_id = json_extract(e.json, '$.messageId')
      AND (m.kind = 'widget_action') = (e.tag = 'widget.action')
    WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND e.wakeup_id = ${wakeupId}
    ORDER BY e.event_id`;
  return rows.length > 0 && rows.every((row) => row.direct === 1);
});

/**
 * Who may ask in person through a task event `e` of agent `a`: anyone owner-level, as their chat
 * message does. Only the agent's own owner's event comes with no origin chat.
 */
const TASK_ASKER = ownerLevelSql("e.org_id", "json_extract(e.json, '$.provenance.personId')");
/**
 * A task event that is its giver's own words to this agent, by their own hand (never a coding
 * agent's): their comment on it, or their giving it, when they wrote it and every change to its
 * title and notes up to then was theirs too. From another chat, only their own direct chat with it.
 */
const OWN_TASK_ACT = `json_extract(e.json, '$.provenance._tag') = 'human' AND ${TASK_ASKER}
  AND ((json_extract(e.json, '$.origin') IS NULL
      AND json_extract(e.json, '$.provenance.personId') = a.owner_person_id) OR (
    json_extract(e.json, '$.origin.personId') = json_extract(e.json, '$.provenance.personId')
    AND EXISTS (SELECT 1 FROM kin_chats oc WHERE oc.org_id = e.org_id
      AND oc.chat_id = json_extract(e.json, '$.origin.chatId') AND oc.kind = 'direct'
      AND oc.archived_at IS NULL
      AND oc.direct_key = json_extract(e.json, '$.provenance.personId') || ':' || e.agent_id)))
  AND CASE json_extract(e.json, '$.reason')
    WHEN 'commented' THEN EXISTS (SELECT 1 FROM kin_record_comments oc
      WHERE oc.org_id = e.org_id AND oc.record_id = json_extract(e.json, '$.recordId')
        AND oc.seq = json_extract(e.json, '$.seq') AND oc.author_kind = 'person'
        AND oc.author_id = json_extract(e.json, '$.provenance.personId')
        AND oc.coding_agent_key IS NULL AND oc.removed_at IS NULL)
    WHEN 'assigned' THEN EXISTS (SELECT 1 FROM kin_records orr, kin_record_changes og
      WHERE orr.org_id = e.org_id AND orr.record_id = json_extract(e.json, '$.recordId')
        AND orr.created_by_kind = 'person'
        AND orr.created_by_id = json_extract(e.json, '$.provenance.personId')
        AND og.org_id = orr.org_id AND og.record_id = orr.record_id
        AND og.seq = json_extract(e.json, '$.seq') AND og.actor_kind = 'person'
        AND og.actor_id = orr.created_by_id AND og.coding_agent_key IS NULL
        AND EXISTS (SELECT 1 FROM json_each(og.fields_json) f
          WHERE json_extract(f.value, '$.field') = 'owner'
            AND json_extract(f.value, '$.to') = 'agent:' || e.agent_id)
        AND NOT EXISTS (SELECT 1 FROM kin_record_changes ow, json_each(ow.fields_json) wf
          WHERE ow.org_id = orr.org_id AND ow.record_id = orr.record_id AND ow.seq <= og.seq
            AND json_extract(wf.value, '$.field') IN ('title', 'notes')
            AND (ow.actor_kind <> 'person' OR ow.actor_id IS NOT orr.created_by_id
              OR ow.coding_agent_key IS NOT NULL)))
    ELSE 0 END`;

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

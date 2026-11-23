import { KIN_DISMISSED_FIELD } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Who dismissed the question that released this task, while that question stays dismissed and
 * they have not written to the task since; undefined when nothing holds it.
 */
export const dismissedHold = Effect.fn("KinDismissedHold.of")(function* (
  orgId: string,
  recordId: string,
  personId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [held] = yield* sql<{ name: string }>`SELECT COALESCE(p.display_name, p.handle) AS name
    FROM kin_record_changes c
    JOIN json_each(c.fields_json) f
      ON json_extract(f.value, '$.field') = ${KIN_DISMISSED_FIELD}
    JOIN kin_questions q ON q.org_id = c.org_id AND q.question_id = json_extract(f.value, '$.to')
      AND q.state = 'dismissed' AND q.person_id = ${personId}
    LEFT JOIN kin_people p ON p.org_id = c.org_id AND p.person_id = q.person_id
    WHERE c.org_id = ${orgId} AND c.record_id = ${recordId}
      AND NOT EXISTS (SELECT 1 FROM kin_record_changes later
        WHERE later.org_id = c.org_id AND later.record_id = c.record_id AND later.seq > c.seq
          AND later.actor_kind = 'person' AND later.actor_id = ${personId})
    ORDER BY c.seq DESC LIMIT 1`;
  return held?.name;
});

/**
 * Whether a person's own chat message or card tap is among the events that woke this turn:
 * `personId`'s, or with none given, anyone's.
 */
export const personInTurn = Effect.fn("KinDismissedHold.personInTurn")(function* (
  orgId: string,
  agentId: string,
  wakeupId: string,
  personId?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_events e
    JOIN kin_messages m ON m.org_id = e.org_id AND m.message_id = json_extract(e.json, '$.messageId')
    WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND e.wakeup_id = ${wakeupId}
      AND e.tag IN ('chat.message', 'widget.action')
      AND m.author_kind = 'human' AND m.author_person_id IS NOT NULL
      ${personId === undefined ? sql`` : sql`AND m.author_person_id = ${personId}`}
    LIMIT 1`;
  return rows.length > 0;
});

/**
 * Whether a person's own words woke this turn: their message or card tap in the chat the event
 * names, not an agent-made event (`$.origin`) and not Kin's copy of group words taken private.
 */
export const personSpokeInTurn = Effect.fn("KinDismissedHold.personSpokeInTurn")(function* (
  orgId: string,
  agentId: string,
  wakeupId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_events e
    JOIN kin_messages m ON m.org_id = e.org_id AND m.message_id = json_extract(e.json, '$.messageId')
      AND m.chat_id = json_extract(e.json, '$.chatId')
      AND (m.kind = 'widget_action') = (e.tag = 'widget.action')
    WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND e.wakeup_id = ${wakeupId}
      AND e.tag IN ('chat.message', 'widget.action') AND json_extract(e.json, '$.origin') IS NULL
      AND m.author_kind = 'human' AND m.author_person_id IS NOT NULL
      AND COALESCE(m.client_message_id, '') NOT LIKE 'send:private:%'
    LIMIT 1`;
  return rows.length > 0;
});

/** What an agent hears when it puts a task a dismissal released back to waiting on that person. */
export const dismissedHoldText = (name: string, key: string) =>
  `${name} dismissed that question, so ${key} does not wait on them. Leave it open with you, or say what it needs in one comment.`;

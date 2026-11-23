import {
  KinAgentId,
  KinCardAsker,
  KinChatId,
  KinLeadTracking,
  type KinOrgId,
  KinRecordKey,
  KinRecordState,
  MemoryItemEvery,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";

const TrackedRow = Schema.Struct({
  kind: KinLeadTracking.fields.kind,
  title: Schema.String,
  dueAt: Schema.NullOr(Schema.Number),
  chatId: Schema.NullOr(KinChatId),
  agentId: Schema.NullOr(KinAgentId),
  key: Schema.NullOr(KinRecordKey),
  state: Schema.NullOr(KinRecordState),
  dueAllDay: Schema.Number,
  waitingOnKind: Schema.NullOr(Schema.Literals(["person", "agent"])),
  waitingOnId: Schema.NullOr(Schema.String),
  anchorSeq: Schema.NullOr(Schema.Number),
  itemId: Schema.NullOr(Schema.String),
  /** A room's own card's `askedBy` and a routine card's `every`, as stored JSON. */
  askedBy: Schema.NullOr(Schema.String),
  every: Schema.NullOr(Schema.String),
});
const decodeTracked = Schema.decodeUnknownEffect(Schema.Array(TrackedRow));

/**
 * What each lead has in hand, from stored rows: its open Work, the deferrals still waiting to
 * come due and the scheduled tasks still on. A deferral belongs to its chat's first-joined
 * lead, the one the trigger wakes for it (`orgLeads.liveLead`); a native schedule to its row's.
 */
export const tracked = Effect.fn("KinTracked.tracked")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const firstLead = sql`(SELECT m.agent_id FROM kin_chat_members m
      JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
        AND a.role = 'lead' AND a.retired_at IS NULL
      WHERE m.org_id = w.org_id AND m.chat_id = w.chat_id AND m.principal_kind = 'agent'
        AND m.left_at IS NULL
      ORDER BY m.joined_at, m.agent_id LIMIT 1)`;
  // Its open Work entries, then its alarms.
  const rows = yield* sql`
    SELECT 'work' AS kind, e.title, e.due_at AS "dueAt", e.source_chat_id AS "chatId",
      e.owner_id AS "agentId",
      CASE e.state WHEN 'doing' THEN 0 WHEN 'waiting' THEN 0 ELSE 1 END AS rank,
      COALESCE(e.due_at, e.updated_at) AS at, e.key, e.state, e.due_all_day AS "dueAllDay",
      CASE WHEN e.state = 'waiting' THEN e.waiting_on_kind END AS "waitingOnKind",
      CASE WHEN e.state = 'waiting' THEN e.waiting_on_id END AS "waitingOnId",
      NULL AS "anchorSeq", NULL AS "itemId", NULL AS "askedBy", NULL AS every
    FROM kin_records e WHERE e.org_id = ${orgId} AND e.register_id = 'work'
      AND e.owner_kind = 'agent' AND e.state NOT IN ('done', 'dropped')
    UNION ALL
    SELECT CASE r.on_due WHEN 'remind' THEN 'reminder' ELSE 'follow_up' END,
      COALESCE(json_extract(w.state_json, '$.title'), ''), COALESCE(f.next_run_at, r.due_at),
      w.chat_id, ${firstLead}, 2, COALESCE(f.next_run_at, r.due_at, r.updated_at), NULL, NULL, 0,
      NULL, NULL, (SELECT m.seq FROM kin_messages m WHERE m.org_id = w.org_id AND m.message_id = w.message_id), r.item_id, json_extract(w.state_json, '$.askedBy'), json_extract(w.state_json, '$.every')
    FROM kin_deferral_runs r
    JOIN kin_widgets w ON w.org_id = r.org_id
      AND w.widget_id = 'deferral:' || r.org_id || ':' || r.item_id
    LEFT JOIN kin_triggers f ON f.org_id = r.org_id
      AND f.trigger_id = 'deferral:' || r.item_id || ':due' AND f.enabled = 1
    WHERE r.org_id = ${orgId} AND (r.state = 'asked'
      OR (r.state IN ('armed', 'heads_up', 'grace', 'snoozed') AND f.next_run_at IS NOT NULL))
    UNION ALL
    SELECT 'scheduled', COALESCE(json_extract(w.state_json, '$.title'), ''), NULL, w.chat_id,
      ${firstLead}, 3, t.updated_at, NULL, NULL, 0, NULL, NULL, (SELECT m.seq FROM kin_messages m WHERE m.org_id = w.org_id AND m.message_id = w.message_id), t.item_id, json_extract(w.state_json, '$.askedBy'), json_extract(w.state_json, '$.every')
    FROM kin_scheduled_tasks t
    JOIN kin_widgets w ON w.org_id = t.org_id
      AND w.widget_id = 'scheduled:' || t.org_id || ':' || t.item_id
    JOIN kin_triggers f ON f.org_id = t.org_id
      AND f.trigger_id = 'schedule:' || t.item_id AND f.enabled = 1 AND f.next_run_at IS NOT NULL
    WHERE t.org_id = ${orgId} AND t.state = 'active' AND t.paused = 0
    UNION ALL
    SELECT 'scheduled', n.title, NULL, COALESCE(w.chat_id, s.chat_id), s.agent_id, 3, s.updated_at,
      NULL, NULL, 0, NULL, NULL, (SELECT m.seq FROM kin_messages m WHERE m.org_id = w.org_id AND m.message_id = w.message_id), s.schedule_id, json_extract(w.state_json, '$.askedBy'), json_extract(w.state_json, '$.every')
    FROM kin_schedules s
    JOIN scheduled_tasks n ON n.task_id = s.task_id AND n.enabled = 1
    LEFT JOIN kin_widgets w ON w.org_id = s.org_id
      AND w.widget_id = 'scheduled:' || s.org_id || ':' || s.schedule_id
    WHERE s.org_id = ${orgId} AND s.deleted_at IS NULL AND COALESCE(s.pending_enabled, 1) = 1
    ORDER BY rank, at, title`.pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.tracked")),
  );
  return yield* decodeTracked(rows).pipe(
    Effect.mapError(toPersistenceDecodeError("KinLeadProvision.tracked")),
  );
});

const decodeAsker = Schema.decodeUnknownOption(Schema.fromJsonString(KinCardAsker));
const decodeEvery = Schema.decodeUnknownOption(Schema.fromJsonString(MemoryItemEvery));
type SetInChat =
  | {
      readonly kind: "reminder";
      readonly itemId: string;
      readonly title: string;
      readonly dueAt: number;
      readonly asker: KinCardAsker;
    }
  | {
      readonly kind: "routine";
      readonly itemId: string;
      readonly title: string;
      readonly every: MemoryItemEvery;
      readonly asker: KinCardAsker;
    };

/**
 * A shared chat's own live reminders and routines, in due order, reminders first: the same list
 * the leads' tracking reads (`tracked`), kept to this chat. A title is the card's, which is
 * blank while someone there now couldn't read where it was set (`wordsReadable`).
 */
export const setInChat = Effect.fn("KinTracked.setInChat")(function* (
  orgId: KinOrgId,
  chatId: string,
) {
  return (yield* tracked(orgId)).flatMap((item): ReadonlyArray<SetInChat> => {
    if (item.chatId !== chatId || item.itemId === null || item.askedBy === null) return [];
    const asker = Option.getOrUndefined(decodeAsker(item.askedBy));
    if (asker === undefined) return [];
    if (item.kind === "reminder" && item.dueAt !== null)
      return [
        {
          kind: "reminder" as const,
          itemId: item.itemId,
          title: item.title,
          dueAt: item.dueAt,
          asker,
        },
      ];
    const every = item.every === null ? undefined : Option.getOrUndefined(decodeEvery(item.every));
    if (item.kind === "scheduled" && every !== undefined)
      return [{ kind: "routine" as const, itemId: item.itemId, title: item.title, every, asker }];
    return [];
  });
});

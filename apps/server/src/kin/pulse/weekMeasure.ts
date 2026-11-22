import { type KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { CHANGES_FIRST } from "../questions/approval.ts";
import { turnAsked } from "../reply/replyLane.ts";
import { dayIn } from "../work/money.ts";
import { ownerZone, startOfDay } from "../work/recordRows.ts";

const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

export const lastCompleteWeek = Effect.fn("KinWeekMeasure.window")(function* (
  orgId: KinOrgId,
  now: number,
) {
  const zone = yield* ownerZone(orgId);
  const today = DateTime.makeUnsafe(dayIn(now, zone));
  const weekday = DateTime.toPartsUtc(today).weekDay;
  const monday = DateTime.subtract(today, { days: (weekday + 6) % 7 });
  return {
    from: startOfDay(DateTime.formatIsoDate(DateTime.subtract(monday, { days: 7 })), zone),
    until: startOfDay(DateTime.formatIsoDate(monday), zone),
    zone,
  };
});

interface TurnCounts {
  readonly unasked: number;
  readonly withCard: number;
  readonly acted: number;
  readonly changed: number;
  readonly dismissed: number;
  readonly left: number;
  readonly asked: number;
}

/** Counts from retained rows only, with both turn starts and commitment due dates in [from, until). */
export const weekMeasure = Effect.fn("KinWeekMeasure.read")(function* (input: {
  readonly orgId: KinOrgId;
  readonly from: number;
  readonly until: number;
  readonly zone: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, from, until, zone } = input;
  const before = iso(until);
  const turnsAndCards = sql`WITH turns AS (
      SELECT w.*, ${turnAsked(sql, "w")} AS asked,
        strftime('%Y-%m-%dT%H:%M:%fZ', w.started_at / 1000.0, 'unixepoch') AS started_iso,
        strftime('%Y-%m-%dT%H:%M:%fZ', w.ended_at / 1000.0, 'unixepoch') AS ended_iso
      FROM kin_wakeups w WHERE w.org_id = ${orgId} AND w.started_at >= ${from}
        AND w.started_at < ${until}
        AND EXISTS (SELECT 1 FROM kin_events e WHERE e.org_id = w.org_id
          AND e.agent_id = w.agent_id AND e.wakeup_id = w.wakeup_id)
    ), posts AS (
      SELECT DISTINCT w.org_id, w.wakeup_id, m.chat_id, m.message_id, m.seq
      FROM turns w JOIN kin_messages m ON m.org_id = w.org_id AND m.author_agent_id = w.agent_id
        AND m.author_thread_id = w.thread_id
      LEFT JOIN kin_widgets send ON send.org_id = m.org_id AND send.chat_id = m.chat_id
        AND send.message_id = m.message_id AND send.type = 'choice'
        AND json_extract(send.state_json, '$.send') IS NOT NULL
      LEFT JOIN kin_connection_asks k ON k.org_id = send.org_id AND k.chat_id = send.chat_id
        AND k.widget_id = send.widget_id
      WHERE (COALESCE(k.wakeup_id, m.source_wakeup_id) = w.wakeup_id OR (k.wakeup_id IS NULL AND m.source_wakeup_id IS NULL
          AND m.created_at >= w.started_iso AND m.created_at < COALESCE(w.ended_iso, ${before})))
        AND m.author_kind = 'agent' AND m.status = 'posted' AND m.created_at < ${before}
        AND EXISTS (SELECT 1 FROM kin_chat_members p WHERE p.org_id = m.org_id
          AND p.chat_id = m.chat_id AND p.principal_kind = 'person'
          AND p.joined_at <= m.created_at AND (p.left_at IS NULL OR p.left_at > m.created_at))
    ), choices AS (
      SELECT p.wakeup_id, p.chat_id, p.seq,
        json_extract(g.state_json, '$.answer.answeredAt') AS answered,
        CASE WHEN json_extract(g.state_json, '$.send.edited') IS NOT NULL THEN
          COALESCE(json_extract(g.state_json, '$.answer.answeredAt'), g.updated_at)
          WHEN q.draft_json IS NOT NULL AND (q.answer = ${CHANGES_FIRST}
            OR json_extract(q.draft_json, '$.redo') = 1)
            THEN json_extract(g.state_json, '$.answer.answeredAt') END AS changed,
        COALESCE((SELECT MAX(i.resolved_at) FROM kin_waiting i
            WHERE i.org_id = g.org_id AND i.chat_id = g.chat_id AND i.widget_id = g.widget_id
              AND i.resolution = 'dismissed' AND i.resolved_at < ${before}
              AND NOT EXISTS (SELECT 1 FROM kin_waiting reopened WHERE reopened.org_id = i.org_id
                AND reopened.chat_id = i.chat_id AND reopened.widget_id = i.widget_id
                AND reopened.created_at > i.resolved_at AND reopened.created_at < ${before})),
          CASE WHEN json_extract(o.value, '$.kind') = 'no' AND
            (q.draft_json IS NOT NULL OR json_extract(g.state_json, '$.send') IS NOT NULL)
            THEN json_extract(g.state_json, '$.answer.answeredAt') END) AS dismissed
      FROM posts p JOIN kin_widgets g ON g.org_id = p.org_id AND g.chat_id = p.chat_id
        AND g.message_id = p.message_id AND g.type = 'choice'
      LEFT JOIN kin_questions q ON q.org_id = g.org_id AND q.widget_id = g.widget_id
      LEFT JOIN json_each(g.state_json, '$.options') o
        ON json_extract(o.value, '$.optionId') = json_extract(g.state_json, '$.answer.optionId')
      WHERE json_array_length(g.state_json, '$.options') >= 2
        AND EXISTS (SELECT 1 FROM kin_waiting i WHERE i.org_id = g.org_id AND i.chat_id = g.chat_id
          AND i.widget_id = g.widget_id AND i.created_at < ${before})
    ), approvals AS (
      SELECT w.wakeup_id, m.chat_id, m.seq,
        (SELECT MIN(strftime('%Y-%m-%dT%H:%M:%fZ', k.accepted_at / 1000.0, 'unixepoch'))
          FROM kin_grants k WHERE k.org_id = a.org_id AND k.action_id = a.action_id) AS answered,
        NULL AS changed,
        CASE WHEN a.state = 'rejected' THEN
          strftime('%Y-%m-%dT%H:%M:%fZ', a.updated_at / 1000.0, 'unixepoch') END AS dismissed
      FROM turns w JOIN kin_pending_actions a ON a.org_id = w.org_id
        AND a.requested_by_agent_id = w.agent_id AND a.requested_by_thread_id = w.thread_id
        AND a.created_at >= w.started_at AND a.created_at < COALESCE(w.ended_at, ${until})
      JOIN kin_widgets g ON g.org_id = a.org_id AND g.type = 'approval'
        AND json_extract(g.state_json, '$.actionId') = a.action_id
      JOIN kin_messages m ON m.org_id = g.org_id AND m.chat_id = g.chat_id
        AND m.message_id = g.message_id AND m.status = 'posted' AND m.created_at < ${before}
      WHERE EXISTS (SELECT 1 FROM kin_waiting i WHERE i.org_id = g.org_id AND i.chat_id = g.chat_id
        AND i.widget_id = g.widget_id AND i.reason = 'approval' AND i.created_at < ${before})
    ), cards AS (
      SELECT * FROM choices UNION ALL SELECT * FROM approvals
    )`;

  const [totals] = yield* sql<TurnCounts>`${turnsAndCards}, outcomes AS (
      SELECT wakeup_id, CASE
        WHEN MAX(COALESCE(answered < ${before} AND (dismissed IS NULL OR dismissed >= ${before})
          AND (changed IS NULL OR changed > answered), 0)) = 1 THEN 'acted'
        WHEN MAX(COALESCE(answered < ${before} AND (dismissed IS NULL OR dismissed >= ${before})
          AND changed <= answered, 0)) = 1 THEN 'changed'
        WHEN MIN(COALESCE(dismissed < ${before}, 0)) = 1 THEN 'dismissed'
        ELSE 'left' END AS outcome
      FROM cards GROUP BY wakeup_id
    )
    SELECT COUNT(*) FILTER (WHERE w.asked = 0 AND (o.outcome IS NOT NULL OR EXISTS
        (SELECT 1 FROM posts p WHERE p.wakeup_id = w.wakeup_id))) AS unasked,
      COUNT(*) FILTER (WHERE w.asked = 0 AND o.outcome IS NOT NULL) AS "withCard",
      COUNT(*) FILTER (WHERE w.asked = 0 AND o.outcome = 'acted') AS acted,
      COUNT(*) FILTER (WHERE w.asked = 0 AND o.outcome = 'changed') AS changed,
      COUNT(*) FILTER (WHERE w.asked = 0 AND o.outcome = 'dismissed') AS dismissed,
      COUNT(*) FILTER (WHERE w.asked = 0 AND o.outcome = 'left') AS "left",
      COUNT(*) FILTER (WHERE w.asked = 1) AS asked
    FROM turns w LEFT JOIN outcomes o ON o.wakeup_id = w.wakeup_id`;
  const corrections =
    (totals?.asked ?? 0) === 0
      ? []
      : yield* sql<{
          wakeupId: string;
          askedAt: string;
          nextAt: string;
        }>`${turnsAndCards}, next_words AS (
      SELECT w.wakeup_id, m.chat_id, m.seq, m.created_at, (
        SELECT n.message_id FROM kin_messages n WHERE n.org_id = m.org_id AND n.chat_id = m.chat_id
          AND n.author_kind = 'human' AND n.author_person_id = m.author_person_id
          AND n.seq > m.seq AND n.kind = 'text' AND n.status = 'posted' AND n.created_at < ${before}
        ORDER BY n.seq LIMIT 1
      ) AS next_id
      FROM turns w JOIN kin_events e ON e.org_id = w.org_id AND e.agent_id = w.agent_id
        AND e.wakeup_id = w.wakeup_id AND e.tag = 'chat.message'
      JOIN kin_messages m ON m.org_id = e.org_id AND m.message_id = json_extract(e.json, '$.messageId')
        AND m.chat_id = json_extract(e.json, '$.chatId') AND m.author_kind = 'human'
        AND m.kind = 'text' AND m.status = 'posted'
      WHERE w.asked = 1
    )
    SELECT DISTINCT x.wakeup_id AS "wakeupId", x.created_at AS "askedAt", n.created_at AS "nextAt"
    FROM next_words x JOIN kin_messages n ON n.org_id = ${orgId} AND n.message_id = x.next_id
      AND n.chat_id = x.chat_id
    JOIN cards c ON c.wakeup_id = x.wakeup_id AND c.chat_id = x.chat_id AND c.seq > x.seq
      AND c.seq < n.seq AND (c.changed <= n.created_at OR c.dismissed <= n.created_at)
    ORDER BY "wakeupId", "askedAt", "nextAt"`;
  const askedCorrected = new Set(
    corrections
      .filter((row) => dayIn(Date.parse(row.askedAt), zone) === dayIn(Date.parse(row.nextAt), zone))
      .map((row) => row.wakeupId),
  ).size;

  const [promises] = yield* sql<{
    due: number;
    kept: number;
    late: number;
    missed: number;
  }>`WITH commitments AS (
      SELECT latest_by AS due, CASE WHEN state = 'closed' THEN closed_at END AS done
      FROM kin_watches WHERE org_id = ${orgId} AND source = 'promise'
        AND latest_by >= ${from} AND latest_by < ${until}
        AND (state <> 'stopped' OR closed_at >= latest_by)
      UNION ALL
      SELECT r.due_at AS due, CASE
          WHEN r.on_due = 'start' AND r.state = 'started' THEN r.updated_at
          WHEN r.on_due = 'remind' THEN CAST(ROUND(unixepoch(m.created_at, 'subsec') * 1000) AS INTEGER)
          WHEN r.on_due = 'chase' AND r.state = 'chased' THEN (SELECT MIN(p.pinged_at)
            FROM kin_ping_ledger p WHERE p.org_id = r.org_id AND p.item_id = r.item_id
              AND p.pinged_at >= r.updated_at)
        END AS done
      FROM kin_deferral_runs r
      LEFT JOIN kin_widgets g ON g.org_id = r.org_id
        AND g.widget_id = 'reminder:' || r.org_id || ':' || r.item_id || ':' || r.due_at
      LEFT JOIN kin_messages m ON m.org_id = g.org_id AND m.chat_id = g.chat_id
        AND m.message_id = g.message_id AND m.status = 'posted'
      WHERE r.org_id = ${orgId} AND r.due_at >= ${from} AND r.due_at < ${until}
        AND r.on_due IN ('start', 'remind', 'chase')
        AND (r.state NOT IN ('disarmed', 'undone') OR r.updated_at >= r.due_at)
    )
    SELECT COUNT(*) AS due, COUNT(*) FILTER (WHERE done <= due) AS kept,
      COUNT(*) FILTER (WHERE done > due AND done < ${until}) AS late,
      COUNT(*) FILTER (WHERE done IS NULL OR done >= ${until}) AS missed
    FROM commitments`;
  return {
    unasked: totals?.unasked ?? 0,
    withCard: totals?.withCard ?? 0,
    acted: totals?.acted ?? 0,
    changed: totals?.changed ?? 0,
    dismissed: totals?.dismissed ?? 0,
    left: totals?.left ?? 0,
    asked: totals?.asked ?? 0,
    askedCorrected,
    due: promises?.due ?? 0,
    kept: promises?.kept ?? 0,
    late: promises?.late ?? 0,
    missed: promises?.missed ?? 0,
  };
});

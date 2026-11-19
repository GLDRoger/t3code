import type { KinAgentId, KinOrgId } from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";

/**
 * The wake-up whose turn one of the `start` runs is, by exact provenance only: the wake-up's own
 * run, a late steer or rescue Kin sent after it, or T3's finished-task notice in the run it took
 * over, each followed back through server-authored continuation links. Never a thread's latest
 * wake-up. `start` selects `run_id, thread_id, ordinal, payload_json`; `where` filters `w`.
 */
export const wakeupOfRuns = (sql: SqlClient.SqlClient, start: Fragment, where: Fragment) =>
  sql<{ orgId: KinOrgId; agentId: KinAgentId; wakeupId: string }>`
    WITH RECURSIVE ancestors(run_id, thread_id, ordinal, payload_json) AS (
      ${start}
      UNION
      SELECT p.run_id, p.thread_id, p.ordinal, p.payload_json
      FROM ancestors child JOIN orchestration_v2_projection_runs p
        ON p.thread_id = child.thread_id
        AND (p.run_id = json_extract(child.payload_json, '$.restartContinuationOfRunId')
          OR p.run_id = json_extract(child.payload_json, '$.usageLimitContinuationOfRunId'))
      -- Continuation links plus agent/server provenance come only from the restart and usage-limit workers.
      JOIN orchestration_v2_projection_messages cm
        ON cm.message_id = json_extract(child.payload_json, '$.userMessageId')
        AND cm.thread_id = child.thread_id AND cm.run_id = child.run_id
        AND json_extract(cm.payload_json, '$.createdBy') = 'agent'
        AND json_extract(cm.payload_json, '$.creationSource') = 'server'
    )
    SELECT w.org_id AS "orgId", w.agent_id AS "agentId", w.wakeup_id AS "wakeupId"
    FROM kin_wakeups w JOIN ancestors root ON root.thread_id = w.thread_id
    JOIN orchestration_v2_projection_messages m
      ON m.message_id = json_extract(root.payload_json, '$.userMessageId')
      AND m.thread_id = root.thread_id AND m.run_id = root.run_id
    WHERE ${where}
      AND json_extract(m.payload_json, '$.creationSource') = 'server'
      AND ((json_extract(m.payload_json, '$.createdBy') = 'system'
      AND ((json_extract(root.payload_json, '$.userMessageId') = 'kin-wakeup-msg:' || w.wakeup_id
        AND root.run_id = COALESCE(w.run_id, (
          SELECT first.run_id FROM orchestration_v2_projection_runs first
          WHERE first.thread_id = w.thread_id
            AND json_extract(first.payload_json, '$.userMessageId') = 'kin-wakeup-msg:' || w.wakeup_id
          ORDER BY first.ordinal LIMIT 1
        )))
        -- A late steer or the rescue turn, sent after this wake-up's own run (KinIdentity).
        OR ((json_extract(root.payload_json, '$.userMessageId') = 'kin-rescue-msg:' || w.wakeup_id
            OR substr(json_extract(root.payload_json, '$.userMessageId'), 1, length(w.wakeup_id) + 15)
              = 'kin-steer-msg:' || w.wakeup_id || ':')
          AND root.ordinal > (SELECT own.ordinal FROM orchestration_v2_projection_runs own
            WHERE own.thread_id = w.thread_id AND own.run_id = w.run_id))))
        -- T3's notice that a delegated task finished, in the run this wake-up took over: only
        -- Kin sets run_id, and only to such a run (TaskWake).
        OR (json_extract(m.payload_json, '$.createdBy') = 'agent' AND root.run_id = w.run_id))
    ORDER BY w.wakeup_id LIMIT 1`;

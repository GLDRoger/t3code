import type { KinAgentId, KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { heldWork } from "./KinBudget.ts";
import { DAY_MS } from "../durations.ts";

/**
 * What a lead started and where it stands now, read from Kin's own rows at turn time, so the
 * lead states the system's record of it instead of its memory of what it meant to do.
 */

export const STARTED_RULE =
  "Where the tasks you started (task is the id task_cancel takes), the requests you passed on, the entries you gave others and anything waiting on the daily limit stand now, as Kin's records have them. Say only what this shows; when something you mention isn't here, check before you say where it stands.";
const TASKS_CAP = 8;
const HANDOFFS_CAP = 5;
const ASSIGNED_CAP = 8;
const SUMMARY_CHARS = 240;

const cut = (text: string) => {
  const chars = Array.from(text.trim().replace(/\s+/g, " "));
  return chars.length <= SUMMARY_CHARS
    ? chars.join("")
    : `${chars.slice(0, SUMMARY_CHARS - 1).join("")}…`;
};
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
// A hand-off's event: queued is not picked up yet, claimed is being worked on.
const HANDOFF_STATE: Record<string, string> = {
  queued: "not picked up yet",
  claimed: "being worked on",
  done: "picked up; their turn on it finished",
  expired: "never picked up",
  failed: "their turn on it failed",
};

export const buildStartedSection = Effect.fn("KinLeadPrompt.started")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId } = input;
  const since = input.now - DAY_MS;
  // Its delegated tasks, as their cards show them: still open, or changed in the last day.
  const tasks = yield* sql<{
    task: string;
    title: string;
    status: string;
    updated: string;
    error: string | null;
    pullRequest: string | null;
  }>`SELECT json_extract(w.state_json, '$.taskId') AS task,
      json_extract(w.state_json, '$.title') AS title,
      json_extract(w.state_json, '$.status') AS status, w.updated_at AS updated,
      json_extract(w.state_json, '$.lastError') AS error,
      json_extract(w.state_json, '$.pullRequests[0].url') AS "pullRequest"
    FROM kin_widgets w
    JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
    WHERE w.org_id = ${orgId} AND w.type = 'task' AND m.author_agent_id = ${agentId}
      AND (w.closed_at IS NULL OR w.updated_at >= ${iso(since)})
    ORDER BY w.updated_at DESC, w.widget_id LIMIT ${TASKS_CAP}`;
  const handoffs = yield* sql<{ to: string; state: string | null; at: number }>`
    SELECT COALESCE(a.display_name, h.to_agent_id) AS "to", e.state AS state, h.created_at AS at
    FROM kin_handoffs h
    LEFT JOIN kin_agents a ON a.org_id = h.org_id AND a.agent_id = h.to_agent_id
    LEFT JOIN kin_events e ON e.org_id = h.org_id AND e.event_id = h.event_id
    WHERE h.org_id = ${orgId} AND h.from_agent_id = ${agentId} AND h.created_at >= ${since}
      -- A teammate's request still on the owner's card, or not passed on, went nowhere.
      AND (h.route_state IS NULL OR h.route_state = 'passed')
    ORDER BY h.created_at DESC, h.message_id LIMIT ${HANDOFFS_CAP}`;
  // Entries this lead made for someone else to do; its own are in the Work section.
  const assigned = yield* sql<{ key: string; title: string; state: string; to: string }>`
    SELECT r.key, r.title, r.state, COALESCE(p.display_name, a.display_name, r.owner_id) AS "to"
    FROM kin_records r
    LEFT JOIN kin_people p ON r.owner_kind = 'person' AND p.person_id = r.owner_id
    LEFT JOIN kin_agents a ON r.owner_kind = 'agent' AND a.org_id = r.org_id
      AND a.agent_id = r.owner_id
    WHERE r.org_id = ${orgId} AND r.created_by_kind = 'agent' AND r.created_by_id = ${agentId}
      AND NOT (r.owner_kind = 'agent' AND r.owner_id = ${agentId})
      AND r.state NOT IN ('done', 'dropped') AND r.sensitive = 0
    ORDER BY r.rev DESC, r.record_id LIMIT ${ASSIGNED_CAP}`;
  const held = yield* heldWork(orgId);
  if (
    tasks.length === 0 &&
    handoffs.length === 0 &&
    assigned.length === 0 &&
    held.agents.length === 0
  )
    return undefined;
  return {
    asOf: iso(input.now),
    tasks: tasks.map(({ error, pullRequest, ...task }) => ({
      ...task,
      ...(error === null ? {} : { error: cut(error) }),
      ...(pullRequest === null ? {} : { pullRequest }),
    })),
    handoffs: handoffs.map((handoff) => ({
      to: handoff.to,
      at: iso(handoff.at),
      state: HANDOFF_STATE[handoff.state ?? ""] ?? "unknown",
    })),
    assignedToOthers: assigned,
    waitingOnDailyLimit: {
      until: held.until,
      agents: held.agents.map(({ agentId: _id, ...agent }) => agent),
    },
  };
});

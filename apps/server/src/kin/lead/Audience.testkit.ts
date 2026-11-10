import type { KinAgentId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A finished wake-up of a lead whose owner alone reads it: a brief in its owner chat. */
export const ownerOnlyWakeup = Effect.fn("test.ownerOnlyWakeup")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const at = "2026-11-08T00:00:00.000Z";
  const { orgId, agentId, wakeupId } = input;
  yield* sql`INSERT OR IGNORE INTO kin_orgs (org_id, name, created_at) VALUES (${orgId}, 'Org', ${at})`;
  yield* sql`INSERT OR IGNORE INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${`${orgId}:owner`}, ${orgId}, 'owner', 'Owner', ${at})`;
  yield* sql`INSERT OR IGNORE INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES (${agentId}, ${orgId}, 'Lead', 'lead', ${`${orgId}:owner`}, ${at})`;
  yield* sql`INSERT OR IGNORE INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
    VALUES (${`${orgId}:owner-chat`}, ${orgId}, 'team_group', 0, ${at})`;
  yield* sql`INSERT OR IGNORE INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES (${agentId}, ${orgId}, 'Lead', 0, '{}', '[]', ${`${orgId}:owner-chat`})`;
  yield* sql`INSERT OR IGNORE INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids)
    VALUES (${wakeupId}, ${orgId}, ${agentId}, 'model', 0, 'completed', '[]')`;
  yield* sql`INSERT OR IGNORE INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id)
    VALUES (${`${wakeupId}:brief`}, ${orgId}, ${agentId}, 'routine', 'P2', '{"_tag":"routine"}', 0, 0, 'done', ${wakeupId})`;
});

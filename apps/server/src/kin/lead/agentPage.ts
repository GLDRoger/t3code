import {
  type KinAgentId,
  type KinAgentPage,
  KinRecordKey,
  type KinOrgId,
  KinTriggerSettings,
  NonNegativeInt,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { liveConnections } from "../connections/ConnectionRows.ts";
import { KIN_DEFAULT_QUIET_HOURS } from "../triggers/quietHours.ts";
import { ownerZone } from "../work/recordRows.ts";
import { type LeadCreator, profileIn, retirable } from "./KinLeadProvision.ts";
import * as LeadAccess from "./LeadAccess.ts";
import { turnModels } from "./leadModels.ts";

const CHARACTER_ORIGIN = "kin-character:";
const CHARACTER_MAX = 20_000;
const PLAYBOOKS_MAX = 20;
const decodeQuiet = Schema.decodeUnknownOption(
  Schema.fromJsonString(KinTriggerSettings.fields.quietHours),
);
const count = (value: number | null | undefined) =>
  NonNegativeInt.make(Math.max(0, Math.round(value ?? 0)));

/**
 * One agent's page for owner-level people: who it is, what it runs on, its character and what it
 * reaches. The caller is checked as for retiring it; anyone else reads it as not found.
 */
export const ownerLevelAgentPage = Effect.fn("KinAgentPage.read")(function* (input: {
  readonly by: LeadCreator;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { lead } = yield* retirable(input);
  const { orgId, agentId } = lead;
  const persistence = toPersistenceSqlError("KinAgentPage.read");
  const runs = yield* turnModels(orgId, lead.models).pipe(Effect.mapError(persistence));
  const [character] = yield* sql<{ key: string; body: string }>`SELECT r.key, v.body
    FROM kin_records r JOIN kin_doc_versions v ON v.org_id = r.org_id AND v.record_id = r.record_id
    WHERE r.org_id = ${orgId} AND r.register_id = 'docs'
      AND r.origin_key = ${`${CHARACTER_ORIGIN}${agentId}`} AND r.state <> 'dropped'
      AND v.version = (SELECT MAX(w.version) FROM kin_doc_versions w
        WHERE w.org_id = v.org_id AND w.record_id = v.record_id)
    ORDER BY r.key`.pipe(Effect.mapError(persistence));
  const zone = yield* ownerZone(orgId);
  const today = DateTime.makeZonedUnsafe(yield* Clock.currentTimeMillis, { timeZone: zone });
  const monthStart = `${DateTime.formatIsoDate(today).slice(0, 7)}-01`;
  const [used] = yield* sql<{ turns: number | null; tokens: number | null }>`
    SELECT COUNT(DISTINCT c.wakeup_id) AS turns, SUM(c.units) AS tokens
    FROM kin_budget_charges c
    JOIN kin_wakeups w ON w.org_id = c.org_id AND w.wakeup_id = c.wakeup_id
    WHERE c.org_id = ${orgId} AND w.agent_id = ${agentId} AND c.day >= ${monthStart}`.pipe(
    Effect.mapError(persistence),
  );
  const [quiet] = yield* sql<{ hours: string }>`SELECT quiet_hours_json AS hours
    FROM kin_trigger_settings WHERE org_id = ${orgId} ORDER BY org_id`.pipe(
    Effect.mapError(persistence),
  );
  const playbooks = yield* sql<{ key: string; title: string }>`SELECT r.key, r.title
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'docs'
      AND r.category = 'playbook' AND r.state <> 'dropped'
    ORDER BY r.created_at, r.key LIMIT ${PLAYBOOKS_MAX}`.pipe(Effect.mapError(persistence));
  const connections = yield* liveConnections(orgId).pipe(Effect.mapError(persistence));
  const team = yield* LeadAccess.teamAgent(orgId).pipe(Effect.mapError(persistence));
  return {
    profile: yield* profileIn(lead),
    models: lead.models,
    runsOn: runs.models,
    modelNote: runs.note,
    character:
      character === undefined
        ? null
        : { key: KinRecordKey.make(character.key), body: character.body.slice(0, CHARACTER_MAX) },
    teamAgent: team === agentId,
    usedThisMonth: { turns: count(used?.turns), tokens: count(used?.tokens) },
    quietHours: Option.getOrElse(decodeQuiet(quiet?.hours), () => KIN_DEFAULT_QUIET_HOURS),
    connections: connections.map((row) => ({
      label: row.label,
      account: row.accountLabel,
      paused: row.pausedAt !== null,
    })),
    playbooks: playbooks.map((row) => ({ key: KinRecordKey.make(row.key), title: row.title })),
  } satisfies KinAgentPage;
});

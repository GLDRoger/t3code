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
import { playbookForSeat } from "../work/playbookSeeds.ts";
import { ownerZone } from "../work/recordRows.ts";
import { type LeadCreator, profileIn, retirable } from "./KinLeadProvision.ts";
import * as LeadAccess from "./LeadAccess.ts";
import { turnModel } from "./leadModels.ts";
import { kinPartFor, setCharacter, wholeCharacter } from "./characters.ts";
import { companyMoney } from "../work/companyProfile.ts";
import { agentChanges, ownerLevelUndoAgentChange } from "./agentChanges.ts";
import { KIN_OWNER_LEVEL } from "../work/teamView.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";

const CHARACTER_ORIGIN = "kin-character:";
const CHARACTER_MAX = 20_000;
const PLAYBOOKS_MAX = 20;
// Read past the shown 20, so a company's many playbooks still leave this agent's own.
const PLAYBOOKS_READ_MAX = 200;
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
  const runs = yield* turnModel(orgId, lead.model).pipe(Effect.mapError(persistence));
  const [character] = yield* sql<{ key: string; body: string }>`SELECT r.key, v.body
    FROM kin_records r JOIN kin_doc_versions v ON v.org_id = r.org_id AND v.record_id = r.record_id
    WHERE r.org_id = ${orgId} AND r.register_id = 'docs'
      AND r.origin_key = ${`${CHARACTER_ORIGIN}${agentId}`} AND r.state <> 'dropped'
      AND v.version = (SELECT MAX(w.version) FROM kin_doc_versions w
        WHERE w.org_id = v.org_id AND w.record_id = v.record_id)
    ORDER BY r.key`.pipe(Effect.mapError(persistence));
  const kin = kinPartFor(lead.domain, lead.name, yield* companyMoney(orgId));
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
  const playbooks = yield* sql<{ key: string; title: string; originKey: string | null }>`
    SELECT r.key, r.title, r.origin_key AS "originKey"
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'docs'
      AND r.category = 'playbook' AND r.state <> 'dropped'
    ORDER BY r.created_at, r.key LIMIT ${PLAYBOOKS_READ_MAX}`.pipe(Effect.mapError(persistence));
  const connections = yield* liveConnections(orgId).pipe(Effect.mapError(persistence));
  const team = yield* LeadAccess.teamAgent(orgId).pipe(Effect.mapError(persistence));
  return {
    profile: yield* profileIn(lead),
    model: lead.model,
    runsOn: runs.model,
    modelNote: runs.note,
    character:
      character === undefined
        ? null
        : {
            key: KinRecordKey.make(character.key),
            body: wholeCharacter({ kin, body: character.body }).slice(0, CHARACTER_MAX),
          },
    kinCharacter: kin ?? null,
    ownCharacter: character?.body.slice(0, CHARACTER_MAX) ?? "",
    teamAgent: team === agentId,
    usedThisMonth: { turns: count(used?.turns), tokens: count(used?.tokens) },
    quietHours: Option.getOrElse(decodeQuiet(quiet?.hours), () => KIN_DEFAULT_QUIET_HOURS),
    connections: connections.map((row) => ({
      label: row.label,
      account: row.accountLabel,
      paused: row.pausedAt !== null,
    })),
    playbooks: playbooks
      .filter((row) => playbookForSeat(row.originKey, lead.domain))
      .slice(0, PLAYBOOKS_MAX)
      .map((row) => ({ key: KinRecordKey.make(row.key), title: row.title })),
    changed: yield* agentChanges(KIN_OWNER_LEVEL, orgId, agentId).pipe(
      Effect.mapError(persistence),
    ),
  } satisfies KinAgentPage;
});

/**
 * Writes the owner's part of an agent's character from its page as a new version of its doc, so
 * History still brings the old one back. The next turn reads it. Checked as for retiring it.
 */
export const ownerLevelSetCharacter = Effect.fn("KinAgentPage.setCharacter")(function* (input: {
  readonly by: LeadCreator;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly body: string;
}) {
  const { lead, by } = yield* retirable(input);
  yield* setCharacter(lead.orgId, lead.agentId, input.body, by ?? undefined);
  return yield* ownerLevelAgentPage(input);
});

/** Puts back one change the agent made (`ownerLevelUndoAgentChange`), checked as its page is. */
export const ownerLevelUndoChange = Effect.fn("KinAgentPage.undoChange")(function* (input: {
  readonly by: LeadCreator;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly seq: number;
}) {
  const { lead, by } = yield* retirable(input);
  const { owner } = yield* KinIdentity;
  yield* ownerLevelUndoAgentChange({
    orgId: lead.orgId,
    agentId: lead.agentId,
    seq: input.seq,
    by: by ?? owner.personId,
  });
  return yield* ownerLevelAgentPage(input);
});

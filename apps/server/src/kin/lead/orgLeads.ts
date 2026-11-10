import {
  KinAgentId,
  KinChatId,
  KinPersonId,
  type KinLeadDomain,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const ENGINEERING_DOMAIN: KinLeadDomain = "engineering";
export const CHIEF_OF_STAFF_DOMAIN: KinLeadDomain = "chief-of-staff";

export interface LiveLead {
  readonly agentId: KinAgentId;
  readonly name: string;
  readonly domain: string;
  readonly level: string;
  readonly ownerPersonId: KinPersonId;
  readonly ownerChatId: KinChatId;
  readonly models: string;
}

/**
 * The live lead that work in `orgId` belongs to: the chat's first-joined lead (as the floor picks
 * it), else the first lead created in `prefer`'s domain, else the first lead created.
 */
export const liveLead = Effect.fn("KinOrgLeads.liveLead")(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  options: { readonly chatId?: string | null | undefined; readonly prefer: KinLeadDomain },
) {
  const chatId = options.chatId ?? null;
  const [row] = yield* sql<{
    agentId: string;
    name: string;
    domain: string;
    level: string;
    ownerPersonId: string;
    ownerChatId: string;
    models: string;
  }>`SELECT l.agent_id AS "agentId", l.name, l.domain, l.level,
      a.owner_person_id AS "ownerPersonId", l.owner_chat_id AS "ownerChatId", l.models_json AS models
    FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL
    LEFT JOIN kin_chat_members m ON m.org_id = l.org_id AND m.chat_id = ${chatId}
      AND m.principal_kind = 'agent' AND m.agent_id = l.agent_id AND m.left_at IS NULL
    WHERE l.org_id = ${orgId}
    ORDER BY CASE WHEN m.member_id IS NULL THEN 1 ELSE 0 END, m.joined_at,
      CASE WHEN l.domain = ${options.prefer} THEN 0 ELSE 1 END, a.created_at, l.agent_id
    LIMIT 1`;
  return row === undefined
    ? undefined
    : ({
        ...row,
        agentId: KinAgentId.make(row.agentId),
        ownerPersonId: KinPersonId.make(row.ownerPersonId),
        ownerChatId: KinChatId.make(row.ownerChatId),
      } satisfies LiveLead);
});

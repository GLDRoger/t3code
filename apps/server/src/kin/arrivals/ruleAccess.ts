import type { KinAgentId, KinChatId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { chatShared } from "../chat/sharing.ts";
import { MAIL_PRESETS } from "../connections/mailProviders.ts";
import { directKey } from "../lead/LeadAccess.ts";
import { ownerLevelSql } from "../people/KinAccess.ts";

export const ruleSetter = Effect.fn("KinMailRules.setter")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ owner: number }>`SELECT
      ${sql.literal(ownerLevelSql("p.org_id", "p.person_id"))} AS owner
    FROM kin_people p WHERE p.org_id = ${orgId} AND p.person_id = ${personId}
      AND p.removed_at IS NULL`;
  return row === undefined ? "left" : row.owner === 1 ? "owner" : "demoted";
});

export const companyRuleMailbox = Effect.fn("KinMailRules.companyMailbox")(function* (
  orgId: KinOrgId,
  connectionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ label: string; account: string | null }>`SELECT label,
      account_label AS account FROM kin_connections WHERE org_id = ${orgId}
      AND connection_id = ${connectionId} AND person_id IS NULL AND kind = 'builtin'
      AND preset IN ${sql.in(MAIL_PRESETS)} AND removed_at IS NULL AND paused_at IS NULL
      AND state = 'active'`;
  return row;
});

export const isDirectRuleLead = Effect.fn("KinMailRules.directLead")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  agentId: KinAgentId,
  chatId: KinChatId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_agents a
    JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    JOIN kin_chats c ON c.org_id = a.org_id AND c.chat_id = ${chatId}
    JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
    WHERE a.org_id = ${orgId} AND a.agent_id = ${agentId}
      AND a.role = 'lead' AND a.retired_at IS NULL
      AND c.kind = 'direct' AND c.direct_key = ${directKey(personId, agentId)}
      AND c.archived_at IS NULL AND m.person_id = ${personId} AND m.left_at IS NULL
      AND EXISTS (SELECT 1 FROM kin_chat_members recipient
        WHERE recipient.org_id = c.org_id AND recipient.chat_id = c.chat_id
          AND recipient.agent_id = ${agentId} AND recipient.left_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM kin_chat_members other
        WHERE other.org_id = c.org_id AND other.chat_id = c.chat_id AND other.left_at IS NULL
        AND ((other.person_id IS NOT NULL AND other.person_id != ${personId})
          OR (other.agent_id IS NOT NULL AND other.agent_id != ${agentId})))`;
  return rows.length > 0 && !(yield* chatShared(sql, { orgId, chatId }));
});

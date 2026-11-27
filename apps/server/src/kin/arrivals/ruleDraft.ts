import {
  KinChatError,
  KinMailRuleMatch,
  type KinAgentId,
  type KinChatId,
  type KinMailRuleCreateInput,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { MAIL_PRESETS } from "../connections/mailProviders.ts";
import { directKey } from "../lead/LeadAccess.ts";
import { ownerLevelSql } from "../people/KinAccess.ts";
import { mailRuleContentHash } from "./ruleContent.ts";
import { mailRuleFilter, mailRuleMatchProblem, mailRulePhrase } from "./ruleMatch.ts";

export const DEFAULT_MAIL_RULE_CAP = 30;
export const mailRuleMatchJson = Schema.fromJsonString(KinMailRuleMatch);
const encodeMatch = Schema.encodeEffect(mailRuleMatchJson);

export const mailRuleOwnerOnly = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner can manage mail rules.",
});
export const badMailRule = new KinChatError({
  reason: "invalid_state",
  message: "Check the sender filters, subject words, instruction and monthly limit.",
});
const noMailbox = new KinChatError({
  reason: "invalid_state",
  message: "Choose a connected company mailbox.",
});
const noLead = new KinChatError({
  reason: "invalid_state",
  message: "Choose an active lead and your direct chat with that lead.",
});

const matchProblem = {
  public_suffix: "Use a company domain, such as junipercold.example, instead of a public suffix.",
  mixed_scripts: "Use a sender domain whose labels do not mix Latin, Cyrillic or Greek letters.",
  invalid_sender: "Use a valid sender address or domain.",
  invalid_phrase: "Use subject phrases that have 2 to 60 characters after normalization.",
} as const;

export const prepareMailRule = Effect.fn("KinMailRules.prepareDraft")(function* (
  input: Pick<KinMailRuleCreateInput, "match" | "what" | "monthlyCap">,
) {
  if (input.what.trim() === "") return yield* badMailRule;
  const problem = mailRuleMatchProblem(input.match);
  if (problem !== undefined)
    return yield* new KinChatError({ reason: "invalid_state", message: matchProblem[problem] });
  const matchJson = yield* encodeMatch(input.match).pipe(Effect.mapError(() => badMailRule));
  return {
    matchJson,
    contentSha256: mailRuleContentHash(matchJson, input.what),
    monthlyCap: input.monthlyCap ?? DEFAULT_MAIL_RULE_CAP,
  };
});

export const mailRuleMatchKey = (match: KinMailRuleMatch) => {
  const sorted = (values: ReadonlyArray<string>) => [...new Set(values)].toSorted();
  return mailRuleContentHash(
    JSON.stringify({
      from: sorted(match.from.flatMap((sender) => mailRuleFilter(sender).spelling ?? [])),
      subjectHas: sorted(match.subjectHas.map(mailRulePhrase)),
      withFile: match.withFile,
      classes: match.classes === null ? null : sorted(match.classes),
    }),
    "",
  );
};

export const checkMailRuleOwner = Effect.fn("KinMailRules.stillOwner")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_people p WHERE p.org_id = ${orgId}
    AND p.person_id = ${personId} AND p.removed_at IS NULL
    AND ${sql.literal(ownerLevelSql("p.org_id", "p.person_id"))}`;
  if (rows.length === 0) return yield* mailRuleOwnerOnly;
});

export const companyMailRuleMailbox = Effect.fn("KinMailRules.companyMailbox")(function* (
  orgId: KinOrgId,
  connectionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ label: string }>`SELECT label FROM kin_connections
    WHERE org_id = ${orgId} AND connection_id = ${connectionId} AND person_id IS NULL
      AND kind = 'builtin' AND preset IN ${sql.in(MAIL_PRESETS)} AND removed_at IS NULL
      AND paused_at IS NULL AND state = 'active'`;
  if (row === undefined) return yield* noMailbox;
  return row;
});

export const mailRuleDirectLead = Effect.fn("KinMailRules.directLead")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  agentId: KinAgentId,
  chatId: KinChatId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ name: string; ownerPersonId: KinPersonId; threadId: string | null }>`
    SELECT l.name, a.owner_person_id AS "ownerPersonId", l.thread_id AS "threadId"
    FROM kin_agents a
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
  if (row === undefined) return yield* noLead;
  return row;
});

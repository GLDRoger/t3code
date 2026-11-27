import {
  KIN_CHOICE_CARD_TTL_MS,
  KinChatError,
  KinChatId,
  KinMailRuleCardState,
  KinMailRuleCreateInput,
  KinPersonId,
  KinWidgetId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { keySentSql } from "../chat/keySent.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { effectiveAudience, SHARED_THREAD_PREFIX, turnChat } from "../lead/Audience.ts";
import { outsideRead } from "../lead/OutsideContent.ts";
import type { resolveLead } from "../lead/LeadMemory.ts";
import { sealPlans, type MailRulePlan } from "../widgets/cardPlans.ts";
import {
  checkMailRuleOwner,
  companyMailRuleMailbox,
  mailRuleDirectLead,
  mailRuleMatchKey,
  prepareMailRule,
} from "./ruleDraft.ts";
import { mailRuleFilter } from "./ruleMatch.ts";

export const MailRuleProposal = Schema.Struct({
  sourceEventId: Schema.NonEmptyString.check(Schema.isMaxLength(160)),
  connectionId: KinMailRuleCreateInput.fields.connectionId,
  agentId: KinMailRuleCreateInput.fields.agentId,
  match: KinMailRuleCreateInput.fields.match,
  what: KinMailRuleCreateInput.fields.what,
  monthlyCap: KinMailRuleCreateInput.fields.monthlyCap,
});
export const MailRuleProposalResult = Schema.Struct({ widgetId: KinWidgetId });

const ownMessage = new KinChatError({
  reason: "not_allowed",
  message:
    "A mail rule proposal needs an owner or co-owner's own message in their direct chat with this lead.",
});

const sourceOf = Effect.fn("KinMailRules.proposalSource")(function* (
  turn: Effect.Success<ReturnType<typeof resolveLead>>,
  sourceEventId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  if (
    turn.threadId.startsWith(SHARED_THREAD_PREFIX) ||
    (yield* effectiveAudience(turn)) !== "owner_only" ||
    (yield* outsideRead(turn))
  )
    return yield* ownMessage;
  const [source] = yield* sql<{ personId: KinPersonId; chatId: KinChatId }>`
    SELECT m.author_person_id AS "personId", m.chat_id AS "chatId"
    FROM kin_events e
    JOIN kin_wakeups w ON w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
      AND w.agent_id = e.agent_id AND w.thread_id = ${turn.threadId} AND w.status = 'running'
    JOIN kin_messages m ON m.org_id = e.org_id AND m.chat_id = json_extract(e.json, '$.chatId')
      AND m.message_id = json_extract(e.json, '$.messageId')
    WHERE e.org_id = ${turn.orgId} AND e.agent_id = ${turn.agentId} AND e.wakeup_id = ${turn.wakeupId}
      AND e.event_id = ${sourceEventId} AND e.tag = 'chat.message' AND e.state = 'claimed'
      AND json_extract(e.json, '$.origin') IS NULL AND m.origin_json IS NULL
      AND json_extract(e.json, '$.provenance._tag') = 'human'
      AND json_extract(e.json, '$.provenance.personId') = m.author_person_id
      AND m.author_kind = 'human' AND m.kind = 'text' AND m.status = 'posted'
      AND COALESCE(m.client_message_id, '') NOT LIKE 'send:private:%'
      AND NOT ${sql.literal(keySentSql("m.client_message_id"))}`;
  if (source === undefined || (yield* turnChat(turn))?.chatId !== source.chatId)
    return yield* ownMessage;
  yield* checkMailRuleOwner(turn.orgId, source.personId);
  yield* mailRuleDirectLead(turn.orgId, source.personId, turn.agentId, source.chatId);
  return { _tag: "person" as const, orgId: turn.orgId, personId: source.personId };
});

export const proposeMailRule = Effect.fn("KinMailRules.propose")(function* (
  turn: Effect.Success<ReturnType<typeof resolveLead>>,
  input: typeof MailRuleProposal.Type,
) {
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* KinChatService;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const { orgId } = turn;
      const person = yield* sourceOf(turn, input.sourceEventId);
      const { contentSha256, monthlyCap } = yield* prepareMailRule(input);
      const mailbox = yield* companyMailRuleMailbox(orgId, input.connectionId);
      const now = yield* Clock.currentTimeMillis;
      const matchKey = mailRuleMatchKey(input.match);
      const [open] = yield* sql<{ widgetId: KinWidgetId }>`
      SELECT w.widget_id AS "widgetId" FROM kin_widgets w
      JOIN kin_card_plans p ON p.org_id = w.org_id AND p.widget_id = w.widget_id
        AND p.chat_id = w.chat_id AND p.option_id = 'turn_on'
      WHERE w.org_id = ${orgId} AND w.type = 'mail_rule'
        AND w.closed_at IS NULL AND json_extract(p.plan_json, '$.kind') = 'mail_rule'
        AND json_extract(p.plan_json, '$.personId') = ${person.personId}
        AND json_extract(p.plan_json, '$.matchKey') = ${matchKey}
        AND json_extract(p.plan_json, '$.shown.mailbox.connectionId') = ${input.connectionId}
        AND json_extract(p.plan_json, '$.shown.expiresAt') > ${now}
      LIMIT 1`;
      if (open !== undefined) return open;
      const { chatId } = yield* chat.createDirect(person, { orgId, agentId: input.agentId });
      const destination = yield* mailRuleDirectLead(orgId, person.personId, input.agentId, chatId);
      const shown = {
        mailbox: { connectionId: input.connectionId, label: mailbox.label },
        lead: { agentId: input.agentId, name: destination.name },
        contentSha256,
        monthlyCap,
        expiresAt: now + KIN_CHOICE_CARD_TTL_MS,
      };
      const state: KinMailRuleCardState = {
        ...shown,
        match: input.match,
        fromAscii: input.match.from.flatMap((sender) => mailRuleFilter(sender).spelling ?? []),
        what: input.what,
        decision: { status: "proposed" },
      };
      const card = yield* chat.showMailRule(
        {
          _tag: "agent",
          hostPosted: true,
          orgId,
          agentId: input.agentId,
          ownerPersonId: KinPersonId.make(destination.ownerPersonId),
          threadId: ThreadId.make(destination.threadId ?? `kin-host:${input.agentId}`),
        },
        {
          chatId,
          state,
        },
      );
      const plan: MailRulePlan = { kind: "mail_rule", personId: person.personId, matchKey, shown };
      yield* sealPlans({
        orgId,
        chatId,
        widgetId: card.widgetId,
        plans: [{ optionId: "turn_on", plan }],
        now,
      });
      return { widgetId: card.widgetId };
    }),
  );
});

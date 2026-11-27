import {
  KinMailRuleMatch,
  KinMessageId,
  formatKinWhen,
  kinMailRuleMatchLine,
  type KinAgentId,
  type KinChatId,
  type KinEvent,
  type KinMailRuleHoldReason,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { MINUTE_MS } from "../durations.ts";
import { mailLine, wakeMatches } from "../pulse/outside.ts";
import { textLocale } from "../work/companyProfile.ts";
import { readOwnerZone } from "../work/recordRows.ts";
import { companyRuleMailbox, directRuleLead, ruleSetter } from "./ruleAccess.ts";
import { mailRuleContentHash } from "./ruleContent.ts";
import { holdRuleMail, pendingRuleMail } from "./ruleLifecycle.ts";
import { monthlyMailRuleLimit, recordMailRuleWake } from "./ruleLimit.ts";
import { mailRulesMoved } from "./ruleRunStore.ts";

const WINDOW_MS = 10 * MINUTE_MS;
const LIST_SIZE = 25;
const LARGE_BATCH = 20;
const decodeMatch = Schema.decodeUnknownOption(Schema.fromJsonString(KinMailRuleMatch));

type WakeRule = {
  readonly orgId: KinOrgId;
  readonly ruleId: string;
  readonly connectionId: string;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
  readonly saidBy: KinPersonId;
  readonly state: string;
  readonly contentHash: string;
  readonly matchJson: string;
  readonly what: string;
  readonly month: string | null;
  readonly fired: number;
  readonly monthlyCap: number;
  readonly lastWakeAt: number | null;
  readonly activation: number;
  readonly pausedWhy: string | null;
};

export type WakeMail = {
  readonly arrivalId: string;
  readonly fromAddress: string | null;
  readonly threadId: string | null;
  readonly receivedAt: number | null;
  readonly mailKey: string | null;
};

const ruleColumns = `org_id AS "orgId", rule_id AS "ruleId",
  connection_id AS "connectionId", agent_id AS "agentId", chat_id AS "chatId",
  said_by AS "saidBy", state, content_sha256 AS "contentHash",
  match_json AS "matchJson", what, month, fired, monthly_cap AS "monthlyCap",
  last_wake_at AS "lastWakeAt", activation, paused_why AS "pausedWhy"`;

const mailColumns = `arrival_id AS "arrivalId", from_address AS "fromAddress",
  thread_id AS "threadId", received_at AS "receivedAt", COALESCE(rule_mail_key, mail_key) AS "mailKey"`;

export const activeRuleIds = Effect.fn("KinMailRules.activeIds")(function* (
  orgId: KinOrgId,
  connectionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ ruleId: string }>`SELECT rule_id AS "ruleId" FROM kin_mail_rules
    WHERE org_id = ${orgId} AND connection_id = ${connectionId} AND state = 'on'`;
  return new Set(rows.map((row) => row.ruleId));
});

export const matchingRules = Effect.fn("KinMailRules.forMailbox")(function* (
  orgId: KinOrgId,
  connectionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<WakeRule>`SELECT ${sql.literal(ruleColumns)}
    FROM kin_mail_rules WHERE org_id = ${orgId} AND connection_id = ${connectionId}
      AND state IN ('on', 'paused') ORDER BY created_at, rule_id`;
  return rows.flatMap((rule) => {
    const match = Option.getOrUndefined(decodeMatch(rule.matchJson));
    return match === undefined ? [] : [{ rule, filter: { ...match, connectionId } }];
  });
});

const held = (reason: KinMailRuleHoldReason) => ({ held: reason });

/** Told once a month in the setter's chat; the rule is named as the Settings list names it. */
export const mailRuleLimitNotice = (input: {
  readonly match: KinMailRuleMatch;
  readonly mailbox: string;
  readonly monthlyCap: number;
  readonly until: string;
}) =>
  `${kinMailRuleMatchLine(input.match)}: this mail rule on ${input.mailbox} reached its limit of ${input.monthlyCap === 1 ? "1 run" : `${input.monthlyCap} runs`} and is held until ${input.until}. Matched mail stays in the rule’s history in Settings → Connections.`;

const checked = Effect.fn("KinMailRules.checkWake")(function* (rule: WakeRule) {
  if (rule.state === "removed") return held("removed");
  if (rule.state !== "on") {
    switch (rule.pausedWhy) {
      case "left":
        return held("setter_left");
      case "mailbox":
        return held("mailbox_unavailable");
      case "agent":
        return held("destination_unavailable");
      default:
        return held("paused");
    }
  }
  const setter = yield* ruleSetter(rule.orgId, rule.saidBy);
  if (setter === undefined) return held("setter_left");
  if (!setter.owner) return held("setter_demoted");
  const mailbox = yield* companyRuleMailbox(rule.orgId, rule.connectionId);
  if (mailbox === undefined) return held("mailbox_unavailable");
  if ((yield* directRuleLead(rule.orgId, rule.saidBy, rule.agentId, rule.chatId)) === undefined)
    return held("destination_unavailable");
  const match = Option.getOrUndefined(decodeMatch(rule.matchJson));
  if (mailRuleContentHash(rule.matchJson, rule.what) !== rule.contentHash || match === undefined)
    return held("wording_changed");
  return { mailbox, setterName: setter.name, match };
});

export const alreadyClaimedRuleMail = Effect.fn("KinMailRules.alreadyClaimedMail")(function* (
  rule: WakeRule,
  mailKey: string | null,
) {
  if (mailKey === null) return false;
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql`SELECT 1 FROM kin_arrivals WHERE org_id = ${rule.orgId}
    AND rule_id = ${rule.ruleId} AND (rule_mail_key = ${mailKey} OR (rule_mail_key IS NULL AND mail_key = ${mailKey}))
    AND (event_id IS NOT NULL OR rule_state IN ('woke', 'batched')) LIMIT 1`;
  return row !== undefined;
});

export const claimRuleMail = Effect.fn("KinMailRules.claimMail")(function* (
  rule: WakeRule,
  arrivalId: string,
  mailKey: string | null,
  result: "match" | "held_unverified",
  playbookRoute: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_arrivals SET rule_id = ${rule.ruleId},
    rule_state = ${result === "match" ? "batched" : "held_unverified"},
    rule_hold_reason = ${result === "match" ? null : "sender_unverified"},
    rule_playbook_route = ${playbookRoute}, rule_mail_key = ${mailKey},
    rule_held_at = CASE WHEN ${result === "match"} THEN NULL ELSE noticed_at END
    WHERE org_id = ${rule.orgId} AND arrival_id = ${arrivalId}`;
  yield* mailRulesMoved(rule.orgId);
});

const notice = Effect.fn("KinMailRules.notice")(function* (
  rule: Pick<WakeRule, "orgId" | "ruleId" | "chatId">,
  key: string,
  body: string,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const messageId = KinMessageId.make(`mail-rule:${rule.ruleId}:${key}`);
  const rows = yield* sql`SELECT 1 FROM kin_messages WHERE org_id = ${rule.orgId}
    AND message_id = ${messageId}`;
  if (rows.length > 0) return;
  const message = yield* repo.insertMessage({
    orgId: rule.orgId,
    chatId: rule.chatId,
    messageId,
    audience: "owner",
    author: { _tag: "system" },
    kind: "system",
    body,
    intent: null,
    mentions: [],
    replyTo: null,
    widgetId: null,
    floorRunId: null,
    status: "posted",
    sentBy: null,
    clientMessageId: null,
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(at)),
    editedAt: null,
  });
  yield* sql.afterCommit(hub.publish({ type: "message.posted", orgId: rule.orgId, message }));
});

export const wakeRuleMail = Effect.fn("KinMailRules.wakeMail")(function* (
  rule: Pick<WakeRule, "orgId" | "ruleId" | "agentId" | "chatId" | "saidBy" | "activation">,
  mailbox: { readonly label: string; readonly account: string | null },
  first: WakeMail,
  rest: ReadonlyArray<WakeMail>,
  notListed: number,
  at: number,
  manual = false,
) {
  const lineOf = (mail: WakeMail) => ({
    ...mailLine(mailbox.label, mailbox.account, {
      from: mail.fromAddress,
      date:
        mail.receivedAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(mail.receivedAt)),
      threadId: mail.threadId ?? mail.arrivalId,
      receivedBy: null,
      subject: null,
    }),
    id: mail.arrivalId,
  });
  const key = `rule:${rule.ruleId}:${first.mailKey ?? first.arrivalId}`;
  const [wake] = yield* wakeMatches(rule.orgId, at, [
    {
      line: lineOf(first),
      more: rest.map(lineOf),
      notListed,
      arrivalId: first.arrivalId,
      rule: {
        ruleId: rule.ruleId,
        agentId: rule.agentId,
        chatId: rule.chatId,
        saidBy: rule.saidBy,
        activation: rule.activation,
        key: manual ? `${key}:manual:${SecureRandom.uuidV4Unsafe()}` : key,
        ...(manual ? { manual: true } : {}),
      },
    },
  ]);
  return wake?.eventId;
});

const pointAtWake = (sql: SqlClient.SqlClient, agentId: KinAgentId, eventId: string) =>
  sql`agent_id = ${agentId}, event_id = ${eventId}, rule_hold_reason = NULL`;

export const recordManualRuleMail = Effect.fn("KinMailRules.recordManualMail")(function* (
  rule: Pick<WakeRule, "orgId" | "ruleId">,
  arrivalId: string,
  eventId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_mail_rule_runs (org_id, event_id, arrival_id, rule_id, state, manual)
    VALUES (${rule.orgId}, ${eventId}, ${arrivalId}, ${rule.ruleId}, 'woke', 1)`;
});

const flush = Effect.fn("KinMailRules.flush")(function* (rule: WakeRule, at: number) {
  const sql = yield* SqlClient.SqlClient;
  const pending = pendingRuleMail(sql, rule.orgId, [rule.ruleId]);
  const [first, ...rest] = yield* sql<WakeMail & { total: number }>`
    SELECT ${sql.literal(mailColumns)}, COUNT(*) OVER () AS total
    FROM kin_arrivals WHERE ${pending}
    ORDER BY noticed_at, arrival_id LIMIT ${LIST_SIZE}`;
  if (first === undefined) return;
  const destination = yield* checked(rule);
  if ("held" in destination) {
    yield* holdRuleMail(rule.orgId, [rule.ruleId], "held_paused", destination.held, at);
    return yield* mailRulesMoved(rule.orgId);
  }
  const zone = yield* readOwnerZone(rule.orgId);
  const limit = monthlyMailRuleLimit(rule, at, zone);
  if (limit.atLimit) {
    yield* holdRuleMail(rule.orgId, [rule.ruleId], "held_cap", "monthly_limit", at);
    yield* mailRulesMoved(rule.orgId);
    const told = yield* sql`UPDATE kin_mail_rules SET cap_told = ${limit.month}
      WHERE org_id = ${rule.orgId} AND rule_id = ${rule.ruleId} AND cap_told IS NOT ${limit.month}
      RETURNING rule_id`;
    if (told.length > 0) {
      const reset = DateTime.makeZonedUnsafe(at, { timeZone: zone }).pipe(
        DateTime.startOf("month"),
        DateTime.add({ months: 1 }),
      );
      const until = formatKinWhen(DateTime.toEpochMillis(reset), "longDay", {
        zone,
        locale: yield* textLocale(rule.orgId),
      });
      yield* notice(
        rule,
        `limit:${limit.month}`,
        mailRuleLimitNotice({
          match: destination.match,
          mailbox: destination.mailbox.label,
          monthlyCap: rule.monthlyCap,
          until,
        }),
        at,
      );
    }
    return;
  }
  if (rule.lastWakeAt !== null && at - rule.lastWakeAt < WINDOW_MS) return;

  const largestBatch =
    first.total < LARGE_BATCH
      ? undefined
      : (yield* sql<{ sender: string; total: number }>`
    SELECT from_address AS sender, COUNT(*) AS total FROM kin_arrivals
    WHERE ${pending} AND from_address IS NOT NULL GROUP BY from_address HAVING COUNT(*) >= ${LARGE_BATCH}
    ORDER BY total DESC, sender LIMIT 1`)[0];
  const eventId = yield* wakeRuleMail(
    rule,
    destination.mailbox,
    first,
    rest,
    first.total - rest.length - 1,
    at,
  );
  if (eventId === undefined) return;
  // The count and feed cursor are committed with the queue insert.
  const counted = yield* recordMailRuleWake(rule, at);
  if (counted.status !== "counted")
    return yield* Effect.die(new Error("The mail rule changed during its wake."));

  yield* sql`INSERT INTO kin_mail_rule_runs (org_id, event_id, arrival_id, rule_id, state, manual)
    SELECT org_id, ${eventId}, arrival_id, ${rule.ruleId},
      CASE WHEN arrival_id = ${first.arrivalId} THEN 'woke' ELSE 'batched' END, 0
    FROM kin_arrivals WHERE ${pending}`;
  yield* sql`UPDATE kin_arrivals SET rule_state = CASE WHEN arrival_id = ${first.arrivalId}
      THEN 'woke' ELSE 'batched' END, ${pointAtWake(sql, rule.agentId, eventId)}
    WHERE ${pending}`;
  yield* mailRulesMoved(rule.orgId);
  if (largestBatch !== undefined) {
    const day = DateTime.formatIsoDate(DateTime.makeZonedUnsafe(at, { timeZone: zone }));
    yield* notice(
      rule,
      `batch:${day}`,
      `Kin grouped ${largestBatch.total} emails from ${largestBatch.sender} into one mail rule run. Each email is in the rule’s history in Settings → Connections.`,
      at,
    );
  }
});

export const flushRuleMail = Effect.fn("KinMailRules.flushMailbox")(function* (
  rules: ReadonlyArray<{ readonly rule: WakeRule }>,
  at: number,
) {
  for (const { rule } of rules) yield* flush(rule, at);
});

export const checkRuleWake = Effect.fn("KinMailRules.checkQueuedWake")(function* (
  pulse: Extract<KinEvent, { readonly _tag: "pulse" }>,
) {
  if (pulse.rule === undefined || pulse.chatId === undefined)
    return held("destination_unavailable");
  const { rule: queued, chatId } = pulse;
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [rule] = yield* sql<WakeRule>`SELECT ${sql.literal(ruleColumns)} FROM kin_mail_rules
      WHERE org_id = ${pulse.orgId} AND rule_id = ${queued.ruleId}`;
      if (rule === undefined) return held("removed");
      if (rule.activation !== queued.activation) return held("paused");
      if (rule.agentId !== pulse.agentId || rule.chatId !== chatId)
        return held("destination_unavailable");
      const access = yield* checked(rule);
      return "held" in access ? access : { setterName: access.setterName, what: rule.what };
    }),
  );
});

export const reportRuleWordingChanged = Effect.fn("KinMailRules.reportChanged")(function* (
  pulse: Extract<KinEvent, { readonly _tag: "pulse" }>,
  at: number,
) {
  if (pulse.rule === undefined || pulse.chatId === undefined) return;
  const checked = yield* checkRuleWake(pulse);
  if (!("held" in checked) || checked.held !== "wording_changed") return;
  const sql = yield* SqlClient.SqlClient;
  const [mailbox] = yield* sql<{ label: string }>`SELECT c.label FROM kin_mail_rules r
    JOIN kin_connections c ON c.org_id = r.org_id AND c.connection_id = r.connection_id
    WHERE r.org_id = ${pulse.orgId} AND r.rule_id = ${pulse.rule.ruleId}`;
  if (mailbox === undefined) return;
  yield* notice(
    { orgId: pulse.orgId, ruleId: pulse.rule.ruleId, chatId: pulse.chatId },
    `changed:${pulse.eventId}`,
    `The mail rule on ${mailbox.label} was changed outside Kin, so it won't run. Remove it in Settings → Connections, then ask here for it again.`,
    at,
  );
});

import { KinChatError, KinDay, parseKinMoney } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { liveLead } from "../lead/orgLeads.ts";
import { quote } from "../lead/LeadPrompt.ts";
import { ALERT_SOURCE, markOutside } from "../lead/OutsideContent.ts";
import { type Lead, leadTool, ownerTurn } from "./leadWork.ts";
import { connectedNow } from "./statements/alertSql.ts";
import type { AlertRead } from "./statements/alertText.ts";
import { settleReading } from "./statements/bankAlerts.ts";

/**
 * The agent reader of bank alerts: the unread alerts of counted senders, which the plain reader
 * left because their words weren't plain enough, read by the Finance lead into fields. Every
 * reading is checked by the server against the mail itself and the approval as it stands
 * (`settleReading`); nothing an agent says records money.
 */

const SHOWN = 10;
const Amount = Schema.String.check(Schema.isMaxLength(40));
const Reading = Schema.Struct({
  alert: Schema.String.check(Schema.isMaxLength(60)),
  kind: Schema.Literals(["moved", "not_moved"]),
  direction: Schema.optional(Schema.Literals(["in", "out"])),
  amount: Schema.optional(Amount),
  currency: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))),
  day: Schema.optional(KinDay),
  account: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{4}$/))),
  party: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  reference: Schema.optional(Schema.String.check(Schema.isMaxLength(40))),
  balance: Schema.optional(Amount),
});
export const AlertsInput = Schema.Struct({
  readings: Schema.optional(Schema.Array(Reading).check(Schema.isMaxLength(SHOWN))),
});
export const AlertsResult = Schema.Struct({
  read: Schema.Array(
    Schema.Struct({
      alert: Schema.String,
      counted: Schema.Boolean,
      why: Schema.optional(Schema.String),
    }),
  ),
  unread: Schema.Array(Schema.Struct({ alert: Schema.String, mail: Schema.String })),
  more: Schema.Boolean,
  sensitive: Schema.Literal(true),
});

type Unread = {
  readonly alertId: string;
  readonly connectionId: string;
  readonly messageId: string;
  readonly address: string;
  readonly subject: string;
  readonly receivedAt: number;
  readonly text: string;
};
/** Unread alerts of a sender that counts now, in a mailbox connected now; oldest first. */
const unreadOf = (sql: SqlClient.SqlClient, lead: Lead, ids?: ReadonlyArray<string>) =>
  sql<Unread>`SELECT a.alert_id AS "alertId", a.connection_id AS "connectionId",
      a.message_id AS "messageId", a.address, a.subject, a.received_at AS "receivedAt", a.text
    FROM kin_bank_alerts a
    WHERE a.org_id = ${lead.orgId} AND a.state = 'unread' AND ${connectedNow(sql, "a")}
      AND EXISTS (SELECT 1 FROM kin_bank_alert_senders s WHERE s.org_id = a.org_id
        AND s.connection_id = a.connection_id AND s.address = a.address AND s.state = 'counted')
      ${ids === undefined ? sql`` : sql`AND a.alert_id IN ${sql.in(ids)}`}
    ORDER BY a.received_at, a.alert_id LIMIT ${ids === undefined ? SHOWN + 1 : SHOWN}`;

const minorOf = (amount: string | undefined, currency: string | undefined) => {
  if (amount === undefined || currency === undefined) return undefined;
  const read = parseKinMoney(`${amount.replace(/[\u00a0\u202f' ]/gu, "")} ${currency}`, currency);
  return "money" in read && read.money.currency === currency ? read.money.minor : undefined;
};

/** An agent's `moved` reading as fields the server checks; undefined when one it needs is missing. */
const fieldsOf = (reading: typeof Reading.Type): AlertRead | undefined => {
  const amountMinor = minorOf(reading.amount, reading.currency);
  const balance = reading.balance === undefined ? null : minorOf(reading.balance, reading.currency);
  if (
    reading.direction === undefined ||
    amountMinor === undefined ||
    amountMinor <= 0 ||
    reading.day === undefined ||
    reading.account === undefined ||
    reading.currency === undefined ||
    balance === undefined
  )
    return undefined;
  return {
    amountMinor,
    currency: reading.currency,
    direction: reading.direction === "in" ? "credit" : "debit",
    day: reading.day,
    account: reading.account,
    party: reading.party ?? null,
    balanceMinor: balance,
    reference: reading.reference?.toUpperCase() ?? null,
  };
};

const runRead = Effect.fnUntraced(function* (lead: Lead, input: typeof AlertsInput.Type) {
  yield* ownerTurn(lead);
  const sql = yield* SqlClient.SqlClient;
  const finance = yield* liveLead(sql, lead.orgId, { prefer: "finance" });
  if (finance?.agentId !== lead.agentId)
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Bank alerts are read by the company's Finance lead.",
    });
  // The mail is the bank's words, outside text: the turn is marked before it sees any.
  yield* markOutside(lead, ALERT_SOURCE);
  const now = yield* Clock.currentTimeMillis;
  const readings = input.readings ?? [];
  const stored =
    readings.length === 0
      ? []
      : yield* unreadOf(
          sql,
          lead,
          readings.map((one) => one.alert),
        );
  const asked = { count: 0 };
  const read: Array<(typeof AlertsResult.Type.read)[number]> = [];
  for (const reading of readings) {
    const row = stored.find((one) => one.alertId === reading.alert);
    if (row === undefined) {
      read.push({
        alert: reading.alert,
        counted: false,
        why: "Not an unread alert of a sender Kin counts now.",
      });
      continue;
    }
    const fields = reading.kind === "moved" ? fieldsOf(reading) : undefined;
    const reason =
      reading.kind === "not_moved" ? "not_moved" : fields === undefined ? "unreadable" : undefined;
    if (reason !== undefined || fields === undefined) {
      yield* sql`UPDATE kin_bank_alerts SET state = 'not_counted', reason = ${reason ?? "unreadable"},
          text = NULL
        WHERE org_id = ${lead.orgId} AND alert_id = ${row.alertId} AND state = 'unread'`;
      read.push({ alert: row.alertId, counted: false, why: reason ?? "unreadable" });
      continue;
    }
    yield* settleReading(lead.orgId, row, fields, row.text, now, asked);
    const [after] = yield* sql<{ state: string; reason: string | null }>`SELECT state, reason
      FROM kin_bank_alerts WHERE org_id = ${lead.orgId} AND alert_id = ${row.alertId}`;
    read.push({
      alert: row.alertId,
      counted: after?.state === "counted",
      ...(after?.reason == null ? {} : { why: after.reason }),
    });
  }
  const left = yield* unreadOf(sql, lead);
  return {
    read,
    unread: left.slice(0, SHOWN).map((one) => ({
      alert: one.alertId,
      mail: quote("bank alert mail (untrusted)", one.text, true),
    })),
    more: left.length > SHOWN,
    sensitive: true as const,
  };
});
export const read = leadTool("KinBankAlertTools.read", runRead);

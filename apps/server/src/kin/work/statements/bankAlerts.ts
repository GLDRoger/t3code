// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import { type KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRecords, type Writer } from "../KinRecords.ts";
import { parseFields } from "../lists.ts";
import { dayIn } from "../money.ts";
import { endOfDay, ownerZone } from "../recordRows.ts";
import { orgOwner } from "../toolNames.ts";
import {
  bankStates,
  directionOf,
  ensureBankList,
  findBankList,
  last4,
  referenceKey,
  rowFields,
  rowTitle,
} from "./bankList.ts";
import { type AlertMail, type HdfcAlert, readHdfcAlert } from "./hdfcAlerts.ts";
import type { Statement, StatementRow } from "./statementTable.ts";
import { DAY_MS } from "../../durations.ts";

/**
 * Bank alert mails into Bank transactions, one entry per bank reference, whichever mailbox or
 * statement saw it first. Each mail Kin looked at is kept once in `kin_bank_alerts` with what
 * came of it, never its text; the newest "Avl bal" an alert printed is that account's.
 */

const BANK = "HDFC Bank";
const writer: Writer = { actor: { _tag: "system" }, via: "import" };

export interface AlertMessage extends AlertMail {
  /** The mail's `Message-ID`, which names it in any mailbox; null when it has none. */
  readonly messageId: string | null;
}

export interface AlertTally {
  readonly recorded: number;
  readonly duplicate: number;
  /** Mail from HDFC's address that the receiving server didn't vouch for, or that didn't read. */
  readonly rejected: number;
}

const hash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 32);

/** One mail in one mailbox: by its `Message-ID`, else by where and when it arrived. */
const alertIdOf = (connectionId: string, threadId: string, message: AlertMessage) =>
  hash(
    message.messageId === null
      ? `${connectionId}\0${threadId}\0${message.date ?? ""}\0${message.subject}`
      : `${connectionId}\0${message.messageId}`,
  );

const alertOriginKey = (alert: Pick<HdfcAlert, "account" | "reference">) =>
  `alert:hdfc:${alert.account}:${referenceKey(alert.reference)}`;

/** An alert as the one statement row it is, so its entry reads as a statement's would. */
const asStatement = (alert: HdfcAlert): { statement: Statement; row: StatementRow } => {
  const row: StatementRow = {
    index: 0,
    date: alert.date,
    description:
      alert.counterparty ??
      `${alert.direction === "credit" ? "Money in" : "Money out"} (bank alert)`,
    reference: alert.reference,
    amountMinor: alert.amountMinor,
    direction: alert.direction,
    balanceMinor: alert.balanceMinor,
    foreign: null,
  };
  return {
    row,
    statement: {
      kind: "account",
      bank: BANK,
      account: alert.account,
      currency: alert.currency,
      from: alert.date,
      to: alert.date,
      openingMinor: null,
      closingMinor: null,
      rows: [row],
      check: { status: "unchecked", line: "" },
    },
  };
};

/**
 * The entry that is already this alert's money: Kin's own for this reference, else one a
 * statement saved of the same account, day (a day either side), amount, way and reference.
 */
const existingEntry = Effect.fn("KinBankAlerts.existing")(function* (
  orgId: KinOrgId,
  alert: HdfcAlert,
) {
  const sql = yield* SqlClient.SqlClient;
  const def = yield* findBankList(orgId);
  if (def === undefined) return undefined;
  const [own] = yield* sql<{ recordId: string }>`SELECT record_id AS "recordId" FROM kin_records
    WHERE org_id = ${orgId} AND register_id = ${def.id} AND origin_key = ${alertOriginKey(alert)}`;
  if (own !== undefined) return own.recordId;
  const zone = yield* ownerZone(orgId);
  const day = Date.parse(`${alert.date}T00:00:00Z`);
  const near = yield* sql<{
    recordId: string;
    currency: string | null;
    dateAt: number;
    fieldsJson: string;
  }>`SELECT record_id AS "recordId", currency, date_at AS "dateAt", fields_json AS "fieldsJson"
    FROM kin_records WHERE org_id = ${orgId} AND register_id = ${def.id}
      AND amount_minor = ${alert.amountMinor}
      AND date_at >= ${day - 2 * DAY_MS} AND date_at <= ${day + 3 * DAY_MS}
    ORDER BY date_at, record_id`;
  const reference = referenceKey(alert.reference);
  return near.find((one) => {
    if ((one.currency ?? def.currency) !== alert.currency) return false;
    const fields = parseFields(one.fieldsJson);
    const said = typeof fields.reference === "string" ? referenceKey(fields.reference) : "";
    const account = last4(typeof fields.account === "string" ? fields.account : null);
    const day = dayIn(one.dateAt, zone);
    return (
      said === reference &&
      directionOf(fields) !== (alert.direction === "debit" ? "credit" : "debit") &&
      (account === null || account === alert.account) &&
      Math.abs(Date.parse(`${day}T00:00:00Z`) - Date.parse(`${alert.date}T00:00:00Z`)) <= 2 * DAY_MS
    );
  })?.recordId;
});

const recordAlert = Effect.fn("KinBankAlerts.record")(function* (
  orgId: KinOrgId,
  owner: KinPersonId,
  alert: HdfcAlert,
  now: number,
) {
  const found = yield* existingEntry(orgId, alert);
  if (found !== undefined) return { outcome: "duplicate" as const, recordId: found };
  const records = yield* KinRecords;
  const def = yield* ensureBankList(orgId, now);
  const { statement, row } = asStatement(alert);
  const title = rowTitle(row);
  const { row: made } = yield* records.create(orgId, writer, {
    list: def.id,
    originKey: alertOriginKey(alert),
    title,
    owner: { _tag: "person", personId: owner },
    state: bankStates(def).open,
    amount: { minor: alert.amountMinor, currency: alert.currency },
    dateAt: endOfDay(alert.date, yield* ownerZone(orgId)),
    dateAllDay: true,
    fields: rowFields(def, statement, row),
    notes:
      title === row.description
        ? "From an HDFC Bank alert mail."
        : `${row.description}\nFrom an HDFC Bank alert mail.`,
    sensitive: true,
  });
  return { outcome: "recorded" as const, recordId: made.recordId };
});

/** Whether Kin already looked at a thread's mail up to its newest, so it needn't read it again. */
export const threadSeen = Effect.fn("KinBankAlerts.threadSeen")(function* (
  orgId: KinOrgId,
  connectionId: string,
  threadId: string,
  newest: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ last: number | null }>`SELECT MAX(sent_at) AS last
    FROM kin_bank_alerts
    WHERE org_id = ${orgId} AND connection_id = ${connectionId} AND thread_id = ${threadId}`;
  return row?.last !== null && row?.last !== undefined && row.last >= newest;
});

/**
 * One thread's mail, each message once: an alert that reads is its bank transaction (new, or the
 * one it already is), anything else is counted by why. Mail of a mailbox with no owner waits.
 */
export const takeAlerts = Effect.fn("KinBankAlerts.take")(function* (
  orgId: KinOrgId,
  input: {
    readonly connectionId: string;
    readonly threadId: string;
    readonly messages: ReadonlyArray<AlertMessage>;
    readonly now: number;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const tally = { recorded: 0, duplicate: 0, rejected: 0 };
  const owner = yield* orgOwner(orgId);
  if (owner === null) return tally satisfies AlertTally;
  for (const message of input.messages) {
    const alertId = alertIdOf(input.connectionId, input.threadId, message);
    const [seen] = yield* sql`SELECT 1 AS seen FROM kin_bank_alerts
      WHERE org_id = ${orgId} AND alert_id = ${alertId}`;
    if (seen !== undefined) continue;
    const reading = readHdfcAlert(message);
    const sentAt = message.date === null ? Number.NaN : Date.parse(message.date);
    const base = {
      org_id: orgId,
      alert_id: alertId,
      connection_id: input.connectionId,
      thread_id: input.threadId,
      sent_at: Number.isFinite(sentAt) ? sentAt : null,
      seen_at: input.now,
    };
    if (reading._tag === "rejected") {
      yield* sql`INSERT INTO kin_bank_alerts ${sql.insert({ ...base, outcome: reading.reason })}`;
      // Another sender's mail in the thread isn't an alert to count.
      if (reading.reason !== "sender") tally.rejected++;
      continue;
    }
    const { alert } = reading;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const done = yield* recordAlert(orgId, KinPersonId.make(owner), alert, input.now);
        yield* sql`INSERT INTO kin_bank_alerts ${sql.insert({
          ...base,
          outcome: done.outcome,
          bank: BANK,
          account: alert.account,
          reference: alert.reference,
          record_id: done.recordId,
          currency: alert.currency,
          balance_minor: alert.balanceMinor,
        })}`;
        tally[done.outcome]++;
      }),
    );
  }
  return tally satisfies AlertTally;
});

export interface AlertBalance {
  readonly bank: string;
  readonly account: string;
  readonly currency: string;
  readonly balanceMinor: number;
  readonly sentAt: number;
}

/** Per account, the "Avl bal" of the newest alert that printed one. */
export const alertBalances = Effect.fn("KinBankAlerts.balances")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<AlertBalance>`SELECT a.bank, a.account, a.currency,
      a.balance_minor AS "balanceMinor", a.sent_at AS "sentAt"
    FROM kin_bank_alerts a
    WHERE a.org_id = ${orgId} AND a.balance_minor IS NOT NULL AND a.sent_at IS NOT NULL
      AND a.alert_id = (SELECT b.alert_id FROM kin_bank_alerts b
        WHERE b.org_id = a.org_id AND b.bank = a.bank AND b.account = a.account
          AND b.currency = a.currency AND b.balance_minor IS NOT NULL AND b.sent_at IS NOT NULL
        ORDER BY b.sent_at DESC, b.alert_id DESC LIMIT 1)
    ORDER BY a.bank, a.account, a.currency`;
});

/** How many alert mails since `since` Kin couldn't count, by why. */
export const rejectedAlerts = Effect.fn("KinBankAlerts.rejected")(function* (
  orgId: KinOrgId,
  since: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ outcome: "unverified" | "unparsed"; count: number }>`SELECT outcome,
      COUNT(*) AS count FROM kin_bank_alerts
    WHERE org_id = ${orgId} AND outcome IN ('unverified', 'unparsed') AND seen_at >= ${since}
    GROUP BY outcome ORDER BY outcome`;
  return {
    unverified: rows.find((one) => one.outcome === "unverified")?.count ?? 0,
    unparsed: rows.find((one) => one.outcome === "unparsed")?.count ?? 0,
  };
});

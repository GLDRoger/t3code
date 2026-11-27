// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import { type KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRecords, type Writer } from "../KinRecords.ts";
import { parseFields } from "../lists.ts";
import { homeCurrency } from "../companyProfile.ts";
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
import { readApprovedAlert } from "./bankAlertMailReading.ts";
import { normalizeAddress, sendersOf, type ApprovedSender } from "./bankSenders.ts";
import { MAIL_PRESETS } from "../../connections/mailProviders.ts";
import * as BankAlertReader from "./BankAlertReader.ts";
import type { Statement, StatementRow } from "./statementTable.ts";
import { DAY_MS } from "../../durations.ts";

/**
 * Bank alert mails into Bank transactions, one entry per bank reference, whichever mailbox or
 * statement saw it first. Each mail Kin looked at is kept once in `kin_bank_alerts` with what
 * came of it, never its text; the newest available balance an alert printed is that account's.
 */

/** The parts of one message a format reads. */
export interface AlertMail {
  readonly fromAddress: string | null;
  readonly subject: string;
  /** The mail's `Date` header. */
  readonly date: string | null;
  readonly authResults: ReadonlyArray<string>;
  readonly text: string;
}

export interface BankAlert {
  readonly direction: "debit" | "credit";
  readonly amountMinor: number;
  readonly currency: string;
  /** The account's last four digits, as the alert prints them. */
  readonly account: string;
  /** `YYYY-MM-DD`, the day the alert says the money moved. */
  readonly date: string;
  readonly reference: string;
  /** Who the money went to or came from, as printed; null when the alert names no one. */
  readonly counterparty: string | null;
  /** The available balance the alert prints, when it prints one. */
  readonly balanceMinor: number | null;
  /** When the mail was sent: the balance is as of this instant. */
  readonly sentAt: number;
}

export type AlertRejection =
  /** Not from the bank's alert address, or a reply or forward of one. */
  | "sender"
  /** From the address, but the receiving server didn't vouch for it. */
  | "unverified"
  /** From the bank, verified, but not one transaction read one way. */
  | "unparsed"
  | "other_account";

export type AlertReading =
  | { readonly _tag: "alert"; readonly alert: BankAlert }
  | { readonly _tag: "rejected"; readonly reason: AlertRejection };

const writer: Writer = { actor: { _tag: "system" }, via: "import" };

export interface AlertMessage extends AlertMail {
  /** The mail's `Message-ID`, which names it in any mailbox; null when it has none. */
  readonly messageId: string | null;
}

export interface AlertTally {
  readonly recorded: number;
  readonly duplicate: number;
  /** Mail from a bank's alert address that the receiving server didn't vouch for, or didn't read. */
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

/** A reversal quotes its debit's reference, so the way the money moved is part of the key. */
const alertOriginKey = (sender: ApprovedSender, alert: BankAlert) =>
  `alert:${sender.bankKey}:${alert.account}:${alert.direction}:${referenceKey(alert.reference)}`;

/** An alert as the one statement row it is, so its entry reads as a statement's would. */
const asStatement = (
  sender: ApprovedSender,
  alert: BankAlert,
): { statement: Statement; row: StatementRow } => {
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
      bank: sender.bankName,
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
  sender: ApprovedSender,
  alert: BankAlert,
) {
  const sql = yield* SqlClient.SqlClient;
  const def = yield* findBankList(orgId);
  if (def === undefined) return undefined;
  const [own] = yield* sql<{ recordId: string }>`SELECT record_id AS "recordId" FROM kin_records
    WHERE org_id = ${orgId} AND register_id = ${def.id} AND origin_key = ${alertOriginKey(sender, alert)}`;
  if (own !== undefined) return own.recordId;
  const zone = yield* ownerZone(orgId);
  const day = Date.parse(`${alert.date}T00:00:00Z`);
  const near = yield* sql<{
    recordId: string;
    currency: string | null;
    dateAt: number;
    fieldsJson: string;
    createdByKind: string;
    originKey: string;
  }>`SELECT record_id AS "recordId", currency, date_at AS "dateAt", fields_json AS "fieldsJson",
      created_by_kind AS "createdByKind", origin_key AS "originKey"
    FROM kin_records WHERE org_id = ${orgId} AND register_id = ${def.id}
      AND amount_minor = ${alert.amountMinor}
      AND date_at >= ${day - 2 * DAY_MS} AND date_at <= ${day + 3 * DAY_MS}
    ORDER BY date_at, record_id`;
  const reference = referenceKey(alert.reference);
  const candidates = near.flatMap((one) => {
    if ((one.currency ?? def.currency) !== alert.currency) return [];
    const fields = parseFields(one.fieldsJson);
    const said = typeof fields.reference === "string" ? referenceKey(fields.reference) : "";
    const account = last4(typeof fields.account === "string" ? fields.account : null);
    const date = dayIn(one.dateAt, zone);
    const direction = directionOf(fields);
    const exact = account === alert.account && direction === alert.direction && date === alert.date;
    return [
      {
        ...one,
        said,
        exact,
        matchesReference:
          said === reference &&
          (one.createdByKind === "agent"
            ? exact
            : direction !== (alert.direction === "debit" ? "credit" : "debit") &&
              (account === null || account === alert.account) &&
              Math.abs(Date.parse(`${date}T00:00:00Z`) - day) <= 2 * DAY_MS),
      },
    ];
  });
  const matching = candidates.find((one) => one.matchesReference);
  if (matching !== undefined) return matching.recordId;
  const manual = candidates.filter((one) => one.exact);
  for (const one of manual) {
    if (one.said !== "" || one.createdByKind !== "agent" || one.originKey.startsWith("alert:"))
      continue;
    const claims = yield* sql<{ reference: string }>`SELECT DISTINCT reference FROM kin_bank_alerts
      WHERE org_id = ${orgId} AND record_id = ${one.recordId} AND bank = ${sender.bankName}
        AND account = ${alert.account} AND currency = ${alert.currency} AND reference IS NOT NULL`;
    if (claims.some((claim) => referenceKey(claim.reference) === reference)) return one.recordId;
    if (claims.length === 0 && manual.length === 1) return one.recordId;
  }
  return undefined;
});

const recordAlert = Effect.fn("KinBankAlerts.record")(function* (
  orgId: KinOrgId,
  owner: KinPersonId,
  sender: ApprovedSender,
  alert: BankAlert,
  now: number,
) {
  const found = yield* existingEntry(orgId, sender, alert);
  if (found !== undefined) return { outcome: "duplicate" as const, recordId: found };
  const records = yield* KinRecords;
  const def = yield* ensureBankList(orgId, now);
  const { statement, row } = asStatement(sender, alert);
  const title = rowTitle(row);
  const { row: made } = yield* records.create(orgId, writer, {
    list: def.id,
    originKey: alertOriginKey(sender, alert),
    title,
    owner: { _tag: "person", personId: owner },
    state: bankStates(def).open,
    amount: { minor: alert.amountMinor, currency: alert.currency },
    dateAt: endOfDay(alert.date, yield* ownerZone(orgId)),
    dateAllDay: true,
    fields: rowFields(def, statement, row),
    notes:
      title === row.description
        ? `From an alert mail from ${sender.bankName}.`
        : `${row.description}\nFrom an alert mail from ${sender.bankName}.`,
    sensitive: true,
  });
  return { outcome: "recorded" as const, recordId: made.recordId };
});

export const bankAlertMailbox = Effect.fn("KinBankAlerts.companyMailbox")(function* (
  orgId: KinOrgId,
  connectionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [mailbox] = yield* sql`SELECT 1 FROM kin_connections WHERE org_id = ${orgId}
    AND connection_id = ${connectionId} AND person_id IS NULL AND state = 'active'
    AND removed_at IS NULL AND paused_at IS NULL AND preset IN ${sql.in(MAIL_PRESETS)}`;
  return mailbox !== undefined;
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

export const ALERT_RETRY_WINDOW = 14 * DAY_MS;
// Only unparsed rows use reference for an ordered parser marker instead of a bank reference.
const PARSER_MARKER = "parser:0003";

const canRetryAlert = (sql: SqlClient.SqlClient, now: number) =>
  sql`outcome = 'unparsed' AND sent_at BETWEEN ${now - ALERT_RETRY_WINDOW} AND ${now}
    AND COALESCE(reference, '') < ${PARSER_MARKER}`;

export const retryAlertThreads = Effect.fn("KinBankAlerts.retryThreads")(function* (
  orgId: KinOrgId,
  connectionId: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ threadId: string }>`SELECT DISTINCT thread_id AS "threadId"
    FROM kin_bank_alerts WHERE org_id = ${orgId} AND connection_id = ${connectionId}
      AND ${canRetryAlert(sql, now)}
    ORDER BY thread_id`;
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
    readonly senders?: ReadonlyMap<string, ApprovedSender>;
    readonly retryOnly?: boolean;
    readonly recheckedThread?: boolean;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const tally = { recorded: 0, duplicate: 0, rejected: 0 };
  const owner = yield* orgOwner(orgId);
  if (owner === null || !(yield* bankAlertMailbox(orgId, input.connectionId)))
    return tally satisfies AlertTally;
  const senders = input.senders ?? (yield* sendersOf(orgId));
  const reader = yield* BankAlertReader.BankAlertReader;
  const retryable = canRetryAlert(sql, input.now);
  const seenAlert = (alertId: string) =>
    sql<{ retry: number | null }>`SELECT
      (${retryable} AND thread_id = ${input.threadId}) AS retry FROM kin_bank_alerts
    WHERE org_id = ${orgId} AND alert_id = ${alertId}`.pipe(Effect.map((rows) => rows[0]));
  const skip = (seen: { retry: number | null } | undefined) =>
    seen === undefined ? input.retryOnly === true : seen.retry !== 1;
  const currency = (yield* findBankList(orgId))?.currency ?? (yield* homeCurrency(orgId));
  const reads = new Map<
    string,
    {
      message: AlertMessage;
      address: string | undefined;
      sender: ApprovedSender | undefined;
      reading: AlertReading;
    }
  >();
  for (const message of input.messages) {
    const sentAt = message.date === null ? Number.NaN : Date.parse(message.date);
    if (sentAt < input.now - ALERT_RETRY_WINDOW) continue;
    const alertId = alertIdOf(input.connectionId, input.threadId, message);
    if (reads.has(alertId) || skip(yield* seenAlert(alertId))) continue;
    const address = normalizeAddress(message.fromAddress);
    const sender = address === undefined ? undefined : senders.get(address);
    const reading =
      address === undefined || sender === undefined
        ? ({ _tag: "rejected", reason: "sender" } as const)
        : yield* readApprovedAlert(message, address, sender.accounts, currency, reader);
    reads.set(alertId, { message, address, sender, reading });
  }
  if (reads.size === 0 && !input.recheckedThread) return tally satisfies AlertTally;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* bankAlertMailbox(orgId, input.connectionId))) return;
      const current = yield* sendersOf(orgId);
      for (const [alertId, { message, address, sender, reading }] of reads) {
        const seen = yield* seenAlert(alertId);
        if (skip(seen)) continue;
        const authorized = address === undefined ? undefined : current.get(address);
        const revoked =
          sender !== undefined &&
          (authorized?.bankKey !== sender.bankKey || authorized.bankName !== sender.bankName);
        const refusal = revoked
          ? "sender"
          : reading._tag === "rejected"
            ? reading.reason
            : authorized?.accounts.includes(reading.alert.account) !== true
              ? "other_account"
              : undefined;
        const parsedTime = message.date === null ? Number.NaN : Date.parse(message.date);
        const identity = {
          sender_address: address ?? null,
          sent_at: Number.isFinite(parsedTime) ? parsedTime : null,
        };
        const result = yield* Effect.gen(function* () {
          if (refusal !== undefined || reading._tag !== "alert" || authorized === undefined) {
            const outcome = refusal ?? "sender";
            if (outcome !== "sender") tally.rejected++;
            return {
              ...identity,
              outcome,
              reference: outcome === "unparsed" ? PARSER_MARKER : null,
            };
          }
          const { alert } = reading;
          const done = yield* recordAlert(
            orgId,
            KinPersonId.make(owner),
            authorized,
            alert,
            input.now,
          );
          tally[done.outcome]++;
          return {
            ...identity,
            sent_at: alert.sentAt,
            outcome: done.outcome,
            bank: authorized.bankName,
            account: alert.account,
            reference: alert.reference,
            record_id: done.recordId,
            currency: alert.currency,
            balance_minor: alert.balanceMinor,
          };
        });
        if (seen !== undefined) {
          yield* sql`UPDATE kin_bank_alerts SET ${sql.update(result)}
            WHERE org_id = ${orgId} AND alert_id = ${alertId}`;
        } else {
          yield* sql`INSERT INTO kin_bank_alerts ${sql.insert({
            org_id: orgId,
            alert_id: alertId,
            connection_id: input.connectionId,
            thread_id: input.threadId,
            seen_at: input.now,
            ...result,
          })}`;
        }
      }
      if (input.recheckedThread) {
        yield* sql`UPDATE kin_bank_alerts SET reference = ${PARSER_MARKER}
          WHERE org_id = ${orgId} AND connection_id = ${input.connectionId}
            AND thread_id = ${input.threadId} AND ${retryable}`;
      }
    }),
  );
  return tally satisfies AlertTally;
});

export interface AlertBalance {
  readonly bank: string;
  readonly account: string;
  readonly currency: string;
  readonly balanceMinor: number;
  readonly sentAt: number;
}

/** Per account, the available balance of the newest alert that printed one. */
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

/** An account Money shows, as far as an alert can be matched to it. */
interface CashAccount {
  readonly kind: "account" | "card";
  readonly bank: string | null;
  readonly digits: string | null;
  readonly currency: string;
  /** The day of the statement balance it shows. */
  readonly on: string;
}

/**
 * Each alert balance beside the one statement account it is (same digits and currency, the same
 * bank or none named), when it is from after that balance's day; else on its own. One that
 * could be two accounts' is on its own, so it is never shown as either's.
 */
export const alertsBeside = Effect.fn("KinBankAlerts.beside")(function* <A extends CashAccount>(
  orgId: KinOrgId,
  accounts: ReadonlyArray<A>,
) {
  const zone = yield* ownerZone(orgId);
  const beside = new Map<A, AlertBalance>();
  const alone: Array<AlertBalance> = [];
  for (const balance of yield* alertBalances(orgId)) {
    const fits = accounts.filter(
      (one) =>
        one.kind === "account" &&
        one.currency === balance.currency &&
        one.digits === balance.account &&
        (one.bank === null || one.bank.toLowerCase() === balance.bank.toLowerCase()),
    );
    if (fits.length !== 1) alone.push(balance);
    else if (dayIn(balance.sentAt, zone) > fits[0]!.on) beside.set(fits[0]!, balance);
  }
  return { beside, alone };
});

/** An alert's entry a statement of its account and days doesn't have. */
export interface AlertGap {
  readonly key: string;
  readonly date: string;
  readonly amountMinor: number;
  readonly direction: "debit" | "credit" | null;
}

/** How a statement and the bank alerts of its account and days agree, for its review card. */
export interface AlertCheck {
  /** Rows that are an alert's entry already: one entry, not two. */
  readonly merged: number;
  readonly notOnStatement: ReadonlyArray<AlertGap>;
  /** Rows from the first alert's day on that no alert has. */
  readonly notInAlerts: number;
  readonly alertsSince: string;
}

/**
 * The alerts of a statement's account against its rows: which rows are alerts' entries, which
 * alerts of its days it doesn't have, and which of its rows since alerts began no alert has. None
 * for a bank Kin reads no alerts of, a card's statement, or one without its last four digits.
 */
export const alertCheck = Effect.fn("KinBankAlerts.check")(function* (
  orgId: KinOrgId,
  listId: string | undefined,
  statement: Statement,
  known: ReadonlyMap<number, { readonly recordId: string }>,
) {
  const { bank, account } = statement;
  if (
    listId === undefined ||
    statement.kind !== "account" ||
    account === null ||
    !/^\d{4}$/.test(account) ||
    statement.rows.length === 0
  )
    return undefined;
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const entries = yield* sql<{
    recordId: string;
    bank: string;
    key: string;
    amountMinor: number;
    currency: string | null;
    dateAt: number;
    fieldsJson: string;
  }>`SELECT r.record_id AS "recordId", a.bank, r.key,
      r.amount_minor AS "amountMinor", r.currency, r.date_at AS "dateAt", r.fields_json AS "fieldsJson"
    FROM kin_records r JOIN kin_bank_alerts a ON a.org_id = r.org_id
      AND a.record_id = r.record_id AND a.outcome = 'recorded'
    WHERE r.org_id = ${orgId} AND r.register_id = ${listId} AND a.account = ${account}
      AND r.origin_key LIKE 'alert:%' AND r.date_at IS NOT NULL
    ORDER BY r.date_at, r.key`;
  const mine = entries
    .filter(
      (one) =>
        (bank === null || one.bank.toLowerCase() === bank.toLowerCase()) &&
        (one.currency ?? statement.currency) === statement.currency,
    )
    .map((one) => ({ ...one, date: dayIn(one.dateAt, zone) }));
  if (mine.length === 0) return undefined;
  const days = statement.rows.map((row) => row.date).toSorted();
  const from = statement.from ?? days[0]!;
  const to = statement.to ?? days.at(-1)!;
  const rowsOf = new Set([...known.values()].map((one) => one.recordId));
  const alertIds = new Set(mine.map((one) => one.recordId));
  const alertsSince = mine[0]!.date;
  const notOnStatement = mine
    .filter((one) => one.date >= from && one.date <= to && !rowsOf.has(one.recordId))
    .map((one) => ({
      key: one.key,
      date: one.date,
      amountMinor: one.amountMinor,
      direction: directionOf(parseFields(one.fieldsJson)),
    }));
  const notInAlerts = statement.rows.filter((row) => {
    const entry = known.get(row.index);
    return row.date >= alertsSince && (entry === undefined || !alertIds.has(entry.recordId));
  }).length;
  const merged = [...known.values()].filter((one) => alertIds.has(one.recordId)).length;
  if (merged === 0 && notOnStatement.length === 0 && notInAlerts === 0) return undefined;
  return { merged, notOnStatement, notInAlerts, alertsSince } satisfies AlertCheck;
});

import { formatKinMoney, formatKinWhen, KIN_TEXT_LOCALE, KinRecordId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { dayIn, formatMoneyPlain, monthOf, shiftMonth } from "../../work/money.ts";
import { endOfDay, owedInvoices, recordName, startOfDay } from "../../work/recordRows.ts";
import { bankKnown, shortDay } from "../../work/statements/bankKnown.ts";
import { repaidMatches } from "../../work/statements/debitRepaid.ts";
import {
  type CreditMatch,
  type CreditPair,
  creditMatches,
  pairReason,
} from "../../work/statements/invoiceCredits.ts";
import { DAY_MS, threshold } from "../thresholds.ts";
import {
  agentOrOwner,
  entryColumns,
  entryJoins,
  entryScope,
  entrySubject,
  type EntryRow,
  iso,
  type SenseContext,
  type SensedFact,
} from "./shared.ts";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const shiftDay = (day: string, days: number) =>
  DateTime.formatIsoDate(DateTime.makeUnsafe(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
const lastDayOf = (month: string) => shiftDay(`${shiftMonth(month, 1)}-01`, -1);

export const UNREADABLE_BANK_ALERTS_KEY = "bank_alerts_unreadable";

export const unreadableBankAlerts = Effect.fn("KinPulse.unreadableBankAlerts")(function* (
  ctx: Pick<SenseContext, "orgId" | "at" | "zone">,
  finance?: SenseContext["finance"],
) {
  const sql = yield* SqlClient.SqlClient;
  const [alerts] = yield* sql<{ count: number; first: number; last: number }>`SELECT
    COUNT(*) AS count, MIN(sent_at) AS first, MAX(sent_at) AS last
    FROM kin_bank_alerts WHERE org_id = ${ctx.orgId} AND outcome = 'unparsed'
      AND sent_at BETWEEN ${ctx.at - 14 * DAY_MS} AND ${ctx.at}
    HAVING COUNT(*) > 0`;
  if (alerts === undefined) return undefined;
  const when = (ms: number) =>
    formatKinWhen(ms, "day", { zone: ctx.zone, locale: KIN_TEXT_LOCALE });
  const first = when(alerts.first);
  const last = when(alerts.last);
  const { count } = alerts;
  const sent = first === last ? first : `between ${first} and ${last}`;
  return {
    sense: UNREADABLE_BANK_ALERTS_KEY,
    family: "money",
    key: UNREADABLE_BANK_ALERTS_KEY,
    subject: {
      kind: "bank",
      key: "bank-alerts",
      title: `${count} bank alert${count === 1 ? "" : "s"} could not be read`,
    },
    scope: {},
    since: iso(alerts.first),
    measure: { value: count, unit: "count", threshold: 1, from: { _tag: "default" } },
    consequence: `Sent ${sent}. Money may have arrived that is not in Bank transactions. Open the mail to see the amount; it can be recorded by hand.`,
    actor: agentOrOwner(finance),
    sensitive: true,
    wake: "brief",
  } satisfies SensedFact;
});

/**
 * statement_missing: the month after the day Kin sees the bank to ended more than the playbook's
 * days ago, and no confirmed statement covers it. Only once a company has confirmed one: before
 * that Money says Kin can't see the bank. One fact per month, so it is told once.
 */
export const statementSenses = Effect.fn("KinPulse.statementSenses")(function* (ctx: SenseContext) {
  const { through, accounts } = yield* bankKnown(ctx.orgId, ctx.at);
  if (through === null) return [];
  // With several accounts, the line names the one whose statement is waited on.
  const behind = accounts.filter((one) => one.keptUp && one.through === through);
  const whose = accounts.length > 1 && behind.length === 1 ? ` for ${behind[0]!.label}` : "";
  const month = monthOf(shiftDay(through, 1));
  const last = lastDayOf(month);
  const due = yield* threshold(ctx.orgId, "statement_due_days");
  const shownFrom = shiftDay(last, due.value + 1);
  if (dayIn(ctx.at, ctx.zone) < shownFrom) return [];
  const monthEnd = endOfDay(last, ctx.zone);
  const waiting = (yield* owedInvoices({ orgId: ctx.orgId, now: ctx.at })).filter(
    (one) => one.dueAt !== null && one.dueAt <= monthEnd,
  ).length;
  const name = `${MONTHS[Number(month.slice(5, 7)) - 1]}${
    month.slice(0, 4) === dayIn(ctx.at, ctx.zone).slice(0, 4) ? "" : ` ${month.slice(0, 4)}`
  }`;
  const fact: SensedFact = {
    sense: "statement_missing",
    family: "money",
    key: `statement_missing:${month}`,
    subject: { kind: "bank", key: `statement:${month}`, title: "Bank statement" },
    scope: {},
    since: iso(startOfDay(shownFrom, ctx.zone)),
    consequence: `${name}'s statement${whose} isn't in yet${
      waiting === 0
        ? "."
        : `: ${waiting === 1 ? "1 invoice" : `${waiting} invoices`} can't be confirmed until it is.`
    }`,
    actor: agentOrOwner(ctx.finance),
    sensitive: true,
    wake: "brief",
  };
  return [fact];
});

const CONSEQUENCE_MAX = 500;
const plain = (minor: number, currency: string) => formatMoneyPlain({ minor, currency });
const creditText = (credit: CreditMatch["credit"]) =>
  `${credit.key}, ${plain(credit.amountMinor, credit.currency)} received ${shortDay(credit.date)}`;
const invoiceText = (pair: CreditPair) =>
  `${recordName(pair.invoice.key, pair.invoice.number)}: ${pairReason(pair)}`;

/** The most items that fit in a consequence, the rest counted. */
const fitted = (build: (shown: number) => string, count: number) => {
  for (let shown = count; shown > 0; shown--) {
    const text = build(shown);
    if (text.length <= CONSEQUENCE_MAX) return text;
  }
  return build(0);
};
const listed = (items: ReadonlyArray<string>, shown: number) =>
  `${items.slice(0, shown).join("; ")}${items.length > shown ? `${shown > 0 ? "; " : ""}and ${items.length - shown} more` : ""}`;

/**
 * payment_seen: one fact per unexplained credit the matcher offers as an open invoice's payment,
 * so a mark holds whatever invoices come and go. About the invoice ranked first alone, else the
 * credit itself with no client; a credit that may be money already recorded is not raised.
 */
export const paymentSeenSenses = Effect.fn("KinPulse.paymentSeenSenses")(function* (
  ctx: SenseContext,
) {
  const matches = (yield* creditMatches(ctx.orgId)).filter((one) => one.recorded === undefined);
  if (matches.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const ids = [
    ...new Set(
      matches.flatMap((one) => (one.first.length === 1 ? [one.first[0]!.invoice.recordId] : [])),
    ),
  ];
  const rows = new Map(
    ids.length === 0
      ? []
      : (yield* sql<EntryRow>`SELECT ${entryColumns(sql)} FROM ${entryJoins(sql)}
          WHERE r.org_id = ${ctx.orgId} AND r.record_id IN ${sql.in(ids)}
          ORDER BY r.key`).map((row) => [row.recordId, row]),
  );
  return matches.flatMap(({ credit, ranked, first }): Array<SensedFact> => {
    const shared = {
      sense: "payment_seen" as const,
      family: "money" as const,
      key: `payment_seen:${credit.key}`,
      since: iso(Math.min(credit.dateAt, ctx.at)),
      actor: agentOrOwner(ctx.finance),
      sensitive: true,
      wake: "now" as const,
      // Bank transactions lives in Money: with Money off, nothing about it is told.
      extraSection: "money" as const,
    };
    if (first.length > 1)
      return [
        {
          ...shared,
          subject: {
            kind: "record",
            key: credit.key,
            title: "Bank credit",
            recordId: KinRecordId.make(credit.recordId),
          },
          scope: {},
          consequence: fitted(
            (shown) =>
              `${creditText(credit)}, fits ${first.length} open invoices equally, and Kin can't tell which: ${listed(first.map(invoiceText), shown)}. Nothing is recorded until the owner says which.`,
            first.length,
          ),
        },
      ];
    const best = first[0]!;
    const row = rows.get(best.invoice.recordId);
    if (row === undefined) return [];
    const others = ranked.slice(1).map(invoiceText);
    const alongside = matches
      .filter(
        (one) =>
          one.credit.recordId !== credit.recordId &&
          one.first.some((pair) => pair.invoice.recordId === best.invoice.recordId),
      )
      .map(
        (one) =>
          `${one.credit.key} (${plain(one.credit.amountMinor, one.credit.currency)}, ${shortDay(one.credit.date)})`,
      );
    return [
      {
        ...shared,
        subject: entrySubject(row),
        scope: entryScope(row),
        consequence: fitted(
          (shown) =>
            `${creditText(credit)}, looks like this invoice's payment: ${pairReason(best)}.${
              others.length === 0
                ? ""
                : ` It also fits, less closely: ${listed(others, Math.min(shown, others.length))}.`
            }${
              alongside.length === 0
                ? ""
                : ` ${listed(alongside, Math.min(shown, alongside.length))} ${alongside.length === 1 ? "fits" : "fit"} this invoice as well.`
            } It isn't recorded as paid until the owner confirms.`,
          Math.max(others.length, alongside.length),
        ),
      },
    ];
  });
});

/** Keys as a person writes them, "EXP-4, EXP-7 and EXP-9", the rest counted past `shown`. */
const keysOf = (keys: ReadonlyArray<string>, shown: number) =>
  shown < keys.length
    ? `${keys.slice(0, shown).join(", ")} and ${keys.length - shown} more`
    : keys.length === 1
      ? keys[0]!
      : `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`;

/**
 * repaid_seen: one fact per unexplained debit that names one partner the company owes. One that
 * adds up exactly to their oldest owed expenses wakes Finance, which may offer the owner a card
 * that marks them repaid; one that doesn't is a line in the brief, and Kin marks nothing. A
 * debit matching a repayment already marked by hand that day is not raised.
 */
export const repaidSeenSenses = Effect.fn("KinPulse.repaidSeenSenses")(function* (
  ctx: SenseContext,
) {
  const matches = (yield* repaidMatches(ctx.orgId)).filter(
    (one) => one.marked === undefined && !one.noLine && !one.setBack,
  );
  return matches.map(({ debit, partner, repays, owedMinor, owedCount }): SensedFact => {
    const paid = `${debit.key}, ${plain(debit.amountMinor, debit.currency)} paid ${shortDay(debit.date)}, names ${partner.name}`;
    const shared = {
      sense: "repaid_seen" as const,
      family: "money" as const,
      subject: {
        kind: "record" as const,
        key: debit.key,
        title: "Bank debit",
        recordId: KinRecordId.make(debit.recordId),
      },
      scope: {},
      since: iso(Math.min(debit.dateAt, ctx.at)),
      actor: agentOrOwner(ctx.finance),
      sensitive: true,
      // Bank transactions lives in Money: with Money off, nothing about it is told.
      extraSection: "money" as const,
    };
    if (repays === undefined)
      return {
        ...shared,
        key: `repaid_seen:${debit.key}:short`,
        consequence: `${paid} but doesn't add up to their oldest owed expenses (${formatKinMoney(owedMinor, debit.currency)} over ${owedCount} expense${owedCount === 1 ? "" : "s"}), so Kin marks nothing. Mark what it repaid on the expenses in Money.`,
        wake: "brief",
      };
    const one = repays.length === 1;
    return {
      ...shared,
      key: `repaid_seen:${debit.key}`,
      consequence: fitted(
        (shown) =>
          `${paid} and adds up exactly to their ${one ? "oldest owed expense" : `${repays.length} oldest owed expenses`}: ${keysOf(
            repays.map((each) => each.key),
            Math.max(shown, 1),
          )}. ${one ? "It isn't" : "They aren't"} marked repaid until the owner confirms.`,
        repays.length,
      ),
      wake: "now",
    };
  });
});

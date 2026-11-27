import { formatKinMoney, formatKinWhen, KIN_TEXT_LOCALE, KinRecordId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { invoiceCandidates } from "../../work/statements/statementReview.ts";
import { dayIn, formatMoney, formatMoneyPlain, monthOf, shiftMonth } from "../../work/money.ts";
import { endOfDay, owedInvoices, recordName, startOfDay } from "../../work/recordRows.ts";
import { bankKnown, shortDay } from "../../work/statements/bankKnown.ts";
import { billMatches, billPaidFactKey } from "../../work/statements/debitBill.ts";
import { repaidMatches } from "../../work/statements/debitRepaid.ts";
import {
  type CreditMatch,
  type CreditPair,
  creditMatches,
  pairReason,
  rateMoney,
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

/** repaid_seen's line for a partner debit that may not match their oldest owed expenses. */
export const repaidShortLine = (input: {
  readonly key: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly date: string;
  readonly partner: string;
  readonly owedMinor: number | bigint;
  readonly owedCount: number;
}) =>
  `${input.key}, ${plain(input.amountMinor, input.currency)} paid ${shortDay(input.date)}, names ${input.partner} and may not match their oldest owed expenses (${formatKinMoney(input.owedMinor, input.currency)} over ${input.owedCount} expense${input.owedCount === 1 ? "" : "s"}): not checked, so Kin marks nothing. Mark what it repaid on the expenses in Money.`;
const creditText = (credit: CreditMatch["credit"]) =>
  `${credit.key}, ${plain(credit.amountMinor, credit.currency)} received ${shortDay(credit.date)}`;
const creditMatchText = (pair: CreditPair) =>
  "rate" in pair
    ? `${pair.credit.key}, ${rateMoney(pair.received)} received ${shortDay(pair.credit.date)}`
    : creditText(pair.credit);
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
const listed = (items: ReadonlyArray<string>, shown: number, total = items.length) =>
  `${items.slice(0, shown).join("; ")}${total > shown ? `${shown > 0 ? "; " : ""}and ${total - shown} more` : ""}`;

export const overpaymentConsequence = (input: {
  readonly key: string;
  readonly day: string;
  readonly currency: string;
  readonly received: number;
  readonly owed: number;
  readonly client: string;
  readonly reason: string;
  readonly others: ReadonlyArray<{ readonly key: string; readonly owed: number }>;
}) => {
  const { key, day, currency, received, owed, client, reason } = input;
  const amount = (minor: number) => formatMoney({ minor, currency });
  const others = input.others.map((one) => `${one.key} (${amount(one.owed)})`);
  return fitted(
    (shown) =>
      `${key}, ${amount(received)} received ${shortDay(day)}, is more than the ${amount(owed)} this invoice owes: ${reason}. Once confirmed, it pays this invoice in full and keeps ${amount(received - owed)} as ${client}'s credit.${
        others.length === 0 ? "" : ` ${client}'s other open invoices: ${listed(others, shown)}.`
      } It isn't recorded until it is confirmed on a card.`,
    Math.min(4, others.length),
  );
};

/**
 * payment_seen: one fact per unexplained credit offered as a payment or needing an invoice choice,
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
  const invoices = matches.some((one) => one.first.some((pair) => pair.candidate.fit === "over"))
    ? yield* invoiceCandidates(ctx.orgId, undefined)
    : [];
  // A declined choice belongs to the bank row even if a later match is an ordinary offer.
  const declined = new Set(
    (yield* sql<{ recordId: string }>`SELECT json_extract(p.plan_json, '$.recordId') AS "recordId"
      FROM kin_card_plans p JOIN kin_widgets w ON w.org_id = p.org_id AND w.widget_id = p.widget_id
      WHERE p.org_id = ${ctx.orgId} AND p.ran_message_id IS NOT NULL
        AND json_extract(p.plan_json, '$.kind') = 'invoice_choice'
        AND json_type(p.plan_json, '$.payment') = 'null'
        AND json_type(w.state_json, '$.outcome') IS NULL
      ORDER BY p.widget_id, p.option_id`).map((row) => row.recordId),
  );
  return matches.flatMap(({ credit, ranked, first, choice }): Array<SensedFact> => {
    if (declined.has(credit.recordId)) return [];
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
    if (choice !== undefined) {
      const { client, options, total } = choice;
      const items = options.map(
        ({ invoice, owed }) =>
          `${recordName(invoice.key, invoice.number)} (${plain(owed.minor, owed.currency)} owed)`,
      );
      const consequence = fitted(
        (shown) =>
          `${creditText(credit)}, names ${client} but none of ${client}'s open invoices in other currencies, and no recent rate the company was paid at is close to the one it would imply, so Kin can't tell which it pays: ${listed(items, shown, total)}. Nothing is recorded until an owner or co-owner picks one.`,
        items.length,
      );
      if (consequence.length > CONSEQUENCE_MAX) return [];
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
          consequence,
          wake: "brief",
          paymentChoice: { credit, choice },
        },
      ];
    }
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
              `${creditText(credit)}, fits ${first.length} open invoices equally, and Kin can't tell which: ${listed(first.map(invoiceText), shown)}. Nothing is recorded until one is chosen on a card.`,
            first.length,
          ),
        },
      ];
    const best = first[0]!;
    const row = rows.get(best.invoice.recordId);
    if (row === undefined) return [];
    if (
      best.candidate.fit === "over" &&
      best.invoice.client !== null &&
      best.invoice.clientId != null
    ) {
      const { invoice } = best;
      const others = invoices
        .filter(
          (one) =>
            one.clientId === invoice.clientId &&
            one.recordId !== invoice.recordId &&
            one.currency === credit.currency &&
            one.amountMinor > one.paidMinor &&
            one.issued !== null,
        )
        .map((one) => ({ key: one.key, owed: one.amountMinor - one.paidMinor }));
      return [
        {
          ...shared,
          subject: entrySubject(row),
          scope: entryScope(row),
          consequence: overpaymentConsequence({
            key: credit.key,
            day: credit.date,
            currency: credit.currency,
            received: credit.amountMinor,
            owed: invoice.amountMinor - invoice.paidMinor,
            client: best.invoice.client,
            reason: pairReason(best),
            others,
          }),
        },
      ];
    }
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
            `${creditMatchText(best)}, looks like this invoice's payment: ${pairReason(best)}.${
              others.length === 0
                ? ""
                : ` It also fits, less closely: ${listed(others, Math.min(shown, others.length))}.`
            }${
              alongside.length === 0
                ? ""
                : ` ${listed(alongside, Math.min(shown, alongside.length))} ${alongside.length === 1 ? "could also be" : "could each also be"} this invoice's payment.`
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
  const matches = (yield* repaidMatches(ctx.orgId, ctx.at)).filter(
    (one) => one.marked === undefined && !one.noLine && !one.setBack && !one.ahead,
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
        consequence: repaidShortLine({
          key: debit.key,
          amountMinor: debit.amountMinor,
          currency: debit.currency,
          date: debit.date,
          partner: partner.name,
          owedMinor,
          owedCount,
        }),
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
          )}. ${one ? "It isn't" : "They aren't"} marked repaid until it is confirmed on a card.`,
        repays.length,
      ),
      wake: "now",
    };
  });
});

export const billPaidConsequence = (
  bankKey: string,
  amount: string,
  day: string,
  billKey: string,
  vendor: string,
  due: string,
) =>
  `${bankKey}, ${amount} paid ${day}, matches ${billKey}, the bill to pay ${vendor} due ${due}. It isn't marked paid until it is confirmed on a card.`;

export const billPaidSeenSenses = Effect.fn("KinPulse.billPaidSeenSenses")(function* (
  ctx: SenseContext,
) {
  const matches = yield* billMatches(ctx.orgId, ctx.at);
  return matches.map(({ debit, bill }): SensedFact => ({
    sense: "bill_paid_seen",
    family: "money",
    key: billPaidFactKey(debit.key),
    subject: {
      kind: "record",
      key: debit.key,
      title: "Bank debit",
      recordId: KinRecordId.make(debit.recordId),
    },
    scope: {},
    since: iso(Math.min(debit.dateAt, ctx.at)),
    consequence: billPaidConsequence(
      debit.key,
      plain(debit.amountMinor, debit.currency),
      shortDay(debit.date),
      bill.key,
      (bill.vendor ?? bill.title).slice(0, 200),
      bill.due === null ? "No date" : shortDay(bill.due),
    ),
    actor: agentOrOwner(ctx.finance),
    sensitive: true,
    wake: "now",
    extraSection: "money",
  }));
});

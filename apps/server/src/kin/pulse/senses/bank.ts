import { formatKinWhen, KIN_TEXT_LOCALE } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { dayIn, formatMoneyPlain, monthOf, shiftMonth } from "../../work/money.ts";
import { endOfDay, owedInvoices, startOfDay } from "../../work/recordRows.ts";
import { bankKnown, shortDay } from "../../work/statements/bankKnown.ts";
import { type CreditPair, creditMatches } from "../../work/statements/invoiceCredits.ts";
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
const KEY_MAX = 300;
const creditText = (pair: CreditPair) =>
  `${pair.credit.key}, ${formatMoneyPlain({ minor: pair.credit.amountMinor, currency: pair.credit.currency })} received ${shortDay(pair.credit.date)}`;
const pairText = (pair: CreditPair) =>
  `${pair.credit.key} (${formatMoneyPlain({ minor: pair.credit.amountMinor, currency: pair.credit.currency })}, ${shortDay(pair.credit.date)}) for ${pair.invoice.key}: ${pair.reason}`;

/** The most pairs that fit in a consequence, the rest counted. */
const fitted = (lead: string, pairs: ReadonlyArray<CreditPair>, tail: string) => {
  for (let shown = pairs.length; shown > 0; shown--) {
    const more = pairs.length - shown;
    const text = `${lead}${pairs
      .slice(0, shown)
      .map(pairText)
      .join("; ")}${more === 0 ? "" : `; and ${more} more`}.${tail}`;
    if (text.length <= CONSEQUENCE_MAX) return text;
  }
  return `${lead}${pairs.length} pairs.${tail}`;
};

/**
 * payment_seen: an unexplained credit in Bank transactions that the statement matcher offers as an
 * open invoice's payment, about that invoice. Credits and invoices that fit each other are one
 * fact, keyed by every pair, so a new pair is told again with all of them; Kin records nothing.
 */
export const paymentSeenSenses = Effect.fn("KinPulse.paymentSeenSenses")(function* (
  ctx: SenseContext,
) {
  const groups = yield* creditMatches(ctx.orgId);
  if (groups.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const ids = [...new Set(groups.map((group) => group.pairs[0]!.invoice.recordId))];
  const rows = new Map(
    (yield* sql<EntryRow>`SELECT ${entryColumns(sql)} FROM ${entryJoins(sql)}
      WHERE r.org_id = ${ctx.orgId} AND r.record_id IN ${sql.in(ids)}
      ORDER BY r.key`).map((row) => [row.recordId, row]),
  );
  return groups.flatMap(({ pairs, clear }): Array<SensedFact> => {
    const [first, ...rest] = pairs;
    const row = rows.get(first!.invoice.recordId);
    if (row === undefined) return [];
    const tail = clear
      ? " It isn't recorded as paid until the owner confirms."
      : " Nothing is recorded until the owner says which.";
    const consequence = clear
      ? rest.length === 0
        ? `${creditText(first!)}, looks like this invoice's payment: ${first!.reason}.${tail}`
        : fitted(
            `${creditText(first!)}, looks like this invoice's payment: ${first!.reason}. It also fits, less closely: `,
            rest,
            tail,
          )
      : fitted("More than one fits, and Kin can't tell which: ", pairs, tail);
    let key = "payment_seen:";
    for (const pair of pairs) {
      const next = `${key === "payment_seen:" ? "" : ","}${pair.credit.key}>${pair.invoice.key}`;
      if (key.length + next.length > KEY_MAX) break;
      key += next;
    }
    return [
      {
        sense: "payment_seen",
        family: "money",
        key,
        subject: entrySubject(row),
        scope: entryScope(row),
        since: iso(Math.min(first!.credit.dateAt, ctx.at)),
        consequence,
        actor: agentOrOwner(ctx.finance),
        sensitive: true,
        wake: "now",
        // Bank transactions lives in Money: with Money off, nothing about it is told.
        extraSection: "money",
      },
    ];
  });
});

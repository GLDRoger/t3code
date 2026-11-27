import {
  kinCurrency,
  type KinMoney,
  type KinOrgId,
  type KinPersonId,
  kinRateShown,
} from "@t3tools/contracts";
import { readOnly } from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { DAY_MS } from "../../durations.ts";
import { companyMoney } from "../companyProfile.ts";
import { parseFields } from "../lists.ts";
import { dayIn, formatMinor, formatMoney } from "../money.ts";
import { countedEntry, ownerZone } from "../recordRows.ts";
import { recordedRate } from "../recordedRate.ts";
import { regionOf } from "../region.ts";
import type { ListDef } from "../registers.ts";
import { BANK_CREDIT_ORIGIN, bankStates, directionOf, findBankList } from "./bankList.ts";
import {
  type InvoiceCandidate,
  citedNumber,
  invoiceOffer,
  levelWithBest,
  nameIn,
  paymentOffer,
  overOffer,
  rateCandidate,
  rateOffer,
} from "./statementMatch.ts";
import { invoiceCandidates, recordedPayments } from "./statementReview.ts";
import type { StatementRow } from "./statementTable.ts";

const SHOWN = 5;
// The newest this many unexplained entries are enough to find five.
const LOOKED_AT = 200;

/**
 * A Bank transactions entry Kin's own code or a person wrote, and no agent changed since: only
 * such an entry is the bank's word that money arrived (over `r`).
 */
const noAgentHand = (sql: SqlClient.SqlClient) => sql`r.created_by_kind <> 'agent'
  AND NOT EXISTS (SELECT 1 FROM kin_record_changes c WHERE c.org_id = r.org_id
    AND c.record_id = r.record_id AND c.actor_kind = 'agent' AND c.kind <> 'linked')`;

/** Whether an agent wrote this entry or changed it since, so Kin won't take it for money in. */
export const agentWrote = Effect.fn("KinStatements.agentWrote")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ clean: number }>`SELECT (${noAgentHand(sql)}) AS clean
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.record_id = ${recordId}`;
  return row !== undefined && row.clean !== 1;
});

/**
 * Unexplained entries one way in Bank transactions no agent wrote or changed, newest first, each
 * as the statement row the matcher reads: of one currency up to an amount, or one entry by id.
 */
export const openEntries = Effect.fn("KinStatements.openEntries")(function* (
  orgId: KinOrgId,
  def: ListDef,
  direction: "credit" | "debit",
  only:
    | { readonly currency: string; readonly maxMinor: number }
    | { readonly recordId: string }
    | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const currency = only !== undefined && "currency" in only ? only.currency : null;
  const maxMinor = only !== undefined && "maxMinor" in only ? only.maxMinor : null;
  const recordId = only !== undefined && "recordId" in only ? only.recordId : null;
  const readPage = (cursor?: { dateAt: number; recordId: string }) => sql<{
    recordId: string;
    key: string;
    title: string;
    rev: number;
    amountMinor: number;
    currency: string;
    dateAt: number;
    fieldsJson: string;
  }>`SELECT r.record_id AS "recordId", r.key, r.title, r.rev, r.amount_minor AS "amountMinor",
      COALESCE(r.currency, ${def.currency}) AS currency, r.date_at AS "dateAt",
      r.fields_json AS "fieldsJson"
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = ${def.id} AND r.state = ${bankStates(def).open}
      AND r.amount_minor > 0 AND r.date_at IS NOT NULL
      AND (${currency} IS NULL OR COALESCE(r.currency, ${def.currency}) = ${currency})
      AND (${maxMinor} IS NULL OR r.amount_minor <= ${maxMinor})
      AND (${recordId} IS NULL OR r.record_id = ${recordId})
      AND ${countedEntry(sql)} AND ${noAgentHand(sql)}
      ${cursor === undefined ? sql`` : sql`AND (r.date_at, r.record_id) < (${cursor.dateAt}, ${cursor.recordId})`}
    ORDER BY r.date_at DESC, r.record_id DESC
    LIMIT ${LOOKED_AT}`;
  const inDirection = (rows: Effect.Success<ReturnType<typeof readPage>>) =>
    rows.flatMap(({ fieldsJson, ...row }) => {
      const fields = parseFields(fieldsJson);
      if (directionOf(fields) !== direction) return [];
      const date = dayIn(row.dateAt, zone);
      const read: StatementRow = {
        index: 0,
        date,
        description: row.title,
        reference: typeof fields.reference === "string" ? fields.reference : null,
        amountMinor: row.amountMinor,
        direction,
        balanceMinor: null,
        foreign: null,
      };
      return [{ ...row, date, row: read }];
    });
  return yield* Effect.gen(function* () {
    let rows = yield* readPage();
    const entries = inDirection(rows);
    while (rows.length === LOOKED_AT && entries.length < LOOKED_AT) {
      rows = yield* readPage(rows.at(-1));
      entries.push(...inDirection(rows));
    }
    return entries.slice(0, LOOKED_AT);
  }).pipe(sql.withTransaction, readOnly);
});
type OpenCredit = Effect.Success<ReturnType<typeof openEntries>>[number];

/** Each credit's recorded rate for an invoice in another currency, read once per pair and day. */
const recordedRates = Effect.fn("KinStatements.recordedRates")(function* (
  orgId: KinOrgId,
  credits: ReadonlyArray<OpenCredit>,
  invoiceCurrencies: ReadonlyArray<string>,
) {
  const rates = new Map<string, string | undefined>();
  const keyOf = (credit: OpenCredit, currency: string) =>
    `${currency}>${credit.currency}@${credit.date}`;
  for (const credit of credits)
    for (const currency of new Set(invoiceCurrencies)) {
      if (currency === credit.currency || rates.has(keyOf(credit, currency))) continue;
      const asOf = Date.parse(`${credit.date}T12:00:00Z`);
      rates.set(
        keyOf(credit, currency),
        (yield* recordedRate(orgId, currency, credit.currency, asOf))?.rate,
      );
    }
  return (credit: OpenCredit, invoice: InvoiceCandidate) =>
    rates.get(keyOf(credit, invoice.currency));
});

const withholding = (orgId: KinOrgId) =>
  Effect.map(companyMoney(orgId), (money) => regionOf(money.country)?.withholdsAtSource === true);

/**
 * The unexplained credits in Bank transactions that a statement's review would offer as this
 * issued invoice's payment, newest first. Nothing is matched or recorded by reading them.
 */
export const invoiceCredits = Effect.fn("KinStatements.invoiceCredits")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const [invoice] = yield* invoiceCandidates(orgId, undefined, recordId);
  const owed = invoice === undefined ? 0 : invoice.amountMinor - invoice.paidMinor;
  const def = yield* findBankList(orgId);
  if (invoice === undefined || owed <= 0 || def === undefined) return [];
  const withholds = yield* withholding(orgId);
  const credits = yield* openEntries(orgId, def, "credit", {
    currency: invoice.currency,
    maxMinor: owed,
  });
  const other = (yield* openEntries(orgId, def, "credit", undefined)).filter(
    (credit) => credit.currency !== invoice.currency || credit.amountMinor > owed,
  );
  const takenBack = other.length === 0 ? undefined : (yield* takenBackPairs(orgId, recordId)).pairs;
  const recorded = yield* recordedRates(orgId, other, [invoice.currency]);
  return [...credits, ...other]
    .toSorted((a, b) => b.dateAt - a.dateAt || b.recordId.localeCompare(a.recordId))
    .flatMap((credit) => {
      if (takenBack?.has(`${credit.recordId}|${recordId}`) && credit.currency !== invoice.currency)
        return [];
      const pair = pairOf(credit, invoice, withholds, recorded(credit, invoice));
      return pair === undefined ||
        (pair.candidate.fit === "over" && takenBack?.has(`${credit.recordId}|${recordId}`))
        ? []
        : [
            {
              key: credit.key,
              date: credit.date,
              amount:
                "rate" in pair
                  ? rateMoney(pair.received)
                  : formatMinor(BigInt(credit.amountMinor), credit.currency),
              title: credit.title,
              reason: pair.reason,
            },
          ];
    })
    .slice(0, SHOWN);
});

export const rateMoney = (money: KinMoney) =>
  `${money.currency} ${formatMoney(money).slice(kinCurrency(money.currency).symbol.length)}`;

const pairOf = (
  credit: OpenCredit,
  invoice: InvoiceCandidate,
  withholds: boolean,
  recorded: string | undefined,
) => {
  if (invoice.currency === credit.currency) {
    const offer = invoiceOffer(credit.row, invoice, invoice.currency, withholds);
    if (offer !== undefined) return { credit, invoice, ...offer };
    const over = overOffer(credit.row, invoice, invoice.currency);
    if (over === undefined || invoice.clientId == null || invoice.client === null) return undefined;
    return {
      credit,
      invoice,
      ...over,
      reason: over.cited === undefined ? `it names ${invoice.client}` : `it cites ${over.cited}`,
    };
  }
  const offer = rateOffer(credit.row, invoice, credit.currency, recorded);
  if (offer === undefined) return undefined;
  const clue =
    offer.cited !== undefined
      ? `, and it cites ${offer.cited}`
      : offer.candidate.why.includes("client named") && invoice.client !== null
        ? ` from ${invoice.client}`
        : "";
  return {
    credit,
    invoice,
    ...offer,
    reason: `${rateMoney(offer.received)} for ${rateMoney(offer.owed)} owed, a rate of ${kinRateShown(offer.rate)}${clue}`,
  };
};
export type CreditPair = NonNullable<ReturnType<typeof pairOf>>;

/**
 * One credit as the statement matcher ranks it: the open invoices it may pay, best first, and
 * those level with the best (`first`). `recorded` is money already recorded on an invoice with no
 * bank row that the matcher ranks level with or above them: the credit may be that payment.
 */
type OpenInvoice = Effect.Success<ReturnType<typeof invoiceCandidates>>[number];
type RateChoice = NonNullable<ReturnType<typeof rateCandidate>> & {
  readonly invoice: OpenInvoice;
};
type SameChoice = {
  readonly invoice: OpenInvoice;
  readonly owed: KinMoney;
};

export type CreditMatch = {
  readonly credit: OpenCredit;
  readonly ranked: ReadonlyArray<CreditPair>;
  readonly first: ReadonlyArray<CreditPair>;
  readonly choice?: { readonly client: string; readonly round: number; readonly total: number } & (
    | { readonly kind: "rate"; readonly options: ReadonlyArray<RateChoice> }
    | {
        readonly kind: "same";
        readonly clientId: string;
        readonly options: ReadonlyArray<SameChoice>;
      }
  );
  readonly recorded: { readonly key: string; readonly paidOn: string } | undefined;
};

const choiceOrder = (
  a: { readonly invoice: OpenInvoice; readonly score: number },
  b: { readonly invoice: OpenInvoice; readonly score: number },
) =>
  b.score - a.score ||
  (b.invoice.issued ?? "").localeCompare(a.invoice.issued ?? "") ||
  a.invoice.key.localeCompare(b.invoice.key);

const sameCurrencyChoice = (
  credit: OpenCredit,
  invoices: ReadonlyArray<OpenInvoice>,
  ranked: ReadonlyArray<CreditPair>,
  round: number,
): Extract<NonNullable<CreditMatch["choice"]>, { kind: "same" }> | undefined => {
  if (!invoices.some((invoice) => invoice.currency === credit.currency)) return undefined;
  const nameScores = new Map<string, number>();
  const named = invoices.flatMap((invoice) => {
    if (
      invoice.clientId == null ||
      !invoice.client?.trim() ||
      invoice.issued === null ||
      invoice.issued > credit.date
    )
      return [];
    let score = nameScores.get(invoice.client);
    if (score === undefined) {
      score = nameIn(invoice.client, credit.row.description);
      nameScores.set(invoice.client, score);
    }
    return score < 0.5 ? [] : [{ invoice, score: 10 + Math.round(30 * score) }];
  });
  const options = named.filter(({ invoice }) => invoice.currency === credit.currency);
  const client = options[0]?.invoice;
  if (
    client?.client == null ||
    client.clientId == null ||
    named.some(({ invoice }) => invoice.clientId !== client.clientId)
  )
    return undefined;
  const matched = new Map(
    ranked.map(({ invoice, candidate }) => [invoice.recordId, candidate.score]),
  );
  return {
    kind: "same",
    client: client.client,
    clientId: client.clientId,
    options: options
      .map((one) => ({ ...one, score: matched.get(one.invoice.recordId) ?? one.score }))
      .toSorted(choiceOrder)
      .map(({ invoice }) => ({
        invoice,
        owed: { minor: invoice.amountMinor - invoice.paidMinor, currency: credit.currency },
      })),
    round,
    total: options.length,
  };
};

const takenBackPairs = Effect.fn("KinStatements.takenBackPairs")(function* (
  orgId: KinOrgId,
  recordId?: string,
) {
  // A pair whose card payment was taken back was the owner's no: never offered again.
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ recordId: string; originKey: string }>`SELECT record_id AS "recordId",
      origin_key AS "originKey" FROM kin_record_payments
    WHERE org_id = ${orgId} AND voided_at IS NOT NULL AND origin_key LIKE ${`${BANK_CREDIT_ORIGIN}%`}
      ${recordId === undefined ? sql`` : sql`AND record_id = ${recordId}`}
    ORDER BY payment_id`;
  const pairs = new Set<string>();
  const rounds = new Map<string, number>();
  for (const row of rows) {
    const [bankRecordId = ""] = row.originKey.slice(BANK_CREDIT_ORIGIN.length).split(":");
    pairs.add(`${bankRecordId}|${row.recordId}`);
    rounds.set(bankRecordId, (rounds.get(bankRecordId) ?? 0) + 1);
  }
  return { pairs, rounds };
});

export const INVOICE_CHOICE_RESOLVED = "Invoice choice resolved.";
const paymentFactKey = (credit: OpenCredit) => `payment_seen:${credit.key}`;

export const resolveInvoiceChoice = Effect.fn("KinStatements.resolveInvoiceChoice")(function* (
  orgId: KinOrgId,
  credit: OpenCredit,
  personId: KinPersonId,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  // A cleared chat deletes card plans. The bank decision lives on its pulse fact.
  yield* sql`INSERT INTO kin_pulse_facts (org_id, fact_key, sense, subject_record_id,
      scope_json, first_seen_at, last_seen_at, handled_by_kind, handled_by_id,
      handled_at, handled_note)
    VALUES (${orgId}, ${paymentFactKey(credit)}, 'payment_seen', ${credit.recordId},
      '{}', ${at}, ${at}, 'person', ${personId}, ${at}, ${INVOICE_CHOICE_RESOLVED})
    ON CONFLICT (org_id, fact_key) DO UPDATE SET handled_by_kind = excluded.handled_by_kind,
      handled_by_id = excluded.handled_by_id, handled_at = excluded.handled_at,
      handled_note = excluded.handled_note, handled_until = NULL`;
});

const rankAll = Effect.fn("KinStatements.rankCredits")(function* (
  orgId: KinOrgId,
  entries: ReadonlyArray<OpenCredit>,
) {
  if (entries.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const resolved = new Set(
    (yield* sql<{ key: string }>`SELECT fact_key AS key FROM kin_pulse_facts
      WHERE org_id = ${orgId} AND fact_key IN ${sql.in(entries.map(paymentFactKey))}
        AND handled_by_kind = 'person' AND handled_note = ${INVOICE_CHOICE_RESOLVED}
      ORDER BY fact_key`).map(({ key }) => key),
  );
  const credits = entries.filter((credit) => !resolved.has(paymentFactKey(credit)));
  if (credits.length === 0) return [];
  const invoices = (yield* invoiceCandidates(orgId, undefined)).filter(
    (one) => one.amountMinor - one.paidMinor > 0,
  );
  if (invoices.length === 0) return [];
  const withholds = yield* withholding(orgId);
  const earliest = credits.reduce(
    (day, one) => (one.date < day ? one.date : day),
    credits[0]!.date,
  );
  const payments = yield* recordedPayments(
    orgId,
    dayIn(Date.parse(`${earliest}T00:00:00Z`) - 15 * DAY_MS, "UTC"),
  );
  const { pairs: takenBack, rounds } = yield* takenBackPairs(orgId);
  const recorded = yield* recordedRates(
    orgId,
    credits,
    invoices.map((one) => one.currency),
  );
  let numbers: ReadonlyArray<Pick<InvoiceCandidate, "key" | "number">> | undefined;
  const matches: Array<CreditMatch> = [];
  for (const credit of credits) {
    const available = invoices.filter(
      (invoice) => !takenBack.has(`${credit.recordId}|${invoice.recordId}`),
    );
    const ranked = available
      .flatMap((invoice) => pairOf(credit, invoice, withholds, recorded(credit, invoice)) ?? [])
      .toSorted(
        (a, b) =>
          b.candidate.score - a.candidate.score || a.invoice.key.localeCompare(b.invoice.key),
      );
    const best = ranked[0];
    const round = rounds.get(credit.recordId) ?? 0;
    let choice: CreditMatch["choice"] =
      best?.candidate.fit === "rate" || ranked.some(({ candidate }) => candidate.fit === "exact")
        ? undefined
        : sameCurrencyChoice(credit, available, ranked, round);
    if (choice === undefined && best === undefined) {
      const options = available
        .flatMap((invoice) => {
          if (invoice.clientId == null || !invoice.client?.trim()) return [];
          const rate = rateCandidate(credit.row, invoice, credit.currency);
          return rate === undefined || rate.cited !== undefined
            ? []
            : [{ ...rate, invoice, score: rate.candidate.score }];
        })
        .toSorted(choiceOrder);
      const invoice = options[0]?.invoice;
      if (
        invoice?.client != null &&
        options.every((option) => option.invoice.clientId === invoice.clientId)
      )
        choice = {
          kind: "rate",
          client: invoice.client,
          options: options.slice(0, 4),
          round,
          total: options.length,
        };
    }
    if (choice !== undefined) {
      numbers ??= yield* sql<{ key: string; number: string | null }>`SELECT key,
      CASE WHEN json_type(fields_json, '$.number') = 'text'
        THEN json_extract(fields_json, '$.number') END AS number
      FROM kin_records WHERE org_id = ${orgId} AND register_id = 'invoices' ORDER BY key`;
      if (numbers.some((one) => citedNumber(credit.row, one) !== undefined)) choice = undefined;
    }
    if (best === undefined && choice === undefined) continue;
    const [rival] = payments
      .flatMap((payment) => {
        const { receivedMinor, receivedCurrency } = payment;
        const bankAmount =
          (best === undefined || choice !== undefined || best.candidate.fit === "rate") &&
          receivedMinor !== null &&
          receivedCurrency === credit.currency
            ? { ...payment, amountMinor: receivedMinor, currency: receivedCurrency }
            : payment;
        const offered = paymentOffer(credit.row, bankAmount, credit.currency);
        return offered === undefined ? [] : [{ payment, score: offered.score }];
      })
      .toSorted((a, b) => b.score - a.score);
    if (best !== undefined) {
      const outranked =
        rival !== undefined &&
        (rival.score >= best.candidate.score ||
          levelWithBest([best.candidate.score, rival.score], (score) => score).length === 2);
      matches.push({
        credit,
        ranked,
        first: levelWithBest(ranked, (one) => one.candidate.score),
        ...(rival === undefined && choice !== undefined ? { choice } : {}),
        recorded: outranked ? { key: rival.payment.key, paidOn: rival.payment.paidOn } : undefined,
      });
      continue;
    }
    if (rival !== undefined || choice === undefined) continue;
    matches.push({
      credit,
      ranked,
      first: [],
      recorded: undefined,
      choice,
    });
  }
  return matches;
});

/** Every unexplained credit the statement matcher offers as an open invoice's payment. */
export const creditMatches = Effect.fn("KinStatements.creditMatches")(function* (orgId: KinOrgId) {
  const def = yield* findBankList(orgId);
  if (def === undefined) return [];
  return yield* rankAll(orgId, yield* openEntries(orgId, def, "credit", undefined));
});

/** One credit as the matcher ranks it now; undefined when it is no unexplained credit it can use. */
export const creditMatch = Effect.fn("KinStatements.creditMatch")(function* (
  orgId: KinOrgId,
  bankRecordId: string,
) {
  const def = yield* findBankList(orgId);
  if (def === undefined) return undefined;
  const [match] = yield* rankAll(
    orgId,
    yield* openEntries(orgId, def, "credit", { recordId: bankRecordId }),
  );
  return match;
});

/**
 * Why the matcher offers a pair, in words that hold in any country: the matcher's own phrase,
 * with tax a client withheld named as such, and a part payment said even when the number is cited.
 */
export const pairReason = (pair: CreditPair) => {
  const { candidate, invoice, credit } = pair;
  if (candidate.fit === "tds" && candidate.tdsMinor !== undefined)
    return `the amount less ${formatMinor(BigInt(candidate.tdsMinor), credit.currency)} of tax the client withheld${
      candidate.why.includes("client named") && invoice.client !== null
        ? ` from ${invoice.client}`
        : ""
    }`;
  return candidate.fit === "part" && !pair.reason.includes("part of what is owed")
    ? `${pair.reason}, part of what is owed`
    : pair.reason;
};

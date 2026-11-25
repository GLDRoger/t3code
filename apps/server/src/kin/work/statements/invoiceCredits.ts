import type { KinOrgId } from "@t3tools/contracts";
import { readOnly } from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { DAY_MS } from "../../durations.ts";
import { companyMoney } from "../companyProfile.ts";
import { parseFields } from "../lists.ts";
import { dayIn, formatMinor } from "../money.ts";
import { countedEntry, ownerZone } from "../recordRows.ts";
import { regionOf } from "../region.ts";
import type { ListDef } from "../registers.ts";
import { BANK_CREDIT_ORIGIN, bankStates, directionOf, findBankList } from "./bankList.ts";
import {
  type InvoiceCandidate,
  invoiceOffer,
  levelWithBest,
  paymentOffer,
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
  return credits
    .flatMap((credit) => {
      const reason = invoiceOffer(credit.row, invoice, invoice.currency, withholds)?.reason;
      return reason === undefined
        ? []
        : [
            {
              key: credit.key,
              date: credit.date,
              amount: formatMinor(BigInt(credit.amountMinor), invoice.currency),
              title: credit.title,
              reason,
            },
          ];
    })
    .slice(0, SHOWN);
});

const pairOf = (credit: OpenCredit, invoice: InvoiceCandidate, withholds: boolean) => {
  if (invoice.currency !== credit.currency) return undefined;
  const offer = invoiceOffer(credit.row, invoice, invoice.currency, withholds);
  return offer === undefined ? undefined : { credit, invoice, ...offer };
};
export type CreditPair = NonNullable<ReturnType<typeof pairOf>>;

/**
 * One credit as the statement matcher ranks it: the open invoices it may pay, best first, and
 * those level with the best (`first`). `recorded` is money already recorded on an invoice with no
 * bank row that the matcher ranks level with or above them: the credit may be that payment.
 */
export type CreditMatch = {
  readonly credit: OpenCredit;
  readonly ranked: ReadonlyArray<CreditPair>;
  readonly first: ReadonlyArray<CreditPair>;
  readonly recorded: { readonly key: string; readonly paidOn: string } | undefined;
};

const rankAll = Effect.fn("KinStatements.rankCredits")(function* (
  orgId: KinOrgId,
  credits: ReadonlyArray<OpenCredit>,
) {
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
  // A pair whose card payment was taken back was the owner's no: never offered again.
  const sql = yield* SqlClient.SqlClient;
  const takenBack = new Set(
    (yield* sql<{ recordId: string; originKey: string }>`SELECT record_id AS "recordId",
        origin_key AS "originKey" FROM kin_record_payments
      WHERE org_id = ${orgId} AND voided_at IS NOT NULL AND origin_key LIKE ${`${BANK_CREDIT_ORIGIN}%`}
      ORDER BY payment_id`).map(
      (one) => `${one.originKey.slice(BANK_CREDIT_ORIGIN.length).split(":")[0]}|${one.recordId}`,
    ),
  );
  return credits.flatMap((credit): Array<CreditMatch> => {
    const ranked = invoices
      .filter((invoice) => !takenBack.has(`${credit.recordId}|${invoice.recordId}`))
      .flatMap((invoice) => pairOf(credit, invoice, withholds) ?? [])
      .toSorted(
        (a, b) =>
          b.candidate.score - a.candidate.score || a.invoice.key.localeCompare(b.invoice.key),
      );
    const best = ranked[0];
    if (best === undefined) return [];
    const [rival] = payments
      .flatMap((payment) => {
        const offered = paymentOffer(credit.row, payment, credit.currency);
        return offered === undefined ? [] : [{ payment, score: offered.score }];
      })
      .toSorted((a, b) => b.score - a.score);
    const outranked =
      rival !== undefined &&
      (rival.score >= best.candidate.score ||
        levelWithBest([best.candidate.score, rival.score], (score) => score).length === 2);
    return [
      {
        credit,
        ranked,
        first: levelWithBest(ranked, (one) => one.candidate.score),
        recorded: outranked ? { key: rival.payment.key, paidOn: rival.payment.paidOn } : undefined,
      },
    ];
  });
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

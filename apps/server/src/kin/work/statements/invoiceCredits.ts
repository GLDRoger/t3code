import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { companyMoney } from "../companyProfile.ts";
import { parseFields } from "../lists.ts";
import { dayIn, formatMinor } from "../money.ts";
import { countedEntry, ownerZone } from "../recordRows.ts";
import { regionOf } from "../region.ts";
import type { ListDef } from "../registers.ts";
import { bankStates, directionOf, findBankList } from "./bankList.ts";
import { clearlyFirst, type InvoiceCandidate, invoiceOffer } from "./statementMatch.ts";
import { invoiceCandidates } from "./statementReview.ts";
import type { StatementRow } from "./statementTable.ts";

const SHOWN = 5;
// The newest this many unexplained credits are enough to find five.
const LOOKED_AT = 200;

/**
 * Unexplained credits in Bank transactions, newest first, each as the statement row the matcher
 * reads: of one currency up to an amount, or one entry by id.
 */
const openCredits = Effect.fn("KinStatements.openCredits")(function* (
  orgId: KinOrgId,
  def: ListDef,
  only:
    | { readonly currency: string; readonly maxMinor: number }
    | { readonly recordId: string }
    | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const narrowed =
    only === undefined
      ? sql`1 = 1`
      : "recordId" in only
        ? sql`r.record_id = ${only.recordId}`
        : sql`COALESCE(r.currency, ${def.currency}) = ${only.currency}
          AND r.amount_minor <= ${only.maxMinor}`;
  const rows = yield* sql<{
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
      AND r.amount_minor > 0 AND r.date_at IS NOT NULL AND ${narrowed}
      AND ${countedEntry(sql)}
    ORDER BY r.date_at DESC, r.record_id DESC
    LIMIT ${LOOKED_AT}`;
  return rows.flatMap(({ fieldsJson, ...row }) => {
    const fields = parseFields(fieldsJson);
    if (directionOf(fields) !== "credit") return [];
    const date = dayIn(row.dateAt, zone);
    const read: StatementRow = {
      index: 0,
      date,
      description: row.title,
      reference: typeof fields.reference === "string" ? fields.reference : null,
      amountMinor: row.amountMinor,
      direction: "credit",
      balanceMinor: null,
      foreign: null,
    };
    return [{ ...row, date, row: read }];
  });
});
type OpenCredit = Effect.Success<ReturnType<typeof openCredits>>[number];

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
  const credits = yield* openCredits(orgId, def, {
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

/** One unexplained credit as an open invoice's payment, if the statement matcher offers it now. */
export const creditOffer = Effect.fn("KinStatements.creditOffer")(function* (
  orgId: KinOrgId,
  bankRecordId: string,
  invoiceRecordId: string,
) {
  const def = yield* findBankList(orgId);
  if (def === undefined) return undefined;
  const [credit] = yield* openCredits(orgId, def, { recordId: bankRecordId });
  const [invoice] = yield* invoiceCandidates(orgId, undefined, invoiceRecordId);
  if (credit === undefined || invoice === undefined) return undefined;
  return pairOf(credit, invoice, yield* withholding(orgId));
});

const byRank = (a: CreditPair, b: CreditPair) =>
  b.candidate.score - a.candidate.score ||
  b.credit.dateAt - a.credit.dateAt ||
  a.credit.key.localeCompare(b.credit.key) ||
  a.invoice.key.localeCompare(b.invoice.key);

/**
 * Every unexplained credit the statement matcher offers as an open invoice's payment, as groups of
 * pairs that share a credit or an invoice, best first. `clear` when the first pair is the answer on
 * the matcher's own terms, ahead of every other pair for its credit and for its invoice.
 */
export const creditMatches = Effect.fn("KinStatements.creditMatches")(function* (orgId: KinOrgId) {
  const def = yield* findBankList(orgId);
  if (def === undefined) return [];
  const invoices = (yield* invoiceCandidates(orgId, undefined)).filter(
    (one) => one.amountMinor - one.paidMinor > 0,
  );
  if (invoices.length === 0) return [];
  const withholds = yield* withholding(orgId);
  const pairs = (yield* openCredits(orgId, def, undefined)).flatMap((credit) =>
    invoices.flatMap((invoice) => pairOf(credit, invoice, withholds) ?? []),
  );
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    const up = parent.get(id) ?? id;
    return up === id ? id : root(up);
  };
  for (const pair of pairs)
    parent.set(root(`c:${pair.credit.recordId}`), root(`i:${pair.invoice.recordId}`));
  const groups = new Map<string, Array<CreditPair>>();
  for (const pair of pairs) {
    const at = root(`c:${pair.credit.recordId}`);
    groups.set(at, [...(groups.get(at) ?? []), pair]);
  }
  return [...groups.values()]
    .map((group) => {
      const ranked = group.toSorted(byRank);
      const [first, ...rest] = ranked;
      const rival = rest.find(
        (one) =>
          one.credit.recordId === first!.credit.recordId ||
          one.invoice.recordId === first!.invoice.recordId,
      );
      return { pairs: ranked, clear: clearlyFirst(first!.candidate.score, rival?.candidate.score) };
    })
    .toSorted((a, b) => byRank(a.pairs[0]!, b.pairs[0]!));
});

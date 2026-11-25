import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { homeCurrency } from "../companyProfile.ts";
import { partnerPayees } from "../partnersOwed.ts";
import { ownerZone } from "../recordRows.ts";
import { findBankList } from "./bankList.ts";
import { openEntries } from "./invoiceCredits.ts";
import { identifies, markedByHand, repayment, suggest } from "./statementMatch.ts";
import { partnerCandidates } from "./statementReview.ts";

type OpenDebit = Effect.Success<ReturnType<typeof openEntries>>[number];

/**
 * One unexplained debit that names exactly one partner Kin owes in its currency, by their whole
 * name or an import address they are known by. `repays` is the run of their oldest owed expenses
 * that adds up to it exactly, as a statement's review would offer it; undefined when none does.
 * `marked`: the day the same money was already marked repaid by hand for them, within ten days
 * of the debit (`markedByHand`, as a statement's review reads it).
 */
export type RepaidMatch = {
  readonly debit: OpenDebit;
  readonly partner: { readonly id: string; readonly name: string };
  readonly owedMinor: bigint;
  readonly owedCount: number;
  readonly repays: ReadonlyArray<RepaidItem> | undefined;
  readonly marked: string | undefined;
};
export type RepaidItem = {
  readonly recordId: string;
  readonly key: string;
  readonly amountMinor: number;
  readonly day: string;
  readonly rev: number;
};

const matchAll = Effect.fn("KinDebitRepaid.matchAll")(function* (
  orgId: KinOrgId,
  debits: ReadonlyArray<OpenDebit>,
) {
  if (debits.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const partners = yield* partnerCandidates(
    orgId,
    yield* homeCurrency(orgId),
    yield* ownerZone(orgId),
  );
  if (partners.length === 0) return [];
  const payees = yield* partnerPayees(orgId);
  const ownAccounts = (yield* sql<{ account: string }>`SELECT DISTINCT account
    FROM kin_bank_statements WHERE org_id = ${orgId} AND account IS NOT NULL
    ORDER BY account`).map((one) => one.account);
  return debits.flatMap((debit): Array<RepaidMatch> => {
    // A move between the company's own accounts that names a partner repays nobody.
    if (suggest(debit.row, { ownAccounts, known: [], bank: null }).action === "transfer") return [];
    const named = new Map<string, string>();
    for (const one of [...partners, ...payees])
      if (identifies(one, debit.row.description)) named.set(one.id ?? one.name, one.name);
    const [only, ...more] = named;
    if (only === undefined || more.length > 0) return [];
    const [id, name] = only;
    const partner = partners.find((one) => one.id === id && one.currency === debit.currency);
    if (partner === undefined || partner.owed.length === 0) return [];
    const marked = payees
      .find((one) => one.id === id)
      ?.repaid.find((one) => markedByHand(debit.row, debit.currency, one))?.day;
    const found = repayment(debit.row, partner, 0, true)?.candidate.repays;
    const repays = found?.flatMap((one) =>
      one.day === undefined || one.rev === undefined
        ? []
        : [
            {
              recordId: one.recordId,
              key: one.key,
              amountMinor: one.amountMinor,
              day: one.day,
              rev: one.rev,
            },
          ],
    );
    return [
      {
        debit,
        partner: { id, name },
        owedMinor: partner.owed.reduce((sum, one) => sum + BigInt(one.amountMinor), 0n),
        owedCount: partner.owed.length,
        repays: repays !== undefined && repays.length === found?.length ? repays : undefined,
        marked,
      },
    ];
  });
});

/** Every unexplained Bank transactions debit that names one partner the company owes. */
export const repaidMatches = Effect.fn("KinDebitRepaid.matches")(function* (orgId: KinOrgId) {
  const def = yield* findBankList(orgId);
  if (def === undefined) return [];
  return yield* matchAll(orgId, yield* openEntries(orgId, def, "debit", undefined));
});

/** One debit as the matcher reads it now; undefined when it names no one partner Kin owes. */
export const repaidMatch = Effect.fn("KinDebitRepaid.match")(function* (
  orgId: KinOrgId,
  bankRecordId: string,
) {
  const def = yield* findBankList(orgId);
  if (def === undefined) return undefined;
  const [match] = yield* matchAll(
    orgId,
    yield* openEntries(orgId, def, "debit", { recordId: bankRecordId }),
  );
  return match;
});

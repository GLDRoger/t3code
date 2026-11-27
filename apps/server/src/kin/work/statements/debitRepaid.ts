import type { KinOrgId } from "@t3tools/contracts";
import { readOnly } from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { homeCurrency } from "../companyProfile.ts";
import { partnerPayees } from "../partnersOwed.ts";
import { dayIn } from "../money.ts";
import { ownerZone } from "../recordRows.ts";
import { bankStates, findBankList } from "./bankList.ts";
import { expenseContests } from "./debitBill.ts";
import { openEntries, openRepaymentDebits } from "./invoiceCredits.ts";
import { assignRepaidMarks, identifies, repayment, SALARIES, suggest } from "./statementMatch.ts";
import { partnerCandidates } from "./statementReview.ts";

type OpenDebit = Effect.Success<ReturnType<typeof openEntries>>[number];

/** The title of a mark-repaid card's outcome once its tap marked the expenses. */
export const MARKED_REPAID = "Marked repaid";

/**
 * One unexplained debit naming exactly one partner Kin owes in its currency (whole name or import
 * address). `repays`: the run of their oldest owed expenses adding up to it exactly, else undefined.
 * `marked`: the day an individual or total repayment was assigned to this debit.
 */
export type RepaidMatch = {
  readonly debit: OpenDebit;
  readonly partner: { readonly id: string; readonly name: string };
  readonly owedMinor: bigint;
  readonly owedCount: number;
  readonly repays: ReadonlyArray<RepaidItem> | undefined;
  readonly marked: string | undefined;
  readonly expense?: {
    readonly recordId: string;
    readonly key: string;
    readonly rev: number;
    readonly open: boolean;
    readonly day: string | null;
  };
  /** It adds up to nothing and can't have repaid anything: older than what they are owed, or a salary. */
  readonly noLine: boolean;
  /** A card marked it repaid and a person set it back to Unexplained: the owner's no. */
  readonly setBack: boolean;
  /** Dated after the day it was read on, in the owner's zone: nothing is repaid before it happens. */
  readonly ahead: boolean;
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
  at: number,
  target?: string,
) {
  const def = yield* findBankList(orgId);
  if (def === undefined) return [];
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const today = dayIn(at, zone);
  const partners = yield* partnerCandidates(orgId, yield* homeCurrency(orgId), zone);
  if (partners.length === 0) return [];
  const { payees, debits, open, ownAccounts } = yield* Effect.gen(function* () {
    const payees = yield* partnerPayees(orgId);
    const debits = yield* openEntries(
      orgId,
      def,
      "debit",
      target === undefined ? undefined : { recordId: target },
    );
    if (debits.length === 0) return { payees, debits, open: [], ownAccounts: [] };
    const open = yield* openRepaymentDebits(orgId, def, payees);
    const ownAccounts = (yield* sql<{ account: string }>`SELECT DISTINCT account
      FROM kin_bank_statements WHERE org_id = ${orgId} AND account IS NOT NULL
      ORDER BY account`).map((one) => one.account);
    return { payees, debits, open, ownAccounts };
  }).pipe(sql.withTransaction, readOnly);
  if (debits.length === 0) return [];
  const assigned = assignRepaidMarks(open, payees, ownAccounts);
  const markedById = new Map(open.map((debit) => [debit.recordId, assigned.get(debit.row)?.day]));
  const states = bankStates(def);
  const setBack = new Set(
    (yield* sql<{ recordId: string }>`SELECT DISTINCT c.record_id AS "recordId"
      FROM kin_record_changes c, json_each(c.fields_json) f
      WHERE c.org_id = ${orgId} AND c.record_id IN ${sql.in(debits.map((debit) => debit.recordId))}
        AND c.actor_kind = 'person' AND json_extract(f.value, '$.field') = 'state'
        AND json_extract(f.value, '$.from') = ${states.explained}
        AND json_extract(f.value, '$.to') = ${states.open}
        AND c.record_id IN (SELECT COALESCE(json_extract(p.plan_json, '$.final.recordId'),
            json_extract(p.plan_json, '$.recordId'))
          FROM kin_card_plans p JOIN kin_widgets w ON w.org_id = p.org_id
            AND w.widget_id = p.widget_id
          WHERE p.org_id = ${orgId} AND 'mark_repaid' IN (json_extract(p.plan_json, '$.kind'),
              json_extract(p.plan_json, '$.final.kind'))
            AND json_extract(w.state_json, '$.outcome.title') = ${MARKED_REPAID})
      ORDER BY c.record_id`).map((one) => one.recordId),
  );
  const offers: Array<{ debit: OpenDebit; score: number }> = [];
  const matches = debits.flatMap((debit): Array<RepaidMatch> => {
    const plain = suggest(debit.row, { ownAccounts, known: [], bank: null });
    // A move between the company's own accounts that names a partner repays nobody.
    if (plain.action === "transfer") return [];
    const named = new Map<string, string>();
    for (const one of [...partners, ...payees])
      if (identifies(one, debit.row.description)) named.set(one.id ?? one.name, one.name);
    const [only, ...more] = named;
    if (only === undefined || more.length > 0) return [];
    const [id, name] = only;
    const partner = partners.find((one) => one.id === id && one.currency === debit.currency);
    if (partner === undefined || partner.owed.length === 0) return [];
    const marked = markedById.get(debit.recordId);
    const candidate = repayment(debit.row, partner, 0, true)?.candidate;
    const found = candidate?.repays;
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
    const exact = repays !== undefined && repays.length === found?.length ? repays : undefined;
    const oldest = partner.owed[0]!.day;
    if (
      candidate !== undefined &&
      exact !== undefined &&
      marked === undefined &&
      !setBack.has(debit.recordId) &&
      debit.date <= today
    )
      offers.push({ debit, score: candidate.score });
    return [
      {
        debit,
        partner: { id, name },
        owedMinor: partner.owed.reduce((sum, one) => sum + BigInt(one.amountMinor), 0n),
        owedCount: partner.owed.length,
        repays: exact,
        marked,
        noLine:
          exact === undefined &&
          ((oldest !== undefined && debit.date < oldest) || plain.category === SALARIES),
        setBack: setBack.has(debit.recordId),
        ahead: debit.date > today,
      },
    ];
  });
  const contests = yield* expenseContests(orgId, def, offers);
  return matches.map((match): RepaidMatch => {
    const expense = contests.get(match.debit.recordId);
    if (expense === undefined) return match;
    const { recordId, key, rev, open, day } = expense;
    return { ...match, expense: { recordId, key, rev, open, day } };
  });
});

/** Among the newest 200 unexplained debits, those naming one partner the company owes. */
export const repaidMatches = Effect.fn("KinDebitRepaid.matches")(function* (
  orgId: KinOrgId,
  at: number,
) {
  return yield* matchAll(orgId, at);
});

/** One debit as the matcher reads it now; undefined when it names no one partner Kin owes. */
export const repaidMatch = Effect.fn("KinDebitRepaid.match")(function* (
  orgId: KinOrgId,
  bankRecordId: string,
  at: number,
) {
  const [match] = yield* matchAll(orgId, at, bankRecordId);
  return match;
});

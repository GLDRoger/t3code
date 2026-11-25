import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { homeCurrency } from "../companyProfile.ts";
import { partnerPayees } from "../partnersOwed.ts";
import { dayIn } from "../money.ts";
import { ownerZone } from "../recordRows.ts";
import type { ListDef } from "../registers.ts";
import { bankStates, findBankList } from "./bankList.ts";
import { openEntries } from "./invoiceCredits.ts";
import { identifies, markedByHand, repayment, SALARIES, suggest } from "./statementMatch.ts";
import { partnerCandidates } from "./statementReview.ts";

type OpenDebit = Effect.Success<ReturnType<typeof openEntries>>[number];

/** The title of a mark-repaid card's outcome once its tap marked the expenses. */
export const MARKED_REPAID = "Marked repaid";

/**
 * One unexplained debit naming exactly one partner Kin owes in its currency (whole name or import
 * address). `repays`: the run of their oldest owed expenses adding up to it exactly, else undefined.
 * `marked`: the day the same money was marked repaid by hand within ten days (`markedByHand`).
 */
export type RepaidMatch = {
  readonly debit: OpenDebit;
  readonly partner: { readonly id: string; readonly name: string };
  readonly owedMinor: bigint;
  readonly owedCount: number;
  readonly repays: ReadonlyArray<RepaidItem> | undefined;
  readonly marked: string | undefined;
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
  def: ListDef,
  debits: ReadonlyArray<OpenDebit>,
  at: number,
) {
  if (debits.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const today = dayIn(at, zone);
  const partners = yield* partnerCandidates(orgId, yield* homeCurrency(orgId), zone);
  if (partners.length === 0) return [];
  const payees = yield* partnerPayees(orgId);
  const ownAccounts = (yield* sql<{ account: string }>`SELECT DISTINCT account
    FROM kin_bank_statements WHERE org_id = ${orgId} AND account IS NOT NULL
    ORDER BY account`).map((one) => one.account);
  const states = bankStates(def);
  const setBack = new Set(
    (yield* sql<{ recordId: string }>`SELECT DISTINCT c.record_id AS "recordId"
      FROM kin_record_changes c, json_each(c.fields_json) f
      WHERE c.org_id = ${orgId} AND c.record_id IN ${sql.in(debits.map((one) => one.recordId))}
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
  return debits.flatMap((debit): Array<RepaidMatch> => {
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
    const exact = repays !== undefined && repays.length === found?.length ? repays : undefined;
    const oldest = partner.owed[0]!.day;
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
});

/** Every unexplained Bank transactions debit that names one partner the company owes, read at `at`. */
export const repaidMatches = Effect.fn("KinDebitRepaid.matches")(function* (
  orgId: KinOrgId,
  at: number,
) {
  const def = yield* findBankList(orgId);
  if (def === undefined) return [];
  return yield* matchAll(orgId, def, yield* openEntries(orgId, def, "debit", undefined), at);
});

/** One debit as the matcher reads it now; undefined when it names no one partner Kin owes. */
export const repaidMatch = Effect.fn("KinDebitRepaid.match")(function* (
  orgId: KinOrgId,
  bankRecordId: string,
  at: number,
) {
  const def = yield* findBankList(orgId);
  if (def === undefined) return undefined;
  const [match] = yield* matchAll(
    orgId,
    def,
    yield* openEntries(orgId, def, "debit", { recordId: bankRecordId }),
    at,
  );
  return match;
});

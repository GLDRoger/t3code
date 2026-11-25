import type { KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { homeCurrency } from "../companyProfile.ts";
import { dayIn } from "../money.ts";
import { keptEntry, ownerZone } from "../recordRows.ts";
import { partnerFunded } from "../reimbursement.ts";
import type { ListDef } from "../registers.ts";
import { bankStates, findBankList } from "./bankList.ts";
import { openEntries } from "./invoiceCredits.ts";
import { expenseCandidate, levelWithBest } from "./statementMatch.ts";

type OpenDebit = Effect.Success<ReturnType<typeof openEntries>>[number];

export const MARKED_BILL_PAID = "Marked paid";
export const billPaidFactKey = (bankKey: string) => `bill_paid_seen:${bankKey}`;

const openBills = Effect.fn("KinDebitBill.openBills")(function* (orgId: KinOrgId, def: ListDef) {
  const sql = yield* SqlClient.SqlClient;
  const home = yield* homeCurrency(orgId);
  const zone = yield* ownerZone(orgId);
  const rows = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    currency: string;
    amountMinor: number;
    dateAt: number | null;
    dueAt: number | null;
    vendor: string | null;
    repeats: number;
    rev: number;
  }>`SELECT r.record_id AS "recordId", r.key, r.title, r.rev,
      COALESCE(r.currency, ${home}) AS currency, r.amount_minor AS "amountMinor",
      r.date_at AS "dateAt", COALESCE(r.due_at, r.date_at) AS "dueAt",
      json_extract(r.fields_json, '$.vendor') AS vendor, (r.repeat_json IS NOT NULL) AS repeats
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses' AND r.state = 'open'
      AND r.amount_minor IS NOT NULL AND ${keptEntry(sql)} AND NOT ${partnerFunded(sql)}
      AND NOT EXISTS (SELECT 1 FROM kin_bank_statement_entries e
        WHERE e.org_id = r.org_id AND e.target_record_id = r.record_id)
      AND NOT EXISTS (SELECT 1 FROM kin_record_links l JOIN kin_records b
        ON b.org_id = l.org_id AND b.record_id = l.target
        WHERE l.org_id = r.org_id AND l.record_id = r.record_id AND l.kind = 'record'
          AND l.relation = 'evidence' AND b.register_id = ${def.id})
    ORDER BY r.key`;
  const day = (at: number | null) => (at === null ? null : dayIn(at, zone));
  return rows.map((row) => ({
    recordId: row.recordId,
    key: row.key,
    title: row.title,
    currency: row.currency,
    amountMinor: row.amountMinor,
    vendor: row.vendor,
    repeats: row.repeats === 1,
    day: day(row.dateAt),
    due: day(row.dueAt),
    open: true,
    rev: row.rev,
  }));
});

const amountKey = (currency: string, minor: number) => `${currency}:${minor}`;

const matchAll = Effect.fn("KinDebitBill.matchAll")(function* (
  orgId: KinOrgId,
  def: ListDef,
  debits: ReadonlyArray<OpenDebit>,
  at: number,
) {
  if (debits.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const today = dayIn(at, yield* ownerZone(orgId));
  const bills = yield* openBills(orgId, def);
  if (bills.length === 0) return [];
  const byAmount = Map.groupBy(bills, (one) => amountKey(one.currency, one.amountMinor));
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
          WHERE p.org_id = ${orgId} AND 'mark_bill_paid' IN (json_extract(p.plan_json, '$.kind'),
              json_extract(p.plan_json, '$.final.kind'))
            AND json_extract(w.state_json, '$.outcome.title') = ${MARKED_BILL_PAID})
      ORDER BY c.record_id`).map((one) => one.recordId),
  );
  // openEntries excludes agent-written debits and carries no foreign amount.
  return debits.flatMap((debit) => {
    if (debit.date > today || setBack.has(debit.recordId)) return [];
    const possible = byAmount.get(amountKey(debit.currency, debit.amountMinor)) ?? [];
    const ranked = possible
      .flatMap((bill) => {
        const candidate = expenseCandidate(debit.row, bill, debit.currency);
        return candidate === undefined ? [] : [{ bill, score: candidate.score }];
      })
      .sort((a, b) => b.score - a.score);
    const first = levelWithBest(ranked, (one) => one.score);
    return first.length === 1 ? [{ debit, bill: first[0]!.bill }] : [];
  });
});

export const billMatches = Effect.fn("KinDebitBill.matches")(function* (
  orgId: KinOrgId,
  at: number,
) {
  const def = yield* findBankList(orgId);
  if (def === undefined) return [];
  return yield* matchAll(orgId, def, yield* openEntries(orgId, def, "debit", undefined), at);
});

export const billMatch = Effect.fn("KinDebitBill.match")(function* (
  orgId: KinOrgId,
  bankRecordId: string,
) {
  const def = yield* findBankList(orgId);
  if (def === undefined) return undefined;
  const [match] = yield* matchAll(
    orgId,
    def,
    yield* openEntries(orgId, def, "debit", { recordId: bankRecordId }),
    yield* Clock.currentTimeMillis,
  );
  return match;
});

import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { companyMoney } from "../companyProfile.ts";
import { parseFields } from "../lists.ts";
import { dayIn, formatMinor } from "../money.ts";
import { ownerZone } from "../recordRows.ts";
import { regionOf } from "../region.ts";
import { bankStates, directionOf, findBankList } from "./bankList.ts";
import { invoiceOffered } from "./statementMatch.ts";
import { invoiceCandidates } from "./statementReview.ts";

const SHOWN = 5;
// The newest this many unexplained credits are enough to find five.
const LOOKED_AT = 200;

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
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const withholds = regionOf((yield* companyMoney(orgId)).country)?.withholdsAtSource === true;
  const rows = yield* sql<{
    key: string;
    title: string;
    amountMinor: number;
    dateAt: number;
    fieldsJson: string;
  }>`SELECT r.key, r.title, r.amount_minor AS "amountMinor", r.date_at AS "dateAt",
      r.fields_json AS "fieldsJson"
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = ${def.id} AND r.state = ${bankStates(def).open}
      AND COALESCE(r.currency, ${def.currency}) = ${invoice.currency}
      AND r.amount_minor > 0 AND r.amount_minor <= ${owed} AND r.date_at IS NOT NULL
    ORDER BY r.date_at DESC, r.record_id DESC
    LIMIT ${LOOKED_AT}`;
  return rows
    .flatMap((row) => {
      const fields = parseFields(row.fieldsJson);
      if (directionOf(fields) !== "credit") return [];
      const date = dayIn(row.dateAt, zone);
      const reason = invoiceOffered(
        {
          index: 0,
          date,
          description: row.title,
          reference: typeof fields.reference === "string" ? fields.reference : null,
          amountMinor: row.amountMinor,
          direction: "credit",
          balanceMinor: null,
          foreign: null,
        },
        invoice,
        invoice.currency,
        withholds,
      );
      return reason === undefined
        ? []
        : [
            {
              key: row.key,
              date,
              amount: formatMinor(BigInt(row.amountMinor), invoice.currency),
              title: row.title,
              reason,
            },
          ];
    })
    .slice(0, SHOWN);
});

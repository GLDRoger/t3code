import type { KinMoney, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { aboutTotal, dayIn } from "./money.ts";
import { countedPayment, keyWithheld, ownerZone } from "./recordRows.ts";

export type RecordedRate = {
  readonly receivedCurrency: string;
  readonly invoiceCurrency: string;
  readonly rate: string;
  readonly day: string;
};

const RATE_DAYS = 90;

/**
 * The rate of the newest payment on an invoice in `from` that the company was paid in `to`,
 * within 90 days up to `asOf`'s day in the owner's zone. Only a stated settled rate counts, never
 * a rate the owner typed or one worked out from two sums. `keyed` leaves out what a key can't see.
 */
export const recordedRate = Effect.fn("KinRecordedRate.read")(function* (
  orgId: KinOrgId,
  from: string,
  to: string,
  asOf: number,
  keyed = false,
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const [row] = yield* sql<{ rate: string; day: string }>`SELECT p.rate, p.paid_on AS day
    FROM kin_record_payments p
    JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE p.org_id = ${orgId} AND ${countedPayment(sql)} AND p.withheld = 0
      AND r.register_id = 'invoices' AND p.currency = ${from}
      AND p.received_currency = ${to} AND p.rate IS NOT NULL
      AND p.paid_on >= ${dayIn(asOf - RATE_DAYS * 86_400_000, zone)}
      AND p.paid_on <= ${dayIn(asOf, zone)}
      ${keyed ? sql`AND NOT ${keyWithheld(sql)}` : sql``}
    ORDER BY p.paid_on DESC, p.created_at DESC, p.payment_id DESC
    LIMIT 1`;
  return row === undefined
    ? undefined
    : ({
        receivedCurrency: to,
        invoiceCurrency: from,
        rate: row.rate,
        day: row.day,
      } satisfies RecordedRate);
});

export const aboutInHome = Effect.fn("KinRecordedRate.about")(function* (
  orgId: KinOrgId,
  totals: ReadonlyArray<KinMoney>,
  home: string,
  asOf: number,
  read: typeof recordedRate = recordedRate,
) {
  const currencies = new Set(totals.map((money) => money.currency));
  if (currencies.size < 2) return undefined;
  const rates = [];
  for (const currency of currencies) {
    if (currency === home) continue;
    const found = yield* read(orgId, currency, home, asOf);
    if (
      found === undefined ||
      found.invoiceCurrency !== currency ||
      found.receivedCurrency !== home
    )
      return undefined;
    rates.push({ currency, rate: found.rate, asOf: found.day });
  }
  const estimate = aboutTotal(totals, home, rates);
  if (estimate === undefined || estimate.missing.length > 0) return undefined;
  return {
    total: estimate.total,
    rateDays: [...new Set(rates.map((one) => one.asOf))].sort(),
  };
});

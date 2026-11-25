import type { KinMoney, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { aboutTotal } from "./money.ts";

export type RecordedRate = {
  readonly receivedCurrency: string;
  readonly invoiceCurrency: string;
  readonly rate: string;
  readonly day: string;
};

// Lane A's kin_record_payments.rate / received_currency: newest counted payment within 90 days.
export const recordedRate = Effect.fn("KinRecordedRate.read")(function* (
  _orgId: KinOrgId,
  _from: string,
  _to: string,
  _asOf: number,
) {
  return yield* Effect.succeed<RecordedRate | undefined>(undefined);
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

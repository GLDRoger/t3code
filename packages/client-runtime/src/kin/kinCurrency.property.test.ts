// @effect-diagnostics globalDate:off - A rate's day is formatted as the view helper formats it.
import { assert, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { kinConvert, kinEstimate, kinTotalsEstimate, type KinRates } from "./kinCurrency.ts";
import { kinMinorDigits, kinMoneyText } from "./kinLists.ts";

// Invented amounts and rates only.
const CURRENCIES = ["INR", "USD", "EUR", "JPY", "KWD"] as const;
const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
const currency = Arbitrary.schema(Schema.Literals(CURRENCIES));
const money = Arbitrary.all({ minor: int(0, 10_000_000_000), currency });
const rate = Arbitrary.all([int(0, 9_999), int(0, 999_999), int(1, 28)]).pipe(
  Arbitrary.map(([whole, micros, date]) => ({
    rate: `${whole}.${String(Math.max(micros, whole === 0 ? 1 : 0)).padStart(6, "0")}`,
    asOf: `2026-${String((date % 12) + 1).padStart(2, "0")}-${String(date).padStart(2, "0")}`,
  })),
);
/** A home currency, and a rate (or none) for each of the others. */
const rates = Arbitrary.all([
  currency,
  Arbitrary.all(CURRENCIES.map(() => Arbitrary.all([Arbitrary.schema(Schema.Boolean), rate]))),
]).pipe(
  Arbitrary.map(([home, each]): KinRates => ({
    home,
    rates: CURRENCIES.flatMap((code, index) =>
      code === home || !each[index]![0] ? [] : [{ currency: code, ...each[index]![1] }],
    ),
  })),
);
const unitOf = (code: string) => 10 ** kinMinorDigits(code);
const dayText = (day: string) =>
  new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

it.prop(
  "an estimate is in the home currency, says about, names its rate's day, and is the conversion to the unit",
  [money, rates],
  ([amount, given]) => {
    const estimate = kinEstimate(amount, given);
    const used = given.rates.find((one) => one.currency === amount.currency);
    if (amount.currency === given.home || used === undefined) {
      assert.isNull(estimate);
      return;
    }
    const exact = kinConvert(amount, used.rate, given.home);
    if (exact === null) return assert.isNull(estimate);
    assert.isNotNull(estimate);
    assert.strictEqual(estimate!.money.currency, given.home);
    assert.match(estimate!.text, /^about /);
    assert.include(estimate!.basis, `as of ${dayText(used.asOf)}`);
    const unit = unitOf(given.home);
    assert.strictEqual(estimate!.money.minor % unit, 0);
    assert.isAtMost(Math.abs(estimate!.money.minor - exact.minor), unit / 2);
  },
);

it.prop(
  "converting two amounts apart or together differs by at most one minor unit",
  [money, money, rate, currency],
  ([a, b, { rate: r }, home]) => {
    const together = kinConvert({ minor: a.minor + b.minor, currency: a.currency }, r, home);
    const one = kinConvert(a, r, home);
    const two = kinConvert({ minor: b.minor, currency: a.currency }, r, home);
    if (together === null || one === null || two === null) return;
    assert.isAtMost(Math.abs(together.minor - one.minor - two.minor), 1);
  },
);

const totals = Arbitrary.all(CURRENCIES.map(() => int(0, 1_000_000_000))).pipe(
  Arbitrary.map((each) =>
    CURRENCIES.flatMap((code, index) =>
      each[index]! % 3 === 0 ? [] : [{ minor: each[index]!, currency: code }],
    ),
  ),
);

it.prop(
  "totals in several currencies are combined only as a dated estimate, and only when every one has a rate",
  [totals, rates],
  ([given, at]) => {
    const combined = kinTotalsEstimate(given, at);
    const foreign = given.filter((one) => one.currency !== at.home);
    if (foreign.length === 0) return assert.isNull(combined);
    assert.isNotNull(combined);
    const missing = foreign.filter(
      (one) => !at.rates.some((rated) => rated.currency === one.currency),
    );
    assert.deepStrictEqual(
      combined!.missing,
      missing.map((one) => one.currency),
    );
    assert.strictEqual(combined!.basis.length, foreign.length - missing.length);
    for (const line of combined!.basis) assert.match(line, /, as of /);
    if (missing.length > 0) return assert.isNull(combined!.all);
    const home = given.find((one) => one.currency === at.home)?.minor ?? 0;
    const estimated = foreign.reduce(
      (sum, one) => sum + (kinEstimate(one, at)?.money.minor ?? Number.NaN),
      home,
    );
    if (Number.isNaN(estimated)) return assert.isNull(combined!.all);
    assert.strictEqual(
      combined!.all,
      `about ${kinMoneyText({ minor: estimated, currency: at.home })} in all`,
    );
  },
);

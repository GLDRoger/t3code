import { assert, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { addUp, DEFAULT_CURRENCY, formatMoney, parseAmount } from "./money.ts";

// Invented amounts only.
const CURRENCIES = ["INR", "USD", "EUR", "GBP", "JPY", "KWD", "AED"] as const;
const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
const currency = Arbitrary.schema(Schema.Literals(CURRENCIES));
const money = Arbitrary.all({ minor: int(0, 1_000_000_000_000), currency });
const rows = Arbitrary.array(money, { maxLength: 30 });

it.prop(
  "each currency gets one total, the exact sum of its own rows, and no total mixes two",
  [rows],
  ([given]) => {
    const totals = addUp(given);
    const currencies = totals.map((one) => one.currency);
    assert.deepStrictEqual(
      currencies.toSorted(),
      [...new Set(given.map((one) => one.currency))].toSorted(),
    );
    if (currencies.includes(DEFAULT_CURRENCY)) assert.strictEqual(currencies[0], DEFAULT_CURRENCY);
    assert.deepStrictEqual(
      currencies.slice(currencies[0] === DEFAULT_CURRENCY ? 1 : 0),
      currencies.filter((code) => code !== DEFAULT_CURRENCY).toSorted(),
    );
    for (const total of totals) {
      const own = given.filter((one) => one.currency === total.currency);
      assert.strictEqual(
        BigInt(total.minor),
        own.reduce((sum, one) => sum + BigInt(one.minor), 0n),
        total.currency,
      );
    }
  },
);

it.prop(
  "totals don't depend on the rows' order or on how they are split",
  [rows, rows],
  ([a, b]) => {
    assert.deepStrictEqual(addUp([...a, ...b]), addUp([...b, ...a]));
    assert.deepStrictEqual(addUp([...a, ...b]), addUp([...addUp(a), ...addUp(b)]));
  },
);

it.prop(
  "an amount Kin writes reads back as the same amount in the same currency",
  [money, currency],
  ([amount, fallback]) => {
    const read = parseAmount(formatMoney(amount), fallback);
    assert.deepStrictEqual(read, { money: amount }, formatMoney(amount));
  },
);

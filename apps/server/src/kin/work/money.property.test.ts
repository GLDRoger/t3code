import { assert, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { addUp, formatMoney, parseAmount } from "./money.ts";

// Invented amounts only.
const CURRENCIES = ["INR", "USD", "EUR", "GBP", "JPY", "KWD", "AED"] as const;
const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
const currency = Arbitrary.schema(Schema.Literals(CURRENCIES));
const money = Arbitrary.all({ minor: int(0, 1_000_000_000_000), currency });
const rows = Arbitrary.array(money, { maxLength: 30 });

it.prop(
  "each currency gets one total, the exact sum of its own rows, home first, and no total mixes two",
  [rows, currency],
  ([given, home]) => {
    const totals = addUp(given, home);
    const currencies = totals.map((one) => one.currency);
    assert.deepStrictEqual(
      currencies.toSorted(),
      [...new Set(given.map((one) => one.currency))].toSorted(),
    );
    if (currencies.includes(home)) assert.strictEqual(currencies[0], home);
    assert.deepStrictEqual(
      currencies.slice(currencies[0] === home ? 1 : 0),
      currencies.filter((code) => code !== home).toSorted(),
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
    const sum = (amounts: Parameters<typeof addUp>[0]) => addUp(amounts, "INR");
    assert.deepStrictEqual(sum([...a, ...b]), sum([...b, ...a]));
    assert.deepStrictEqual(sum([...a, ...b]), sum([...sum(a), ...sum(b)]));
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

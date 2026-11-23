import { assert, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { computeData, GST_REGIME } from "./compute.ts";
import { parseRecipe, type Recipe, type Value } from "./recipe.ts";
import { STARTER_FILES } from "./starter.ts";

// Invented companies, GSTINs and figures only.
const recipe = (name: string): Recipe => {
  const parsed = parseRecipe(STARTER_FILES[`recipes/${name}/RECIPE.md`]!);
  if ("reason" in parsed) throw new Error(parsed.reason);
  return parsed;
};
const RECIPES = [recipe("invoice"), recipe("quotation")];

type Money = { readonly minor: number; readonly currency: string };
type Figures = {
  readonly tax: {
    readonly taxable: Money;
    readonly tax: Money;
    readonly total: Money;
    readonly taxes: ReadonlyArray<{
      readonly name: string;
      readonly rate: string;
      readonly amount: Money;
    }>;
  };
  readonly items: ReadonlyArray<{ readonly amount: Money }> | null;
};
const compute = (one: Recipe, given: Readonly<Record<string, Value>>) => {
  const inputs = Object.fromEntries(
    one.inputs.map((input) => [input.name, given[input.name] ?? null]),
  );
  const result = computeData(inputs, one.computed, GST_REGIME);
  if ("error" in result) throw new Error(`${one.name}: ${result.error}`);
  return result.data as unknown as Figures;
};

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
const pick = <const L extends ReadonlyArray<string>>(literals: L) =>
  Arbitrary.schema(Schema.Literals(literals));
const inr = (minor: number) => ({ minor, currency: "INR" });

const REGIMES: Readonly<Record<string, Readonly<Record<string, Value>>>> = {
  "same state": { clientGstin: "29BBBBB2222B1Z5" },
  "another state": { clientPlace: "Maharashtra" },
  "a union territory": { supplierGstin: "04AAAAA1111A1Z5", clientPlace: "Chandigarh" },
  "an export under LUT": { clientPlace: "United States" },
  "an export paying IGST": { clientPlace: "United States", exportUnderLut: false },
  "no GSTIN": { supplierGstin: null, clientPlace: "Maharashtra" },
};
const base: Readonly<Record<string, Value>> = {
  title: "Invented consulting",
  draft: true,
  today: "2026-11-02",
  client: "Example Client Pvt Ltd",
  supplier: "Sample Studio Pvt Ltd",
  supplierGstin: "29AAAAA1111A1Z5",
  supplierPlace: "Karnataka",
};
const setting = Arbitrary.all({
  regime: pick(Object.keys(REGIMES) as ReadonlyArray<keyof typeof REGIMES>),
  gstRate: Arbitrary.schema(
    Schema.NullOr(Schema.Literals(["0", "3", "5", "12", "18", "28", "0.25"])),
  ),
  recipe: int(0, RECIPES.length - 1),
});
const line = Arbitrary.all({
  rate: int(0, 10_000_000),
  quantity: int(1, 500),
  half: Arbitrary.schema(Schema.Boolean),
});
const lines = Arbitrary.array(line, { minLength: 1, maxLength: 6 });
const sum = (amounts: ReadonlyArray<Money>) => amounts.reduce((total, one) => total + one.minor, 0);

it.prop(
  "a quote's or invoice's total is its lines plus each tax on them, to the paisa",
  [setting, lines],
  ([at, given]) => {
    const one = RECIPES[at.recipe]!;
    const { tax, items } = compute(one, {
      ...base,
      ...REGIMES[at.regime],
      gstRate: at.gstRate,
      lines: given.map((row) => ({
        description: "Invented work",
        sac: null,
        quantity: `${row.quantity}${row.half ? ".5" : ""}`,
        unit: null,
        rate: inr(row.rate),
      })),
    });
    const rate = Number(at.gstRate ?? "18");
    for (const [index, row] of given.entries())
      assert.strictEqual(
        items![index]!.amount.minor,
        Math.round(row.rate * (row.quantity + (row.half ? 0.5 : 0))),
      );
    assert.strictEqual(tax.taxable.minor, sum(items!.map((item) => item.amount)));
    assert.strictEqual(tax.tax.minor, sum(tax.taxes.map((part) => part.amount)));
    assert.strictEqual(tax.total.minor, tax.taxable.minor + tax.tax.minor);
    for (const part of tax.taxes) {
      const exact = (tax.taxable.minor * Number(part.rate)) / 100;
      assert.isAtMost(
        Math.abs(part.amount.minor - exact),
        0.5 + 1e-6,
        `${part.name} ${part.rate}%`,
      );
    }
    const parts = tax.taxes.map((part) => Number(part.rate)).reduce((a, b) => a + b, 0);
    if (tax.taxes.length > 0) assert.closeTo(parts, rate, 1e-9, at.regime);
  },
);

it.prop(
  "rendered again from what it was issued with, a quote or invoice comes to the same figures",
  [setting, lines],
  ([at, given]) => {
    const one = RECIPES[at.recipe]!;
    const asked = {
      ...base,
      ...REGIMES[at.regime],
      gstRate: at.gstRate,
      lines: given.map((row) => ({
        description: "Invented work",
        sac: null,
        quantity: String(row.quantity),
        unit: null,
        rate: inr(row.rate),
      })),
    };
    const first = compute(one, asked).tax;
    // The entry carries the amount and tax issuing recorded (amounts.ts issueEntry).
    const recorded = { total: first.total, taxRecorded: first.tax };
    for (const again of [
      compute(one, { ...asked, ...recorded }).tax,
      compute(one, { ...asked, ...recorded, lines: null }).tax,
    ])
      assert.deepStrictEqual(
        [again.taxable, again.tax, again.total, again.taxes],
        [first.taxable, first.tax, first.total, first.taxes],
      );
  },
);

it.prop(
  "billed as one amount, its taxable value and taxes add back up to that amount exactly",
  [setting, int(0, 10_000_000_000)],
  ([at, total]) => {
    const one = RECIPES[at.recipe]!;
    const { tax } = compute(one, {
      ...base,
      ...REGIMES[at.regime],
      gstRate: at.gstRate,
      total: inr(total),
    });
    assert.strictEqual(tax.total.minor, total);
    assert.strictEqual(tax.taxable.minor + sum(tax.taxes.map((part) => part.amount)), total);
    const amounts = tax.taxes.map((part) => part.amount.minor);
    if (amounts.length === 2) assert.isAtMost(Math.abs(amounts[0]! - amounts[1]!), 1);
  },
);

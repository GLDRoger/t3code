// @effect-diagnostics nodeBuiltinImport:off -- a workbook part is inflated to read the cells Kin wrote.
import * as NodeZlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";

import { computeData } from "./compute.ts";
import { sampleInputs } from "./recipeLabels.ts";
import { assembleInputs, parseRecipe, type Recipe, type Value } from "./recipe.ts";
import { typeMismatch } from "./returnPath.ts";
import { STARTER_FILES } from "./starter.ts";
import { sheetCells, tableFiles, toCsv, toXlsx } from "./tables.ts";

// Invented companies, GSTINs and figures only.
const recipe = (name: string): Recipe => {
  const parsed = parseRecipe(STARTER_FILES[`recipes/${name}/RECIPE.md`]!);
  if ("reason" in parsed) return assert.fail(parsed.reason);
  return parsed;
};
const invoice = recipe("invoice");
const inr = (minor: number) => ({ minor, currency: "INR" });
const base: Readonly<Record<string, Value>> = {
  invoiceKey: "INV-9",
  title: "Consulting, October",
  issuedOn: "2026-11-02",
  number: "INV/26-27/004",
  draft: false,
  today: "2026-11-02",
  client: "Example Client Pvt Ltd",
  supplier: "Sample Studio Pvt Ltd",
  supplierGstin: "29AAAAA1111A1Z5",
  supplierPlace: "Karnataka",
  sac: "998314",
  lines: [{ description: "Advisory", sac: null, quantity: "3", unit: null, rate: inr(33333) }],
};
/** The invoice as its template reads it: every declared input, null unless given. */
const computeInvoice = (given: Readonly<Record<string, Value>>) => {
  const inputs = Object.fromEntries(
    invoice.inputs.map((input) => [input.name, given[input.name] ?? null]),
  );
  const result = computeData(inputs, invoice.computed);
  if ("error" in result) throw new Error(result.error);
  return result.data as {
    readonly tax: {
      readonly registered: boolean;
      readonly exportUnderLut: boolean;
      readonly country: string | null;
      readonly taxable: { readonly text: string };
      readonly total: { readonly text: string };
      readonly taxes: ReadonlyArray<{
        readonly name: string;
        readonly rate: string;
        readonly amount: { readonly text: string };
      }>;
    };
    readonly words: string;
    readonly issuedText: string;
  };
};

describe("invoice", () => {
  it("decides the tax lines from the states and keeps every paisa", () => {
    const cases = [
      // 3 x 333.33 = 999.99; 9% of it is 89.9991, so 90.00 each way.
      {
        name: "same state",
        input: { ...base, clientGstin: "29BBBBB2222B1Z5" },
        taxes: [
          ["CGST", "9%", "₹90.00"],
          ["SGST", "9%", "₹90.00"],
        ],
        total: "₹1,179.99",
        registered: true,
      },
      {
        name: "another state",
        input: { ...base, clientPlace: "Maharashtra" },
        taxes: [["IGST", "18%", "₹180.00"]],
        total: "₹1,179.99",
        registered: true,
      },
      {
        name: "a union territory without a legislature",
        input: { ...base, supplierGstin: "04AAAAA1111A1Z5", clientPlace: "Chandigarh" },
        taxes: [
          ["CGST", "9%", "₹90.00"],
          ["UTGST", "9%", "₹90.00"],
        ],
        total: "₹1,179.99",
        registered: true,
      },
      {
        name: "an export under a letter of undertaking",
        input: { ...base, clientPlace: "United States" },
        taxes: [],
        total: "₹999.99",
        registered: true,
      },
      {
        name: "a company with no GSTIN",
        input: { ...base, supplierGstin: null, clientPlace: "Maharashtra" },
        taxes: [],
        total: "₹999.99",
        registered: false,
      },
    ];
    for (const one of cases) {
      const { tax } = computeInvoice(one.input);
      assert.deepStrictEqual(
        tax.taxes.map((line) => [line.name, `${line.rate}%`, line.amount.text]),
        one.taxes,
        one.name,
      );
      assert.strictEqual(tax.total.text, one.total, one.name);
      assert.strictEqual(tax.registered, one.registered, one.name);
    }
    const exported = computeInvoice({ ...base, clientPlace: "United States" }).tax;
    assert.deepStrictEqual([exported.exportUnderLut, exported.country], [true, "United States"]);
    const paid = computeInvoice({ ...base, clientPlace: "United States", exportUnderLut: false });
    assert.deepStrictEqual(
      paid.tax.taxes.map((line) => [line.name, line.amount.text]),
      [["IGST", "₹180.00"]],
    );
    const words = computeInvoice({ ...base, clientPlace: "Maharashtra" });
    assert.strictEqual(
      words.words,
      "Rupees One Thousand One Hundred Seventy Nine and Ninety Nine Paise Only",
    );
    assert.strictEqual(words.issuedText, "2 Nov 2026");
  });

  it("splits a recorded total exactly, refuses lines that disagree with it, and spells amounts", () => {
    // ₹1,000.01 at 18% in one state: taxable 847.47, tax 152.54 split 76.27 + 76.27.
    const fromTotal = computeInvoice({
      ...base,
      lines: null,
      total: inr(100001),
      clientGstin: "29BBBBB2222B1Z5",
      number: null,
      draft: true,
    }).tax;
    assert.strictEqual(fromTotal.taxable.text, "₹847.47");
    assert.deepStrictEqual(
      fromTotal.taxes.map((line) => line.amount.text),
      ["₹76.27", "₹76.27"],
    );
    assert.strictEqual(fromTotal.total.text, "₹1,000.01");
    // A recorded tax is kept to the paisa; an odd one splits with the extra paisa second.
    const recorded = computeInvoice({
      ...base,
      lines: null,
      total: inr(100001),
      taxRecorded: inr(15255),
      clientGstin: "29BBBBB2222B1Z5",
    }).tax;
    assert.deepStrictEqual(
      [recorded.taxable.text, ...recorded.taxes.map((line) => line.amount.text)],
      ["₹847.46", "₹76.27", "₹76.28"],
    );
    assert.throws(
      () => computeInvoice({ ...base, total: inr(118000), clientPlace: "Maharashtra" }),
      "the lines come to ₹1,179.99 with tax, but the entry is recorded at ₹1,180.00",
    );
    assert.throws(() => computeInvoice(base), /no place of supply/);
    const spelled = computeData({ a: inr(1234567890), b: { minor: 100, currency: "USD" } }, [
      ["x", { words: "a" }],
      ["y", { words: "b" }],
    ]);
    assert.deepStrictEqual("data" in spelled ? [spelled.data.x, spelled.data.y] : [], [
      "Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Ninety Paise Only",
      "US Dollars One Only",
    ]);
  });
});

describe("computed fields", () => {
  it("round once, by the recipe's rule, and refuse what can't be exact", () => {
    const data = (computed: ReadonlyArray<readonly [string, unknown]>) => {
      const result = computeData({ a: inr(250), b: inr(-250), rate: "1", n: "2.5" }, computed);
      return "data" in result ? result.data : result.error;
    };
    const minor = (value: unknown) => (value as { readonly minor: number }).minor;
    // 1% of 2.50 is 0.025: half-up rounds away from zero, half-even to the even 2, down and up.
    const rounded = data([
      ["up", { percent: ["a", "rate"] }],
      ["even", { percent: ["a", "rate"], round: "half-even" }],
      ["down", { percent: ["a", "rate"], round: "down" }],
      ["ceil", { percent: ["a", "rate"], round: "up" }],
      ["negative", { percent: ["b", "rate"] }],
      ["times", { times: ["a", "n"] }],
      ["sum", { sum: ["a", "times"] }],
      ["less", { minus: ["a", "b"] }],
      ["date", { date: ["2026-11-02", "DD/MM/YYYY"] }],
    ]);
    assert.deepStrictEqual(
      typeof rounded === "string"
        ? rounded
        : [
            minor(rounded.up),
            minor(rounded.even),
            minor(rounded.down),
            minor(rounded.ceil),
            minor(rounded.negative),
            minor(rounded.times),
            minor(rounded.sum),
            minor(rounded.less),
            rounded.date,
          ],
      [3, 2, 2, 3, -3, 625, 875, 500, "02/11/2026"],
    );
    assert.strictEqual(
      data([["x", { sum: ["a", { minor: 1, currency: "USD" } as never] }]]),
      "x adds INR and USD",
    );
    assert.match(String(data([["x", { times: ["a", "1e9"] }]])), /isn't a number/);
    assert.match(String(data([["x", { average: ["a"] }]])), /isn't one of/);
    assert.match(String(data([["x", { sum: ["missing"] }]])), /isn't an input/);
  });

  it("turns Markdown into data, so nothing in it becomes Typst code", () => {
    const result = computeData(
      { body: '# Plan\n\nCosts **#exec("x")** and $5 @ref <b>\n\n- one\n- two\n\n[chart: q3]' },
      [["blocks", { markdown: "body" }]],
    );
    assert.deepStrictEqual("data" in result ? result.data.blocks : result.error, [
      { kind: "heading", level: 1, spans: [{ text: "Plan", style: "plain" }] },
      {
        kind: "paragraph",
        spans: [
          { text: "Costs ", style: "plain" },
          { text: '#exec("x")', style: "strong" },
          { text: " and $5 @ref <b>", style: "plain" },
        ],
      },
      {
        kind: "list",
        ordered: false,
        items: [[{ text: "one", style: "plain" }], [{ text: "two", style: "plain" }]],
      },
      { kind: "chart", name: "q3" },
    ]);
  });
});

/** One part of a ZIP Kin wrote: each part once, deflated, sizes in the header. */
const inflatePart = (zip: Buffer, name: string) => {
  const head = zip.lastIndexOf(Buffer.from("PK\u0003\u0004"), zip.indexOf(name));
  const start = head + 30 + zip.readUInt16LE(head + 26) + zip.readUInt16LE(head + 28);
  return NodeZlib.inflateRawSync(zip.subarray(start, start + zip.readUInt32LE(head + 18))).toString(
    "utf8",
  );
};

describe("accountant-pack", () => {
  it("totals each currency exactly, leaves void invoices out, and neutralises formula text", async () => {
    const sheet = {
      name: "Invoices",
      input: "invoices",
      columns: [
        { header: "No.", field: "number" },
        { header: "Amount", field: "amount" },
        { header: "Currency", field: "amount.currency" },
      ],
      leaveOutOfTotals: { field: "state", values: ["Void"] },
    };
    const cells = sheetCells(
      [
        { number: "A/1", amount: inr(10001), state: "Paid" },
        { number: "A/2", amount: inr(20002), state: "Void" },
        { number: "A/3", amount: { minor: 333, currency: "USD" }, state: "Issued" },
        { number: "A/4", amount: inr(99), state: "Issued" },
      ],
      sheet,
    );
    assert.strictEqual(
      toCsv(cells),
      "No.,Amount,Currency\r\nA/1,100.01,INR\r\nA/2,200.02,INR\r\nA/3,3.33,USD\r\nA/4,0.99,INR\r\nTotal INR,101.00,\r\nTotal USD,3.33,\r\n",
    );
    const risky = sheetCells(
      ['=HYPERLINK("x")', "+1+1", "-x", "@SUM(A1)", "\tx", " =1", "-5", "1,000.50", "plain"].map(
        (number) => ({ number, amount: inr(-100) }),
      ),
      { ...sheet, columns: sheet.columns.slice(0, 2), leaveOutOfTotals: undefined },
    );
    assert.strictEqual(
      toCsv(risky),
      'No.,Amount\r\n"\'=HYPERLINK(""x"")",-1.00\r\n\'+1+1,-1.00\r\n\'-x,-1.00\r\n\'@SUM(A1),-1.00\r\n\'\tx,-1.00\r\n\' =1,-1.00\r\n-5,-1.00\r\n"1,000.50",-1.00\r\nplain,-1.00\r\nTotal,-9.00\r\n',
    );
    assert.isUndefined(await typeMismatch("csv", new TextEncoder().encode(toCsv(risky))));
    // The workbook holds that text as text, never a formula; numbers stay numbers.
    const book = toXlsx([{ name: "Risky", cells: risky }]);
    assert.isUndefined(await typeMismatch("xlsx", book));
    const part = inflatePart(Buffer.from(book), "xl/worksheets/sheet1.xml");
    assert.notInclude(part, "<f>");
    assert.include(part, '<t xml:space="preserve">=HYPERLINK(&quot;x&quot;)</t>');
    assert.include(part, '<c r="B2" s="1"><v>-1.00</v></c>');
  });
});

it("ships three recipes that parse, read only what Kin supplies, and make their samples", async () => {
  const [inv, pack, report] = ["invoice", "accountant-pack", "report"].map(recipe);
  assert.deepStrictEqual(
    [inv!, pack!, report!].map((one) => [
      one.name,
      one.kind,
      one.list,
      one.numbered,
      one.sensitive,
    ]),
    [
      ["invoice", "typst", "invoices", true, true],
      ["accountant-pack", "table", null, false, true],
      ["report", "typst", null, false, false],
    ],
  );
  // No recipe carries a script any more: a template, a declaration and a sample.
  assert.deepStrictEqual(
    Object.keys(STARTER_FILES).filter((file) => /\.(mjs|js|py|sh)$/.test(file)),
    [],
  );
  for (const one of [inv!, report!]) {
    const sample = sampleInputs(one, STARTER_FILES[`recipes/${one.name}/sample.json`]);
    if (typeof sample === "string") return assert.fail(sample);
    assert.property(computeData(sample, one.computed), "data", one.name);
  }
  const packSample = sampleInputs(pack!, STARTER_FILES["recipes/accountant-pack/sample.json"]);
  if (typeof packSample === "string") return assert.fail(packSample);
  const files = tableFiles(pack!, packSample);
  assert.deepStrictEqual(
    files.map((file) => file.name),
    [
      "accounts-2026-10.xlsx",
      "invoices-2026-10.csv",
      "payments-2026-10.csv",
      "expenses-2026-10.csv",
    ],
  );
  for (const file of files)
    assert.isUndefined(await typeMismatch(file.name.endsWith("xlsx") ? "xlsx" : "csv", file.bytes));
  // The agent gives only its own inputs; a figure Kin stores is refused.
  const facts = (source: { readonly _tag: string }) =>
    source._tag === "company"
      ? "Sample Studio Pvt Ltd"
      : source._tag === "system"
        ? false
        : undefined;
  assert.property(
    assembleInputs(report!, { title: "Q3", taxRecorded: "₹1" }, facts, "INR"),
    "error",
  );
  // A day the agent gives is a real calendar day: 31 February isn't, 29 February 2028 is.
  const dated = parseRecipe(
    "---\nname: dated\ntitle: Dated\ndescription: d\noutputs: [a.pdf]\ninputs:\n  on: {type: date}\n---\nGo.\n",
  );
  if ("reason" in dated) return assert.fail(dated.reason);
  for (const [on, real] of [
    ["2026-02-31", false],
    ["2026-02-29", false],
    ["2026-04-31", false],
    ["0050-01-01", false],
    ["2028-02-29", true],
    ["2026-12-31", true],
  ] as const)
    assert.strictEqual("inputs" in assembleInputs(dated, { on }, facts, "INR"), real, on);
  const made = assembleInputs(report!, { title: "Q3", body: "Hello" }, facts, "INR");
  assert.deepStrictEqual(Object.keys("inputs" in made ? made.inputs : {}), [
    "title",
    "subtitle",
    "organisation",
    "date",
    "body",
    "charts",
  ]);
});

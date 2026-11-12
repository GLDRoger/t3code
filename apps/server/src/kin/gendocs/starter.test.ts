// @effect-diagnostics nodeBuiltinImport:off -- the starter scripts are written out and imported as a worker's worktree would hold them.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";

import { assembleInputs, parseRecipe, type Recipe } from "./recipe.ts";
import { STARTER_FILES } from "./starter.ts";

// Invented companies, GSTINs and figures only.
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-starter-"));
for (const [path, text] of Object.entries(STARTER_FILES)) {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, path), text);
}
const load = (recipe: string) =>
  import(
    /* @vite-ignore */ NodeURL.pathToFileURL(NodePath.join(root, "recipes", recipe, "build.mjs"))
      .href
  );
const config = (recipe: string): unknown =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(root, "recipes", recipe, "config.json"), "utf8"));

/** One part of a ZIP the starter wrote: it writes each part once, deflated, sizes in the header. */
const inflatePart = (zip: Buffer, name: string) => {
  const head = zip.lastIndexOf(Buffer.from("PK\u0003\u0004"), zip.indexOf(name));
  const start = head + 30 + zip.readUInt16LE(head + 26) + zip.readUInt16LE(head + 28);
  return NodeZlib.inflateRawSync(zip.subarray(start, start + zip.readUInt32LE(head + 18))).toString(
    "utf8",
  );
};
const inr = (minor: number) => ({ minor, currency: "INR" });
const base = {
  invoiceKey: "INV-9",
  title: "Consulting, October",
  total: null,
  taxRecorded: null,
  issuedOn: "2026-11-02",
  dueOn: null,
  number: "INV/26-27/004",
  draft: false,
  today: "2026-11-02",
  client: "Example Client Pvt Ltd",
  clientGstin: null,
  clientPlace: null,
  supplier: "Sample Studio Pvt Ltd",
  supplierGstin: "29AAAAA1111A1Z5",
  supplierPlace: "Karnataka",
  sac: "998314",
  lines: [{ description: "Advisory", quantity: "3", rate: inr(33333) }],
};

describe("invoice", () => {
  it("decides the tax lines from the states and keeps every paisa", async () => {
    const { computeInvoice } = await load("invoice");
    const settings = config("invoice");
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
        heading: "Tax Invoice",
      },
      {
        name: "another state",
        input: { ...base, clientPlace: "Maharashtra" },
        taxes: [["IGST", "18%", "₹180.00"]],
        total: "₹1,179.99",
        heading: "Tax Invoice",
      },
      {
        name: "a union territory without a legislature",
        input: { ...base, supplierGstin: "04AAAAA1111A1Z5", clientPlace: "Chandigarh" },
        taxes: [
          ["CGST", "9%", "₹90.00"],
          ["UTGST", "9%", "₹90.00"],
        ],
        total: "₹1,179.99",
        heading: "Tax Invoice",
      },
      {
        name: "an export under a letter of undertaking",
        input: { ...base, clientPlace: "United States" },
        taxes: [],
        total: "₹999.99",
        heading: "Tax Invoice",
      },
      {
        name: "a company with no GSTIN",
        input: { ...base, supplierGstin: null, clientPlace: "Maharashtra" },
        taxes: [],
        total: "₹999.99",
        heading: "Invoice",
      },
    ];
    for (const one of cases) {
      const invoice = computeInvoice(one.input, settings);
      assert.deepStrictEqual(
        invoice.taxes.map((tax: { name: string; rate: string; amount: string }) => [
          tax.name,
          tax.rate,
          tax.amount,
        ]),
        one.taxes,
        one.name,
      );
      assert.strictEqual(invoice.total, one.total, one.name);
      assert.strictEqual(invoice.heading, one.heading, one.name);
    }
    const exported = computeInvoice({ ...base, clientPlace: "United States" }, settings);
    assert.match(exported.endorsement, /EXPORT UNDER BOND OR LETTER OF UNDERTAKING/);
    assert.strictEqual(exported.recipient.country, "United States");
    assert.strictEqual(
      computeInvoice({ ...base, clientPlace: "Maharashtra" }, settings).words,
      "Rupees One Thousand One Hundred Seventy Nine and Ninety Nine Paise Only",
    );
  });

  it("splits a recorded total exactly, refuses lines that disagree with it, and marks drafts", async () => {
    const { computeInvoice, amountInWords } = await load("invoice");
    const settings = config("invoice");
    // ₹1,000.01 at 18% in one state: taxable 847.47, tax 152.54 split 76.27 + 76.27.
    const fromTotal = computeInvoice(
      {
        ...base,
        lines: null,
        total: inr(100001),
        clientGstin: "29BBBBB2222B1Z5",
        number: null,
        draft: true,
      },
      settings,
    );
    assert.strictEqual(fromTotal.taxable, "₹847.47");
    assert.deepStrictEqual(
      fromTotal.taxes.map((tax: { amount: string }) => tax.amount),
      ["₹76.27", "₹76.27"],
    );
    assert.strictEqual(fromTotal.total, "₹1,000.01");
    assert.isTrue(fromTotal.draft);
    assert.throws(
      () => computeInvoice({ ...base, total: inr(118000), clientPlace: "Maharashtra" }, settings),
      "the lines come to ₹1,179.99 with tax, but INV-9 is recorded at ₹1,180.00",
    );
    assert.throws(() => computeInvoice({ ...base }, settings), /no place of supply/);
    assert.strictEqual(
      amountInWords(1234567890, "INR"),
      "Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Ninety Paise Only",
    );
  });
});

describe("accountant-pack", () => {
  it("totals each currency exactly, leaves void invoices out, and writes a workbook Office reads", async () => {
    const { sheetOf, toCsv, toXlsx } = await load("accountant-pack");
    const rows = [
      { number: "A/1", amount: inr(10001), state: "Paid" },
      { number: "A/2", amount: inr(20002), state: "Void" },
      { number: "A/3", amount: { minor: 333, currency: "USD" }, state: "Issued" },
      { number: "A/4", amount: inr(99), state: "Issued" },
    ];
    const cells = sheetOf(
      rows,
      [
        { header: "No.", field: "number" },
        { header: "Amount", field: "amount" },
        { header: "Currency", field: "amount.currency" },
      ],
      { field: "state", values: ["Void"] },
    );
    assert.strictEqual(
      toCsv(cells),
      "No.,Amount,Currency\r\nA/1,100.01,INR\r\nA/2,200.02,INR\r\nA/3,3.33,USD\r\nA/4,0.99,INR\r\nTotal INR,101.00,\r\nTotal USD,3.33,\r\n",
    );
    const book: Uint8Array = toXlsx([{ name: "Invoices", cells }]);
    const text = Buffer.from(book).toString("latin1");
    assert.isTrue(text.startsWith("PK\u0003\u0004"));
    for (const part of ["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"])
      assert.include(text, part);
    // Text a spreadsheet would run as a formula is written as text; numbers stay numbers.
    const risky = sheetOf(
      ['=HYPERLINK("x")', "+1+1", "-x", "@SUM(A1)", "\tx", " =1", "-5", "1,000.50", "plain"].map(
        (number) => ({ number, amount: inr(-100) }),
      ),
      [
        { header: "No.", field: "number" },
        { header: "Amount", field: "amount" },
      ],
    );
    assert.strictEqual(
      toCsv(risky),
      'No.,Amount\r\n"\'=HYPERLINK(""x"")",-1.00\r\n\'+1+1,-1.00\r\n\'-x,-1.00\r\n\'@SUM(A1),-1.00\r\n\'\tx,-1.00\r\n\' =1,-1.00\r\n-5,-1.00\r\n"1,000.50",-1.00\r\nplain,-1.00\r\nTotal,-9.00\r\n',
    );
    const sheet = inflatePart(
      Buffer.from(toXlsx([{ name: "Risky", cells: risky }])),
      "xl/worksheets/sheet1.xml",
    );
    assert.notInclude(sheet, "<f>");
    assert.include(sheet, '<c r="A2" t="inlineStr"><is><t>=HYPERLINK(&quot;x&quot;)</t></is></c>');
    assert.include(sheet, '<c r="B2" s="1"><v>-1.00</v></c>');
  });
});

describe("report", () => {
  it("turns text into string literals, so nothing in it becomes Typst code", async () => {
    const { toTypst } = await load("report");
    const typst: string = toTypst(
      '# Plan\n\nCosts **#exec("x")** and $5 @ref <b> // not a comment "q"\n\n- one\n- two',
      new Set(),
    );
    assert.include(typst, '#heading(level: 1, "Plan")');
    assert.include(typst, '#strong("#exec(\\"x\\")")');
    assert.include(typst, '#" and $5 @ref <b> // not a comment \\"q\\""');
    assert.include(typst, '#list([#"one"], [#"two"])');
    assert.throws(() => toTypst("[chart: missing]", new Set()), /chart missing/);
  });
});

it("ships three recipes whose RECIPE.md parse and read only what Kin supplies", () => {
  const parsed = ["invoice", "accountant-pack", "report"].map((name) =>
    parseRecipe(STARTER_FILES[`recipes/${name}/RECIPE.md`]!),
  );
  for (const recipe of parsed) assert.notProperty(recipe, "reason", JSON.stringify(recipe));
  const [invoice, pack, report] = parsed as ReadonlyArray<Recipe>;
  assert.deepStrictEqual(
    [invoice, pack, report].map((recipe) => [
      recipe!.name,
      recipe!.list,
      recipe!.numbered,
      recipe!.sensitive,
    ]),
    [
      ["invoice", "invoices", true, true],
      ["accountant-pack", null, false, true],
      ["report", null, false, false],
    ],
  );
  // The worker gets the declared inputs only, and the agent can't give a figure Kin stores.
  const facts = (source: { readonly _tag: string }) =>
    source._tag === "company"
      ? "Sample Studio Pvt Ltd"
      : source._tag === "system"
        ? false
        : undefined;
  const refused = assembleInputs(report!, { title: "Q3", taxRecorded: "₹1" }, facts, "INR");
  assert.property(refused, "error");
  const made = assembleInputs(
    report!,
    { title: "Q3", charts: [{ chart: "a", kind: "bar", label: "x", value: "1.5" }] },
    facts,
    "INR",
  );
  assert.deepStrictEqual(Object.keys("inputs" in made ? made.inputs : {}), [
    "title",
    "subtitle",
    "organisation",
    "date",
    "body",
    "charts",
  ]);
});

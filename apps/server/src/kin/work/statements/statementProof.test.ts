import { assert, describe, it } from "@effect/vitest";

import { bindRows, type ProofPage, proveStatement, type ReadRow } from "./statementProof.ts";
import { readingFor } from "./statementReading.ts";
import type { StatementRow } from "./statementTable.ts";

// Invented rows: an opening of ₹1,000.00, then three rows over two pages, each with its balance.
const row = (
  index: number,
  date: string,
  amountMinor: number,
  direction: "debit" | "credit",
  balanceMinor: number | null,
): StatementRow => ({
  index,
  date,
  description: `Row ${index + 1}`,
  reference: null,
  amountMinor,
  direction,
  balanceMinor,
  foreign: null,
});
const statement = (pages: ReadonlyArray<ProofPage>, closing = 160_000) =>
  proveStatement({
    kind: "account",
    currency: "INR",
    opening: 100_000,
    closing,
    from: "2026-04-01",
    to: "2026-06-30",
    pages,
  });
const correct: ReadonlyArray<ProofPage> = [
  {
    page: 1,
    rows: [
      row(0, "2026-04-02", 50_000, "credit", 150_000),
      row(1, "2026-04-09", 20_000, "debit", 130_000),
    ],
  },
  { page: 2, rows: [row(2, "2026-05-03", 30_000, "credit", 160_000)] },
];

/** A page's line with each cell at its column; money sits right-aligned to the column's end. */
const line = (cells: ReadonlyArray<readonly [number, string, "left" | "right"]>) => {
  let out = "";
  for (const [column, text, align] of cells)
    out = out.padEnd(align === "right" ? column - text.length : column) + text;
  return out;
};
const HEADER = line([
  [0, "Date", "left"],
  [10, "Narration", "left"],
  [36, "Ref", "left"],
  [50, "Withdrawal Amt.", "left"],
  [70, "Deposit Amt.", "left"],
  [86, "Closing Balance", "left"],
]);
const printed = (
  day: string,
  words: string,
  money: { readonly debit?: string; readonly credit?: string; readonly balance?: string },
) =>
  line([
    [0, day, "left"],
    [10, words, "left"],
    [36, "0000123456", "left"],
    ...(money.debit === undefined ? [] : [[65, money.debit, "right"] as const]),
    ...(money.credit === undefined ? [] : [[82, money.credit, "right"] as const]),
    ...(money.balance === undefined ? [] : [[101, money.balance, "right"] as const]),
  ]);
const PAGE = [
  "LAKEVIEW BANK  Statement of account  Account No : 50100012347788",
  HEADER,
  printed("01/04/26", "OPENING BALANCE", { balance: "1,000.00" }),
  printed("02/04/26", "NEFT CR-NORTHWIND", { credit: "500.00", balance: "1,500.00" }),
  "          RETAIL PVT LTD",
  printed("09/04/26", "POS FIGMA.COM USD 15.00", { debit: "200.00", balance: "1,300.00" }),
].join("\n");
const read = (
  rows: ReadonlyArray<Partial<ReadRow>>,
  notRows = [{ date: "2026-04-01", text: "OPENING BALANCE" }],
  text = PAGE,
) =>
  bindRows({
    kind: "account",
    currency: "INR",
    opening: 100_000,
    texts: [text],
    pages: [
      {
        page: 1,
        rows: rows.map((one, at) => ({
          date: at === 0 ? "2026-04-02" : "2026-04-09",
          description: at === 0 ? "NEFT CR-NORTHWIND RETAIL PVT LTD" : "POS FIGMA.COM USD 15.00",
          reference: "123456",
          amountMinor: at === 0 ? 50_000 : 20_000,
          direction: at === 0 ? "credit" : "debit",
          balanceMinor: at === 0 ? 150_000 : 130_000,
          ...one,
        })),
        notRows,
      },
    ],
  });

describe("bindRows", () => {
  it("takes each row's numbers and direction from the line that prints them", () => {
    const honest = read([{}, {}]);
    assert.deepStrictEqual([honest.problems, honest.unproven], [[], []]);
    const [credit, debit] = honest.pages[0]!.rows;
    assert.deepInclude(credit, { direction: "credit", balanceMinor: 150_000, foreign: null });
    // A foreign spend keeps its currency and amount, as the line prints them.
    assert.deepStrictEqual(debit!.foreign, { currency: "USD", amountMinor: 1_500 });
    // A balance left out is read from its column.
    assert.strictEqual(read([{ balanceMinor: null }, {}]).pages[0]!.rows[0]!.balanceMinor, 150_000);
  });

  it.each([
    [
      "an amount no line prints",
      [{ amountMinor: 5_000 }, {}],
      "no line dated 2 Apr on page 1 prints ₹50.00",
    ],
    [
      "a balance not on its line",
      [{ balanceMinor: 160_000 }, {}],
      "the balance ₹1,600.00 isn't printed",
    ],
    [
      "a direction its column contradicts",
      [{}, { direction: "credit" as const }],
      "printed in the withdrawal (debit) column, so it is a debit, not a credit",
    ],
    [
      "narration that isn't on the line",
      [{ description: "SALARY ACME" }, {}],
      "narration's first words",
    ],
    [
      "a row the page doesn't have",
      [{}, {}, { date: "2026-04-07", amountMinor: 1_000 }],
      "isn't on page 1",
    ],
    [
      "a dated line left without a row",
      [{}],
      "the line dated 9 Apr that prints ₹200.00, ₹1,300.00 has no row",
    ],
  ])("names %s", (_name, rows, said) => {
    const bound = read(rows);
    assert.isTrue(
      bound.problems.some((one) => one.line.includes(said)),
      bound.problems.map((one) => one.line).join(" | "),
    );
  });

  it("checks the lines a reader marks as no transaction, and what it can't prove", () => {
    const opening = read([{}, {}], []);
    assert.include(
      opening.problems[0]!.line,
      "the line dated 1 Apr that prints ₹1,000.00 has no row",
    );
    const transaction = read(
      [{}],
      [
        { date: "2026-04-01", text: "OPENING BALANCE" },
        { date: "2026-04-09", text: "POS FIGMA" },
      ],
    );
    assert.include(
      transaction.problems[0]!.line,
      "you marked as not a transaction prints an amount and a balance",
    );
    // No columns and no balances: the rows bind, but which way they went isn't proven.
    const plain = [
      "01/04/26 OPENING BALANCE",
      "02/04/26 NEFT CR-NORTHWIND RETAIL 500.00",
      "09/04/26 POS FIGMA.COM 200.00",
    ].join("\n");
    const loose = read(
      [
        { balanceMinor: null, reference: null },
        { balanceMinor: null, reference: null },
      ],
      undefined,
      plain,
    );
    assert.deepStrictEqual(loose.problems, []);
    assert.include(loose.unproven[0], "which way 2 rows went");
  });
});

describe("proveStatement", () => {
  it("proves rows that add up, and points at the row and the amount where they don't", () => {
    assert.deepStrictEqual(statement(correct).problems, []);
    assert.strictEqual(statement(correct).check.status, "adds_up");

    // One amount misread: the row it breaks, by how much, and the totals.
    const misread = statement([
      correct[0]!,
      { ...correct[1]!, rows: [row(2, "2026-05-03", 3_000, "credit", 160_000)] },
    ]);
    assert.strictEqual(misread.check.status, "off");
    assert.deepInclude(misread.problems[0], { page: 2, row: 2 });
    assert.include(misread.problems[0]!.line, "₹270.00 apart");
    assert.include(misread.problems[1]!.line, "It doesn't add up");

    // A row left out: the next row's balance doesn't follow.
    const dropped = statement([{ ...correct[0]!, rows: [correct[0]!.rows[1]!] }, correct[1]!]);
    assert.deepInclude(dropped.problems[0], { page: 1, row: 1 });
    assert.include(dropped.problems[0]!.line, "₹500.00 apart");

    // Rows outside the period and out of order are named.
    const misdated = statement([
      {
        page: 1,
        rows: [
          row(0, "2026-07-02", 50_000, "credit", 150_000),
          row(1, "2026-04-09", 20_000, "debit", 130_000),
        ],
      },
      { page: 2, rows: [row(2, "2026-05-03", 30_000, "credit", 160_000)] },
    ]);
    assert.deepStrictEqual(
      misdated.problems.map((one) => one.row),
      [0, 1],
    );
  });

  it("adds up only what it proved, and says what it couldn't", () => {
    const noTotals = proveStatement({
      kind: "account",
      currency: "INR",
      opening: null,
      closing: null,
      from: null,
      to: null,
      pages: correct,
    });
    assert.strictEqual(noTotals.check.status, "unchecked");
    assert.include(noTotals.check.line, "Each running balance follows");
    const unproven = proveStatement({
      kind: "account",
      currency: "INR",
      opening: 100_000,
      closing: 160_000,
      from: null,
      to: null,
      pages: correct,
      bound: { problems: [], unproven: ["Page 2 has no text."] },
    });
    assert.deepStrictEqual(
      [unproven.check.status, unproven.check.line],
      [
        "unchecked",
        "Page 2 has no text. The rows' own sum does add up: ₹1,000.00 + credits ₹800.00 − debits ₹200.00 = ₹1,600.00.",
      ],
    );
  });
});

describe("readingFor", () => {
  it("shows a page longer than one answer in parts, split between lines", () => {
    const text = Array.from(
      { length: 1_500 },
      (_, at) => `${String(at).padStart(4, "0")} ${"x".repeat(35)}`,
    ).join("\n");
    const stored = { pages: [{ text, dated: null }], facts: null };
    const first = readingFor(stored, { pages: [], opening: null, closing: null });
    assert.deepStrictEqual(
      first.pages.map((one) => [one.page, one.part, one.parts]),
      [[1, 1, 2]],
    );
    const second = readingFor(stored, {
      pages: [[1, [], [], 1]],
      opening: null,
      closing: null,
    });
    assert.deepStrictEqual([second.pages[0]?.part, second.read], [2, 0]);
    assert.strictEqual(`${first.pages[0]!.text}\n${second.pages[0]!.text}`, text);
    assert.isAtMost(first.pages[0]!.text.length, 40_000);
  });
});

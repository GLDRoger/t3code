import { assert, describe, it } from "@effect/vitest";

import { type ProofPage, proveStatement } from "./statementProof.ts";
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
    dated: 2,
  },
  { page: 2, rows: [row(2, "2026-05-03", 30_000, "credit", 160_000)], dated: 1 },
];

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

    // A row left out: the next row's balance doesn't follow, and its page has a dated line too many.
    const dropped = statement([{ ...correct[0]!, rows: [correct[0]!.rows[1]!] }, correct[1]!]);
    assert.deepInclude(dropped.problems[0], { page: 1, row: 1 });
    assert.include(dropped.problems[0]!.line, "₹500.00 apart");
    assert.isTrue(
      dropped.problems.some((one) => one.line.startsWith("Page 1: 1 row was read, but 2")),
    );

    // Rows outside the period and out of order are named; a page with no text isn't counted.
    const misdated = statement([
      {
        page: 1,
        rows: [
          row(0, "2026-07-02", 50_000, "credit", 150_000),
          row(1, "2026-04-09", 20_000, "debit", 130_000),
        ],
        dated: null,
      },
      { page: 2, rows: [row(2, "2026-05-03", 30_000, "credit", 160_000)], dated: null },
    ]);
    assert.deepStrictEqual(
      misdated.problems.map((one) => one.row),
      [0, 1],
    );
  });

  it("checks nothing it can't, and says what it could check", () => {
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
  });
});

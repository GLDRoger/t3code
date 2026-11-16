import { assert, describe, it } from "@effect/vitest";

import { reviewHash, type Review } from "./statementCard.ts";
import type { Candidate } from "./statementMatch.ts";
import { checkBalances, type StatementRow } from "./statementTable.ts";

// An invented account's one row: a client's payment that Kin matched to an invoice.
const row: StatementRow = {
  index: 0,
  date: "2026-10-14",
  description: "NEFT CR-NORTHWIND RETAIL",
  reference: null,
  amountMinor: 9_000_000,
  direction: "credit",
  balanceMinor: null,
  foreign: null,
};
const reviewWith = (candidate: Partial<Candidate>, read: Partial<StatementRow> = {}): Review => ({
  statement: {
    kind: "account",
    bank: "Invented Bank",
    account: "9034",
    currency: "INR",
    from: row.date,
    to: row.date,
    openingMinor: null,
    closingMinor: null,
    rows: [{ ...row, ...read }],
    check: checkBalances("account", [row], null, null, "INR"),
  },
  format: "csv",
  source: "file",
  known: new Map(),
  matches: new Map([
    [
      0,
      {
        group: "matched",
        candidates: [
          {
            kind: "invoice",
            recordId: "rec_store",
            key: "INV-9",
            title: "Store design",
            fit: "exact",
            score: 90,
            why: [],
            ...candidate,
          },
        ],
        suggestion: { action: "later" },
      },
    ],
  ]),
});

describe("statement review cards", () => {
  it("makes a new card when only a row as read, or how it fits its entry, changes", () => {
    const hashes = [
      reviewWith({}),
      reviewWith({ fit: "tds", tdsMinor: 1_000_000 }),
      reviewWith({ fit: "tds", tdsMinor: 900_000 }),
      reviewWith({ fit: "part" }),
      reviewWith({}, { date: "2026-10-15" }),
      reviewWith({}, { amountMinor: 9_000_001 }),
      reviewWith({}, { direction: "debit" }),
    ].map((review) => reviewHash("st_1", review));
    assert.lengthOf(new Set(hashes), 7);
    assert.strictEqual(reviewHash("st_1", reviewWith({})), hashes[0]);
  });
});

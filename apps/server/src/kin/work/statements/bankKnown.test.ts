import { assert, describe, it } from "@effect/vitest";

import { knownThrough, type BankCoverage } from "./bankKnown.ts";

const hdfc = (from: string, through: string): BankCoverage => ({
  account: "hdfc bank\u00001234\u0000INR",
  label: "HDFC Bank Account ••1234",
  currency: "INR",
  from,
  through,
});
const other = (from: string, through: string): BankCoverage => ({
  account: "\u00009876\u0000USD",
  label: "Account ••9876",
  currency: "USD",
  from,
  through,
});

describe("how far Kin sees the bank", () => {
  it("is the end of each account's unbroken run, and the earliest kept-up one for the company", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly coverage: ReadonlyArray<BankCoverage>;
      readonly through: string | null;
      readonly accounts: ReadonlyArray<readonly [string, string, string, boolean]>;
    }> = [
      { name: "no statement", coverage: [], through: null, accounts: [] },
      {
        name: "one",
        coverage: [hdfc("2026-10-01", "2026-10-31")],
        through: "2026-10-31",
        accounts: [["HDFC Bank Account ••1234", "2026-10-01", "2026-10-31", true]],
      },
      {
        name: "a run, in any order, one overlapping and one starting the day after",
        coverage: [
          hdfc("2026-10-01", "2026-10-31"),
          hdfc("2026-08-01", "2026-08-31"),
          hdfc("2026-09-01", "2026-10-03"),
        ],
        through: "2026-10-31",
        accounts: [["HDFC Bank Account ••1234", "2026-08-01", "2026-10-31", true]],
      },
      {
        name: "a gap ends the run, whatever comes after it",
        coverage: [
          hdfc("2026-08-01", "2026-08-31"),
          hdfc("2026-10-01", "2026-10-31"),
          hdfc("2026-11-01", "2026-11-30"),
        ],
        through: "2026-08-31",
        accounts: [["HDFC Bank Account ••1234", "2026-08-01", "2026-08-31", true]],
      },
      {
        name: "two accounts: the company's is the earlier",
        coverage: [hdfc("2026-10-01", "2026-10-31"), other("2026-09-01", "2026-09-30")],
        through: "2026-09-30",
        accounts: [
          ["Account ••9876", "2026-09-01", "2026-09-30", true],
          ["HDFC Bank Account ••1234", "2026-10-01", "2026-10-31", true],
        ],
      },
      {
        name: "an account whose statements stopped long ago no longer holds the company's back",
        coverage: [hdfc("2026-10-01", "2026-10-31"), other("2026-01-01", "2026-01-31")],
        through: "2026-10-31",
        accounts: [
          ["Account ••9876", "2026-01-01", "2026-01-31", false],
          ["HDFC Bank Account ••1234", "2026-10-01", "2026-10-31", true],
        ],
      },
    ];
    for (const one of cases) {
      const known = knownThrough(one.coverage);
      assert.strictEqual(known.through, one.through, one.name);
      assert.deepStrictEqual(
        known.accounts.map(
          (account) => [account.label, account.from, account.through, account.keptUp] as const,
        ),
        one.accounts,
        one.name,
      );
    }
  });
});

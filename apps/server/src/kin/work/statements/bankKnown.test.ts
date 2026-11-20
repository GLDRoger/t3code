import { assert, describe, it } from "@effect/vitest";

import { type AccountRead, sameAccounts } from "./bankAccounts.ts";
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
        name: "a statement that runs past today counts to today, and one starting after it not at all",
        coverage: [
          hdfc("2026-11-01", "2026-11-30"),
          hdfc("2026-12-01", "2026-12-31"),
          hdfc("2027-01-01", "2027-01-31"),
        ],
        through: "2026-12-06",
        accounts: [["HDFC Bank Account ••1234", "2026-11-01", "2026-12-06", true]],
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
      const known = knownThrough(one.coverage, "2026-12-06");
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

const month = (
  name: string,
  digits: string | null,
  from: string,
  on: string,
  opening: number,
  closing: number,
  more: Partial<AccountRead> = {},
): AccountRead & { readonly name: string } => ({
  name,
  kind: "account",
  bank: null,
  digits,
  accountId: null,
  currency: "INR",
  from,
  on,
  opening,
  closing,
  ...more,
});
const oct = (digits: string | null, more?: Partial<AccountRead>) =>
  month("oct", digits, "2026-10-01", "2026-10-31", 0, 48_900_00, more);
const nov = (digits: string | null, more?: Partial<AccountRead>) =>
  month("nov", digits, "2026-11-01", "2026-11-30", 48_900_00, 48_760_00, more);
const dec = (digits: string | null, more?: Partial<AccountRead>) =>
  month("dec", digits, "2026-12-01", "2026-12-31", 48_760_00, 48_590_00, more);

describe("which statements are one account", () => {
  it("joins by digits and currency, a statement without digits only where its balances chain", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly reads: ReadonlyArray<ReturnType<typeof month>>;
      readonly accounts: ReadonlyArray<readonly [ReadonlyArray<string>, string | null, boolean]>;
    }> = [
      {
        name: "no digits in October, ••1234 in November, chained",
        reads: [oct(null), nov("1234")],
        accounts: [[["oct", "nov"], "1234", false]],
      },
      {
        name: "the same digits, consecutive",
        reads: [nov("1234"), dec("1234")],
        accounts: [[["nov", "dec"], "1234", false]],
      },
      {
        name: "the same digits with a month missing between",
        reads: [oct("1234"), dec("1234")],
        accounts: [[["oct", "dec"], "1234", false]],
      },
      {
        name: "the same bank folded, one statement naming none",
        reads: [
          oct("1234", { bank: "Saffron Bank" }),
          nov("1234"),
          dec("1234", { bank: "SAFFRON bank" }),
        ],
        accounts: [[["oct", "nov", "dec"], "1234", false]],
      },
      {
        name: "another bank's ••1234 is another account",
        reads: [oct("1234", { bank: "Saffron Bank" }), nov("1234", { bank: "Lakeview Bank" })],
        accounts: [
          [["oct"], "1234", false],
          [["nov"], "1234", false],
        ],
      },
      {
        name: "two ••1234 over the same days whose balances don't chain: told apart, and said so",
        reads: [
          nov("1234"),
          month("other", "1234", "2026-11-01", "2026-11-30", 5_000_00, 7_000_00),
        ],
        accounts: [
          [["nov"], "1234", true],
          [["other"], "1234", true],
        ],
      },
      {
        name: "two ••1234 whose full numbers differ are two accounts Kin tells apart",
        reads: [
          nov("1234", { accountId: "a" }),
          month("other", "1234", "2026-11-01", "2026-11-30", 5_000_00, 7_000_00, {
            accountId: "b",
          }),
        ],
        accounts: [
          [["nov"], "1234", false],
          [["other"], "1234", false],
        ],
      },
      {
        name: "no digits and no balance that chains: alone, and Kin can't tell",
        reads: [oct(null), dec("1234")],
        accounts: [
          [["dec"], "1234", false],
          [["oct"], null, true],
        ],
      },
      {
        name: "no digits chaining with two accounts at once: alone, and Kin can't tell",
        reads: [
          oct("1234"),
          month("twin", "9876", "2026-10-01", "2026-10-31", 0, 48_900_00),
          nov(null),
        ],
        accounts: [
          [["oct"], "1234", false],
          [["twin"], "9876", false],
          [["nov"], null, true],
        ],
      },
      {
        name: "no digits and no other account in its currency: its own account",
        reads: [oct(null), nov("9876", { currency: "USD" })],
        accounts: [
          [["nov"], "9876", false],
          [["oct"], null, false],
        ],
      },
    ];
    for (const one of cases)
      assert.deepStrictEqual(
        sameAccounts(one.reads).map(
          (account) =>
            [account.reads.map((read) => read.name), account.digits, account.apart] as const,
        ),
        one.accounts,
        one.name,
      );
  });
});

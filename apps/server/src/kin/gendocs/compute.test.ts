import { assert, it } from "@effect/vitest";

import { computeData } from "./compute.ts";

// Invented rows and amounts only.
it("works out a year of rows, and refuses fields that grow past what Kin works out", () => {
  const columns = Array.from({ length: 40 }, (_, index) => `c${index}`);
  const rows = Array.from({ length: 50_000 }, (_, row) => ({
    ...Object.fromEntries(columns.map((column) => [column, `r${row}-${column}`])),
    rate: { minor: 100 + (row % 7), currency: "INR" },
  }));
  const year = computeData({ rows }, [
    ["lines", { each: { rows: "rows", set: { amount: { times: ["rate", "2"] }, label: "c0" } } }],
    ["total", { sum: "lines.amount" }],
    ["again", { each: { rows: "lines", set: { half: { percent: ["amount", "50"] } } } }],
  ]);
  if ("error" in year) return assert.fail(year.error);
  const lines = year.data.lines as ReadonlyArray<Record<string, unknown>>;
  const again = year.data.again as ReadonlyArray<Record<string, unknown>>;
  assert.deepStrictEqual(
    [lines.length, Object.keys(lines[0]!).length, again.length, Object.keys(again[0]!).length],
    [50_000, 44, 50_000, 45],
  );
  assert.deepStrictEqual(year.data.total, {
    minor: 2 * rows.reduce((sum, row) => sum + row.rate.minor, 0),
    currency: "INR",
    text: "₹1,02,999.94",
  });

  // Each field holding the one before it would double per field, so a row holds single values.
  const lines2 = [{ a: "1" }, { a: "2" }];
  const chained = Array.from({ length: 15 }, (_, index) => {
    const before = index === 0 ? "lines2" : `t${index - 1}`;
    return [`t${index}`, { each: { rows: before, set: { prev: before } } }] as const;
  });
  assert.match(
    (computeData({ lines2 }, chained) as { readonly error: string }).error,
    /each sets one value per row/,
  );
  // A field may name a table again, but not so often that writing it out runs past the budget.
  const copies = Array.from(
    { length: 8 },
    (_, index) => [`copy${index}`, { first: ["rows"] }] as const,
  );
  assert.match(
    (computeData({ rows }, copies) as { readonly error: string }).error,
    /computed fields grow too large/,
  );
});

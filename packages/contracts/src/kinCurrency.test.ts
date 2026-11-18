import { describe, expect, it } from "vite-plus/test";

import {
  formatKinMoney,
  KIN_CURRENCY_CODES,
  kinCurrency,
  mentionsKinMoney,
  parseKinMoney,
} from "./kinCurrency.ts";

const intlDecimals = (code: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
    .maximumFractionDigits;

describe("one currency table", () => {
  it("keeps the decimals stored amounts were written with: CLDR's, as the server's Intl gave", () => {
    for (const code of KIN_CURRENCY_CODES)
      expect([code, kinCurrency(code).decimals]).toEqual([code, intlDecimals(code)]);
  });

  // The drifts this table closed: the apps said 2 decimals for PKR, IDR and HUF, documents
  // always divided by 100, and documents wrote USD as "US$".
  it.each([
    [150_000, "INR", "₹1,500.00", "₹1,500"],
    [42_000_000, "INR", "₹4,20,000.00", "₹4,20,000"],
    [1_500, "PKR", "PKR\u00a01,500", "PKR\u00a01,500"],
    [1_500_000, "IDR", "IDR\u00a01,500,000", "IDR\u00a01,500,000"],
    [1_200, "JPY", "¥1,200", "¥1,200"],
    [1_250, "USD", "$12.50", "$12.50"],
    [4_000_000, "USD", "$40,000.00", "$40,000"],
    [1_234, "KWD", "KWD\u00a01.234", "KWD\u00a01.234"],
    [99, "SGD", "S$0.99", "S$0.99"],
  ])("%i %s is %s, or %s plainly", (minor, code, always, some) => {
    expect(formatKinMoney(minor, code, { cents: "always" })).toBe(always);
    expect(formatKinMoney(minor, code)).toBe(some);
  });

  it("reads back every currency exactly as it is written, in every form", () => {
    for (const code of KIN_CURRENCY_CODES) {
      const unit = 10 ** kinCurrency(code).decimals;
      for (const minor of [1, unit, 123_456 * unit + (unit > 1 ? 7 : 0), 98_765_432_100]) {
        const expected = { money: { minor, currency: code } };
        for (const cents of ["always", "some"] as const)
          expect([code, parseKinMoney(formatKinMoney(minor, code, { cents }), "XXX")]).toEqual([
            code,
            expected,
          ]);
        // A bare number reads in the currency it is said to be in.
        expect([code, parseKinMoney(formatKinMoney(minor, code, { bare: true }), code)]).toEqual([
          code,
          expected,
        ]);
      }
    }
  });

  it("reads lakh and crore, symbols and codes, and refuses what it can't be sure of", () => {
    expect(parseKinMoney("4.2 lakh", "INR")).toEqual({
      money: { minor: 42_000_000, currency: "INR" },
    });
    expect(parseKinMoney("40000", "USD")).toEqual({ money: { minor: 4_000_000, currency: "USD" } });
    expect(parseKinMoney("A$12", "INR")).toEqual({ money: { minor: 1_200, currency: "AUD" } });
    expect(parseKinMoney("US$12", "INR")).toEqual({ money: { minor: 1_200, currency: "USD" } });
    expect(parseKinMoney("120 for web", "INR")).toHaveProperty("error");
    expect(parseKinMoney("PKR\u00a01500.50", "INR")).toHaveProperty("error");
    expect(parseKinMoney("$5 and ₹5", "INR")).toHaveProperty("error");
  });

  // K005: a comma or dot is read as one grouping only, and a form that fits none is refused.
  it.each([
    ["USD 12,00", "INR", 1_200, "USD"],
    ["1.234,56 EUR", "INR", 123_456, "EUR"],
    ["1.234.567,89", "EUR", 123_456_789, "EUR"],
    ["1,234,567.89", "USD", 123_456_789, "USD"],
    ["12,34,567.89", "INR", 123_456_789, "INR"],
    ["12,000", "USD", 1_200_000, "USD"],
    ["JPY 1,500", "INR", 1_500, "JPY"],
    ["-20", "INR", -2_000, "INR"],
  ] as const)("reads %s one way", (text, fallback, minor, currency) => {
    expect(parseKinMoney(text, fallback)).toEqual({ money: { minor, currency } });
  });
  it.each([
    ["12,00,0", "INR", "12,00,0 is not an amount. Write it as 12000 or 120.00."],
    ["JPY 12,00", "INR", "JPY 12,00 is not an amount. Write it as 1200 or 1,200."],
    ["1,2,3", "USD", "1,2,3 is not an amount. Write it as 123 or 1.23."],
    ["a lot", "INR", "a lot is not an amount. Give a number such as 4200, 4,200.50 or 12k."],
  ] as const)("refuses %s, showing how to write it", (text, fallback, error) => {
    expect(parseKinMoney(text, fallback)).toEqual({ error });
  });

  // K146: a title names money only when the figure carries a currency's mark.
  it.each([
    ["Chase Orbit Dental: 4,200 owed", false],
    ["Send 0 INR refund notice", true],
    ["Taxi ₹450", true],
    ["Pay 45k to the vendor", true],
    ["Try 3 options for the top 3", false],
    ["Q3 plan for 2026", false],
  ] as const)("%s names money: %s", (title, named) => {
    expect(mentionsKinMoney(title)).toBe(named);
  });

  it("writes an axis compactly in the currency's own grouping", () => {
    expect(formatKinMoney(42_000_000, "INR", { style: "compact" })).toBe("₹4.2L");
    expect(formatKinMoney(150_000_000, "USD", { style: "compact" })).toBe("$1.5M");
    expect(formatKinMoney(-1_200, "JPY", { style: "compact", minus: "−" })).toBe("−¥1.2K");
  });
});

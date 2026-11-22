import { assert, describe, it } from "@effect/vitest";

import {
  type ExpenseCandidate,
  type InvoiceCandidate,
  matchRows,
  suggest,
  vendorOf,
} from "./statementMatch.ts";
import type { StatementRow } from "./statementTable.ts";

// Invented clients, vendors and amounts.
const row = (over: Partial<StatementRow>): StatementRow => ({
  index: 0,
  date: "2026-10-05",
  description: "",
  reference: null,
  amountMinor: 0,
  direction: "credit",
  balanceMinor: null,
  foreign: null,
  ...over,
});
const invoice = (over: Partial<InvoiceCandidate>): InvoiceCandidate => ({
  recordId: "rec_inv",
  key: "INV-1",
  title: "Retainer",
  currency: "INR",
  amountMinor: 0,
  paidMinor: 0,
  taxMinor: null,
  issued: "2026-09-30",
  client: null,
  number: null,
  seen: "0:",
  ...over,
});
const expense = (over: Partial<ExpenseCandidate>): ExpenseCandidate => ({
  recordId: "rec_exp",
  key: "EXP-1",
  title: "Hosting",
  currency: "INR",
  amountMinor: 0,
  day: "2026-10-03",
  due: null,
  open: true,
  vendor: null,
  repeats: false,
  ...over,
});
const match = (
  rows: ReadonlyArray<StatementRow>,
  invoices: ReadonlyArray<InvoiceCandidate> = [],
  expenses: ReadonlyArray<ExpenseCandidate> = [],
  withholdsAtSource = true,
) =>
  matchRows(rows, {
    currency: "INR",
    withholdsAtSource,
    invoices,
    expenses,
    ownAccounts: ["7710"],
    known: [{ vendor: "Priya Nair", category: "contractors" }],
    bank: "HDFC Bank",
  });

describe("statement matching", () => {
  it.each([
    {
      name: "a credit matching a signed refund, not the same positive expense",
      rows: [row({ description: "Ambermill Hosting refund", amountMinor: 500 })],
      invoices: [],
      expenses: [
        expense({ amountMinor: -500, vendor: "Ambermill Hosting" }),
        expense({
          recordId: "rec_charge",
          key: "EXP-2",
          amountMinor: 500,
          vendor: "Ambermill Hosting",
        }),
      ],
      group: "matched",
      fit: "exact",
    },
    {
      name: "a credit of the exact balance from the named client",
      rows: [
        row({ description: "NEFT CR-ICIC0000001-BRIGHTLINE MEDIA LLP", amountMinor: 11_800_000 }),
      ],
      invoices: [invoice({ amountMinor: 11_800_000, client: "Brightline Media LLP" })],
      expenses: [],
      group: "matched",
      fit: "exact",
    },
    {
      name: "a credit of the invoice less 10% TDS",
      rows: [
        row({
          description: "NEFT CR-UTIB0000002-NORTHWIND RETAIL PVT LTD",
          amountMinor: 9_000_000,
        }),
      ],
      invoices: [invoice({ amountMinor: 10_000_000, client: "Northwind Retail Pvt Ltd" })],
      expenses: [],
      group: "matched",
      fit: "tds",
    },
    {
      name: "the same short credit for a company whose country withholds no tax at source",
      rows: [
        row({
          description: "NEFT CR-UTIB0000002-NORTHWIND RETAIL PVT LTD",
          amountMinor: 9_000_000,
        }),
      ],
      invoices: [invoice({ amountMinor: 10_000_000, client: "Northwind Retail Pvt Ltd" })],
      expenses: [],
      withholds: false,
      group: "choose",
      fit: "part",
    },
    {
      name: "TDS on the amount before GST",
      rows: [row({ description: "NEFT CR-ACME", amountMinor: 10_800_000 })],
      invoices: [invoice({ amountMinor: 11_800_000, taxMinor: 1_800_000, client: "Acme" })],
      expenses: [],
      group: "matched",
      fit: "tds",
    },
    {
      name: "two open invoices of the same amount and no name",
      rows: [row({ description: "NEFT CR-SOMEONE", amountMinor: 5_000_000 })],
      invoices: [
        invoice({ recordId: "a", key: "INV-2", amountMinor: 5_000_000 }),
        invoice({ recordId: "b", key: "INV-3", amountMinor: 5_000_000 }),
      ],
      expenses: [],
      group: "choose",
      fit: "exact",
    },
    {
      name: "a credit before the invoice was issued",
      rows: [row({ date: "2026-09-01", description: "NEFT CR-BRIGHTLINE", amountMinor: 100 })],
      invoices: [invoice({ amountMinor: 100, client: "Brightline" })],
      expenses: [],
      group: "unmatched",
      fit: undefined,
    },
    {
      name: "a subscription debit on its billing day",
      rows: [
        row({
          direction: "debit",
          description: "UPI-GITHUB-github@invbank",
          amountMinor: 336_000,
          date: "2026-10-24",
        }),
      ],
      invoices: [],
      expenses: [
        expense({
          amountMinor: 336_000,
          day: null,
          due: "2026-10-22",
          vendor: "GitHub",
          repeats: true,
        }),
      ],
      group: "matched",
      fit: "exact",
    },
    {
      name: "a card's foreign spend against the expense in dollars",
      rows: [
        row({
          direction: "debit",
          description: "FIGMA.COM SAN FRANCISCO USD 15.00",
          amountMinor: 131_250,
          date: "2026-09-22",
          foreign: { currency: "USD", amountMinor: 1_500 },
        }),
      ],
      invoices: [],
      expenses: [
        expense({ currency: "USD", amountMinor: 1_500, day: "2026-09-22", vendor: "Figma" }),
      ],
      group: "matched",
      fit: "foreign",
    },
    {
      name: "an INR credit for a dollar invoice, its USD amount in the narration",
      rows: [
        row({
          description: "INWARD REMIT NORTHSTAR LABS USD 2500.00",
          amountMinor: 20_750_000,
          foreign: { currency: "USD", amountMinor: 250_000 },
        }),
      ],
      invoices: [invoice({ currency: "USD", amountMinor: 250_000, client: "Northstar Labs" })],
      expenses: [],
      group: "matched",
      fit: "foreign",
    },
    {
      name: "an INR credit for a dollar invoice with no dollar amount to prove it",
      rows: [row({ description: "INWARD REMIT NORTHSTAR LABS", amountMinor: 20_750_000 })],
      invoices: [invoice({ currency: "USD", amountMinor: 250_000, client: "Northstar Labs" })],
      expenses: [],
      group: "unmatched",
      fit: undefined,
    },
    {
      name: "a debit with no expense of its amount",
      rows: [
        row({ direction: "debit", description: "UPI-SWIGGY-swiggy@invbank", amountMinor: 54_704 }),
      ],
      invoices: [],
      expenses: [expense({ amountMinor: 99_900 })],
      group: "unmatched",
      fit: undefined,
    },
  ] as const)("$name", ({ rows, invoices, expenses, group, fit, ...rest }) => {
    const [result] = match(rows, invoices, expenses, "withholds" in rest ? rest.withholds : true);
    assert.strictEqual(result!.group, group);
    assert.strictEqual(result!.candidates[0]?.fit, fit);
  });

  it("records the TDS deducted, and gives one entry to one row", () => {
    const [tds] = match(
      [row({ description: "NEFT CR-NORTHWIND", amountMinor: 9_000_000 })],
      [invoice({ amountMinor: 10_000_000, client: "Northwind" })],
    );
    assert.strictEqual(tds!.candidates[0]!.tdsMinor, 1_000_000);
    const both = match(
      [
        row({ index: 0, description: "NEFT CR-BRIGHTLINE MEDIA", amountMinor: 500_000 }),
        row({ index: 1, description: "NEFT CR-BRIGHTLINE MEDIA", amountMinor: 500_000 }),
      ],
      [invoice({ amountMinor: 500_000, client: "Brightline Media" })],
    );
    assert.deepStrictEqual(
      both.map((one) => one.group),
      ["matched", "unmatched"],
    );
  });

  it("finds a credit's payment already recorded by hand, by its reference", () => {
    const [found] = matchRows(
      [
        row({
          description: "NEFT CR-KAVERI FOODS",
          reference: "INVUTR26319004471",
          amountMinor: 10_000_000,
        }),
      ],
      {
        currency: "INR",
        withholdsAtSource: true,
        invoices: [],
        payments: [
          {
            paymentId: "pay_1",
            recordId: "rec_inv",
            key: "INV-1",
            title: "Retainer",
            currency: "INR",
            amountMinor: 10_000_000,
            paidOn: "2026-10-04",
            note: "UTR INVUTR26319004471",
            client: "Kaveri Foods",
          },
        ],
        expenses: [],
        ownAccounts: [],
        known: [],
        bank: null,
      },
    );
    assert.strictEqual(found!.group, "matched");
    assert.include(found!.candidates[0], { fit: "recorded", paymentId: "pay_1", key: "INV-1" });
  });

  it.each([
    ["IMPS-627812345-SELF-XXXXXXXX7710-OWN ACCOUNT", "transfer", undefined, undefined],
    // F30: a salary is the company's cost, never ignored.
    ["NEFT DR-HDFC0001234-MEERA IYER-SALARY NOV", "expense", "Meera Iyer", "salaries"],
    ["SMS CHGS JUL-SEP 26 INCL GST", "expense", "HDFC Bank", "fees"],
    ["CBDT TDS PAYMENT-CHALLAN 26101", "expense", "Tax payment", "taxes"],
    [
      "UPI-AMAZON WEB SERVICES-aws@invbank-SUBSCRIPTION",
      "expense",
      "Amazon Web Services",
      "software",
    ],
    ["NEFT DR-SBIN0000003-PRIYA NAIR-OCT DESIGN RETAINER", "expense", "Priya Nair", "contractors"],
    ["POS 4321XXXXXXXX7710 FIGMA INC", "expense", "Figma Inc", "software"],
    ["UPI-UBER INDIA-uberindia@invbank", "expense", "Uber India", "travel"],
  ] as const)("suggests what %s is", (description, action, vendor, category) => {
    const shown = suggest(row({ direction: "debit", description, amountMinor: 100 }), {
      ownAccounts: ["7710"],
      known: [{ vendor: "Priya Nair", category: "contractors" }],
      bank: "HDFC Bank",
    });
    assert.strictEqual(shown.action, action);
    assert.strictEqual(shown.vendor, vendor);
    assert.strictEqual(shown.category, category);
  });

  it("repays a partner's oldest owed expenses a debit adds up to, lump sum after lump sum", () => {
    const owed = (key: string, amountMinor: number) => ({
      recordId: `rec_${key}`,
      key,
      amountMinor,
    });
    const partners = [
      {
        name: "Meera Rao",
        currency: "INR",
        owed: [owed("EXP-4", 120_000), owed("EXP-7", 80_000), owed("EXP-9", 50_000)],
      },
    ];
    const debit = (index: number, date: string, description: string, amountMinor: number) =>
      row({ index, date, description, amountMinor, direction: "debit" });
    const rows = [
      // Listed newest first, as many banks do: the earlier lump sum still settles the oldest.
      debit(0, "2026-10-20", "IMPS-MEERA RAO-REIMB", 50_000),
      debit(1, "2026-10-08", "NEFT DR-UTIB0000001-MEERA RAO", 200_000),
      debit(2, "2026-10-09", "UPI-SOMEONE ELSE", 120_000),
    ];
    const results = matchRows(rows, {
      currency: "INR",
      withholdsAtSource: true,
      invoices: [],
      expenses: [],
      partners,
      ownAccounts: [],
      known: [],
      bank: null,
    });
    assert.deepStrictEqual(
      results.map((one) => [one.group, one.candidates.map((c) => c.repays?.map((r) => r.key))]),
      [
        ["matched", [["EXP-9"]]],
        ["matched", [["EXP-4", "EXP-7"]]],
        // The oldest is already taken by the earlier lump sum, and nothing names her.
        ["unmatched", []],
      ],
    );
    const only = (rows: ReadonlyArray<ReturnType<typeof debit>>, owing = partners) =>
      matchRows(rows, {
        currency: "INR",
        withholdsAtSource: true,
        invoices: [],
        expenses: [],
        partners: owing,
        ownAccounts: [],
        known: [],
        bank: null,
      }).map((one) => [one.group, one.candidates.map((c) => c.repays?.map((r) => r.key))]);
    // An amount alone, to someone the narration names instead, is no repayment.
    assert.deepStrictEqual(only([debit(0, "2026-10-08", "NEFT DR-UTIB0000001-SOMEONE", 120_000)]), [
      ["unmatched", []],
    ]);
    // Two the same day, listed opposite to how they settle: each still finds its run.
    assert.deepStrictEqual(
      only([
        debit(0, "2026-10-08", "MEERA RAO", 50_000),
        debit(1, "2026-10-08", "MEERA RAO", 200_000),
      ]),
      [
        ["matched", [["EXP-9"]]],
        ["matched", [["EXP-4", "EXP-7"]]],
      ],
    );
    // A repayment that isn't its row's clear match moves nobody past it: no later row skips ahead.
    const twins = [
      partners[0]!,
      { name: "Meera Rao", currency: "INR", owed: [owed("EXP-30", 120_000)] },
    ];
    assert.deepStrictEqual(
      only(
        [debit(0, "2026-10-08", "MEERA RAO", 120_000), debit(1, "2026-10-09", "MEERA RAO", 80_000)],
        twins,
      ),
      [
        ["choose", [["EXP-30"], ["EXP-4"]]],
        ["unmatched", []],
      ],
    );
    const skips = matchRows([debit(0, "2026-10-08", "MEERA RAO", 80_000)], {
      currency: "INR",
      withholdsAtSource: true,
      invoices: [],
      expenses: [],
      partners,
      ownAccounts: [],
      known: [],
      bank: null,
    });
    assert.deepStrictEqual(skips[0]!.candidates, []);

    // Two partners, two currencies: each line settles only its own currency's run, by name.
    const both = [
      ...partners,
      { name: "Dev Malhotra", currency: "INR", owed: [owed("EXP-5", 50_000)] },
      { name: "Meera Rao", currency: "USD", owed: [owed("EXP-6", 3_000)] },
      // A refund to her card after the company paid her back: she owes the company the net.
      { name: "Zoya Sheikh", currency: "INR", owed: [owed("EXP-8", -20_000)] },
    ];
    const lines = matchRows(
      [
        debit(0, "2026-10-08", "NEFT DR-DEV MALHOTRA", 50_000),
        debit(1, "2026-10-08", "NEFT DR-MEERA RAO", 30_000),
        row({
          index: 2,
          date: "2026-10-09",
          description: "NEFT CR-ZOYA SHEIKH-REFUND",
          amountMinor: 20_000,
          direction: "credit",
        }),
        // Less than her oldest, and more than all she is owed: no run adds up, nothing is used.
        debit(3, "2026-10-10", "NEFT DR-MEERA RAO", 100_000),
        debit(4, "2026-10-11", "NEFT DR-MEERA RAO", 900_000),
      ],
      {
        currency: "INR",
        withholdsAtSource: true,
        invoices: [],
        expenses: [],
        partners: both,
        ownAccounts: [],
        known: [],
        bank: null,
      },
    );
    assert.deepStrictEqual(
      lines.map((one) => [
        one.group,
        one.candidates.map((c) => [c.title, c.repays?.map((r) => r.key)]),
      ]),
      [
        // It equals her newest too, but only his oldest run adds up to it.
        ["matched", [["Repays Dev Malhotra: 1 expense", ["EXP-5"]]]],
        // Her USD 30.00 is not an INR line's to settle.
        ["unmatched", []],
        ["matched", [["Settles with Zoya Sheikh: 1 expense", ["EXP-8"]]]],
        ["unmatched", []],
        ["unmatched", []],
      ],
    );
    // What she is owed stays in view on those lines, and neither is offered as a new expense.
    assert.deepStrictEqual(lines[3]!.suggestion, {
      action: "later",
      why: "Meera Rao is owed ₹2,500.00 for 3 expenses; no run of the oldest adds up to this line, so mark what it pays back on those expenses",
    });
    assert.strictEqual(lines[4]!.suggestion.action, "later");

    // Exact sums: as numbers, MAX + 2 - MAX rounds to 1 and a one-cent line would settle all three.
    const huge = [
      {
        name: "Meera Rao",
        currency: "INR",
        owed: [
          owed("EXP-11", Number.MAX_SAFE_INTEGER),
          owed("EXP-12", 2),
          owed("EXP-13", -Number.MAX_SAFE_INTEGER),
        ],
      },
    ];
    assert.deepStrictEqual(only([debit(0, "2026-10-08", "MEERA RAO", 1)], huge), [
      ["unmatched", []],
    ]);
    // A move to the company's own account that names her repays nothing and stays a transfer.
    const own = matchRows(
      [debit(0, "2026-10-08", "SELF TRANSFER TO OWN ACCOUNT XX7710 MEERA RAO", 120_000)],
      {
        currency: "INR",
        withholdsAtSource: true,
        invoices: [],
        expenses: [],
        partners,
        ownAccounts: ["7710"],
        known: [],
        bank: null,
      },
    );
    assert.deepStrictEqual(
      own.map((one) => [one.group, one.candidates.length, one.suggestion.action]),
      [["unmatched", 0, "transfer"]],
    );
    // Ticked only for an unambiguous payee: a whole name one partner answers to, or a stored id.
    const meeras = [
      { name: "Meera Iyer", id: "person:meera", currency: "INR", owed: [owed("EXP-21", 10_000)] },
      { name: "Meera Shah", id: "person:shah", currency: "INR", owed: [owed("EXP-22", 20_000)] },
    ];
    assert.deepStrictEqual(
      [
        only([debit(0, "2026-10-08", "REIMBURSE MEERA", 10_000)], meeras),
        only([debit(0, "2026-10-08", "REIMBURSE MEERA", 10_000)], [meeras[0]!]),
        only([debit(0, "2026-10-08", "NEFT DR-MEERA IYER", 10_000)], meeras),
        only(
          [debit(0, "2026-10-08", "IMPS MEERA meera@invented.example", 10_000)],
          [{ ...meeras[0]!, name: "M. I.", ids: ["meera@invented.example"] }],
        ),
      ],
      [
        [["choose", [["EXP-21"]]]],
        [["choose", [["EXP-21"]]]],
        [["matched", [["EXP-21"]]]],
        [["matched", [["EXP-21"]]]],
      ],
    );
    assert.deepStrictEqual(only([debit(0, "2026-10-08", "MEERA RAO", 2)], huge), [
      ["matched", [["EXP-11", "EXP-12", "EXP-13"]]],
    ]);
  });

  it("reads vendors the way banks write them", () => {
    assert.strictEqual(vendorOf("UPI/DR/412345/ZOMATO LTD/YESB/zomato@yes"), "Zomato Ltd");
    assert.strictEqual(vendorOf("ACH D- INVENTED INSURANCE CO-POLICY 88"), "Invented Insurance Co");
    // F29: the bank's own words before the payee are not its name.
    assert.strictEqual(vendorOf("UPI DR 412345 CLOUDNEST"), "Cloudnest");
    assert.strictEqual(vendorOf("DR FIGMA INC"), "Figma Inc");
    assert.strictEqual(vendorOf("POS DR THIRD WAVE COFFEE"), "Third Wave Coffee");
    // A card statement's line is often just the merchant and its city.
    assert.strictEqual(vendorOf("NETFLIX.COM MUMBAI"), "Netflix");
    // W-26: a narration no rail or channel word explains names nobody, and a generic word isn't one.
    assert.strictEqual(vendorOf("BEING AMOUNT PAID TOWARDS MAINTENANCE NOV"), undefined);
    assert.strictEqual(vendorOf("CHQ PAID 004512 CLEARING"), undefined);
    assert.strictEqual(vendorOf("BIL/INVOICE 22"), undefined);
    // An older expense's junk vendor is never offered again, since Kin would refuse it.
    const junk = suggest(
      row({ direction: "debit", description: "UPI-INVOICE-PAY", amountMinor: 1 }),
      {
        ownAccounts: [],
        known: [{ vendor: "Invoice", category: "software" }],
        bank: null,
      },
    );
    assert.strictEqual(junk.vendor, undefined);
  });
});

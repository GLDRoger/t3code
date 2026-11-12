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
) =>
  matchRows(rows, {
    currency: "INR",
    invoices,
    expenses,
    ownAccounts: ["7710"],
    known: [{ vendor: "Priya Nair", category: "contractors" }],
    bank: "HDFC Bank",
  });

describe("statement matching", () => {
  it.each([
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
      name: "a debit with no expense of its amount",
      rows: [
        row({ direction: "debit", description: "UPI-SWIGGY-swiggy@invbank", amountMinor: 54_704 }),
      ],
      invoices: [],
      expenses: [expense({ amountMinor: 99_900 })],
      group: "unmatched",
      fit: undefined,
    },
  ] as const)("$name", ({ rows, invoices, expenses, group, fit }) => {
    const [result] = match(rows, invoices, expenses);
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

  it.each([
    ["IMPS-627812345-SELF-XXXXXXXX7710-OWN ACCOUNT", "transfer", undefined, undefined],
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

  it("reads vendors the way banks write them", () => {
    assert.strictEqual(vendorOf("UPI/DR/412345/ZOMATO LTD/YESB/zomato@yes"), "Zomato Ltd");
    assert.strictEqual(vendorOf("ACH D- INVENTED INSURANCE CO-POLICY 88"), "Invented Insurance Co");
  });
});

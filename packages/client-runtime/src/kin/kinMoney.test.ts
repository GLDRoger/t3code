import {
  KinListId,
  KinRecordId,
  type KinListDefinition,
  type KinMoneySummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinCompanyDraftOf, kinCompanyInput } from "./kinCompanyProfile.ts";
import { kinDatesMonth, kinMonthWindow, kinZonedDayStart } from "./kinDates.ts";
import { kinMoneyAgent, kinMoneyHeadline, kinMoneyView } from "./kinMoney.ts";

// Invented clients and figures only.
const inr = (minor: number) => [{ minor, currency: "INR" }];
const list = (id: string): KinListDefinition => ({
  list: KinListId.make(id),
  name: id as KinListDefinition["name"],
  prefix: "X",
  builtIn: false,
  states: ["open", "waiting", "done", "dropped"],
  stateLabels: {},
  defaultState: "open",
  categories: [],
  fields: [],
  sensitive: true,
  amount: true,
  currency: "INR",
  archivedAt: null,
  rev: 0,
  open: 0,
});
const months = Array.from({ length: 12 }, (_, index) =>
  index === 0 ? "2025-12" : `2026-${String(index).padStart(2, "0")}`,
);
const summary: KinMoneySummary = {
  asOf: "2026-11-12T06:00:00.000Z",
  timeZone: "Asia/Kolkata",
  thisMonth: "2026-11",
  lastMonth: "2026-10",
  financialYear: "FY2026-27",
  owed: {
    total: [...inr(21_000_000), { minor: 250_000, currency: "USD" }],
    overdue: inr(6_000_000),
    invoices: 3,
    overdueInvoices: 1,
    byClient: [
      {
        party: { recordId: KinRecordId.make("rec"), key: "C-1", title: "Acme Foods" as never },
        owed: inr(6_000_000),
        overdue: inr(6_000_000),
        invoices: 1,
        oldestOverdueDays: 45,
      },
    ],
  },
  received: { thisMonth: inr(4_000_000), lastMonth: [] },
  receivedThisFinancialYear: inr(90_000_000),
  spent: {
    thisMonth: {
      total: inr(4_821_000),
      byCategory: [
        { category: "travel" as never, total: inr(4_000_000) },
        { category: null, total: inr(821_000) },
      ],
    },
    lastMonth: { total: inr(3_000_000), byCategory: [] },
  },
  spentThisFinancialYear: inr(30_000_000),
  upcoming: [],
  upcomingTotal: 0,
  series: months.map((month) => ({
    month,
    received: month === "2026-11" ? [...inr(4_000_000), { minor: 100, currency: "USD" }] : [],
    spent: month === "2026-11" ? inr(4_821_000) : [],
  })),
};

describe("the Money summary", () => {
  it("opens the entries behind each figure, and only where their list exists", () => {
    const view = kinMoneyView(summary, [list("invoices"), list("expenses")]);
    expect(view.owed.lines).toEqual(["₹2,10,000", "$2,500"]);
    expect(view.overdue.open?.filter).toMatchObject({ show: "waiting", late: true });
    expect(view.clients[0]).toMatchObject({
      name: "Acme Foods",
      overdue: "₹60,000 overdue by 45 days",
      open: { list: "invoices", filter: { show: "waiting", party: { key: "C-1" } } },
    });
    expect(view.received.note).toBe("Nothing last month");
    expect(view.received.open?.filter.paid).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(view.categories[0]!.open).toMatchObject({
      list: "expenses",
      filter: { show: "done", category: "travel", period: { from: "2026-11-01" } },
    });
    expect(view.yearSpent.open?.filter.period).toEqual({ from: "2026-04-01", to: "2027-03-31" });
    // Two currencies moved, so two charts: they never share an axis.
    expect(view.charts.map((chart) => chart.unit)).toEqual([
      { kind: "money", currency: "INR" },
      { kind: "money", currency: "USD" },
    ]);
    expect(view.months[0]).toMatchObject({ month: "2026-11", received: "₹40,000 and $1" });
    expect(kinMoneyView(summary, []).owed.open).toBeNull();
    // TDS stands on its own, never inside Received.
    expect([view.tdsDeducted, view.yearTdsDeducted]).toEqual([null, null]);
    const withTds = kinMoneyView(
      {
        ...summary,
        tdsDeducted: { thisMonth: inr(1_000_000), lastMonth: [] },
        tdsDeductedThisFinancialYear: inr(1_000_000),
      },
      [list("invoices")],
    );
    expect(withTds.tdsDeducted).toMatchObject({ label: "TDS deducted", lines: ["₹10,000"] });
    expect(withTds.received.lines).toEqual(view.received.lines);
    expect(kinMoneyHeadline(summary)[0]).toBe("₹2,10,000 and $2,500 owed to us");
  });

  it("asks the agent that keeps the books, never a retired one", () => {
    const leads = [
      { name: "Finance", domain: "finance", retired: {} },
      { name: "Chief of staff", domain: "chief-of-staff" },
      { name: "Ledger", domain: "accounts" },
    ];
    expect(kinMoneyAgent(leads)?.name).toBe("Ledger");
    expect(kinMoneyAgent(leads.slice(0, 2))?.name).toBe("Chief of staff");
  });
});

describe("dates", () => {
  it("starts a month where the owner is, whatever zone the device is in", () => {
    expect(kinZonedDayStart("2026-11-01", "Asia/Kolkata").toISOString()).toBe(
      "2026-10-31T18:30:00.000Z",
    );
    expect(kinMonthWindow("2026-12", "Asia/Kolkata")).toEqual({
      from: "2026-11-30T18:30:00.000Z",
      to: "2026-12-31T18:30:00.000Z",
    });
  });

  it("lays a month out in whole weeks from Monday", () => {
    const names = { people: new Map(), agents: new Map(), me: null, zone: "Asia/Kolkata" };
    // @effect-diagnostics-next-line globalDate:off
    const { weeks } = kinDatesMonth("2026-11", [], names, new Date("2026-11-12T06:00:00.000Z"));
    expect(weeks).toHaveLength(6);
    expect(weeks[0]!.map((cell) => cell.number)).toEqual([26, 27, 28, 29, 30, 31, 1]);
    expect(
      weeks
        .flat()
        .filter((cell) => cell.today)
        .map((cell) => cell.day),
    ).toEqual(["2026-11-12"]);
  });
});

describe("company details", () => {
  const profile = {
    legalName: "Invented Studio Private Limited",
    tradeName: null,
    address: null,
    gstin: null,
    pan: null,
    placeOfSupply: null,
    sac: null,
    bank: {
      accountName: null,
      accountNumber: null,
      ifsc: "HDFC0001234",
      bankName: null,
      branch: null,
      upi: null,
    },
    rev: 4,
    updatedAt: null,
  } as never;
  it("sends only what changed, tidies ids, clears with null and names what is wrong", () => {
    const draft = kinCompanyDraftOf(profile);
    expect(kinCompanyInput("org" as never, profile, draft)).toEqual({ ok: true, input: null });
    expect(
      kinCompanyInput("org" as never, profile, {
        ...draft,
        gstin: "29abcde1234f1z5 ",
        ifsc: "",
        upi: "invented@hdfcbank",
      }),
    ).toEqual({
      ok: true,
      input: {
        orgId: "org",
        rev: 4,
        gstin: "29ABCDE1234F1Z5",
        bank: { ifsc: null, upi: "invented@hdfcbank" },
      },
    });
    expect(kinCompanyInput("org" as never, profile, { ...draft, pan: "ABCDE" })).toEqual({
      ok: false,
      problems: { pan: "A PAN is 10 characters, like ABCDE1234F." },
    });
  });
});

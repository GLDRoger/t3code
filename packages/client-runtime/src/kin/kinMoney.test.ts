import {
  KinListId,
  KinOrgId,
  KinRecordId,
  type KinCash,
  type KinListDefinition,
  type KinMoneySummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_COMPANY,
  kinCompanyCountrySuggestion,
  kinCompanyDraftOf,
  kinCompanyEditSections,
  kinCompanyDraftEdit,
  kinCompanyGlance,
  kinCompanyInput,
  kinCompanyRead,
  kinCountryName,
} from "./kinCompanyProfile.ts";
import { kinDatesMonth, kinMonthWindow, kinZonedDayStart } from "./kinDates.ts";
import { kinListFilterParam, kinListQuery } from "./kinLists.ts";
import {
  KIN_MONEY_BLOCKS,
  kinCashEmpty,
  kinListSettingsOnPhone,
  kinMoneyAgent,
  kinMoneyHeadline,
  kinMoneyView,
} from "./kinMoney.ts";

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
      filter: { show: "done", category: "travel", spent: { from: "2026-11-01" } },
    });
    expect(view.yearSpent.open?.filter.spent).toEqual({ from: "2026-04-01", to: "2027-03-31" });
    // The phone carries it in a link: what the figure counts arrives whole, and asks the host so.
    const spentYear = view.yearSpent.open!.filter;
    expect(kinListFilterParam(JSON.stringify(spentYear))).toEqual(spentYear);
    expect(kinListQuery(KinOrgId.make("org"), KinListId.make("expenses"), spentYear)).toMatchObject(
      {
        states: ["done"],
        kept: true,
        spentFrom: "2026-04-01",
        spentTo: "2027-03-31",
      },
    );
    // Two currencies moved, so two charts: they never share an axis.
    expect(view.charts.map((chart) => chart.unit)).toEqual([
      { kind: "money", currency: "INR" },
      { kind: "money", currency: "USD" },
    ]);
    expect(view.months[0]).toMatchObject({ month: "2026-11", received: "₹40,000 and $1" });
    expect(kinMoneyView(summary, []).owed.open).toBeNull();
    // Archived, Expenses still counts in Spent, so Spent still opens it.
    const archived = { ...list("expenses"), archivedAt: "2026-11-02T00:00:00.000Z" };
    expect(kinMoneyView(summary, [list("invoices"), archived]).yearSpent.open?.list).toBe(
      "expenses",
    );
    // Owing clients past those sent are one row, which loads them.
    expect(view.clientsMore).toBeNull();
    expect(
      kinMoneyView({ ...summary, owed: { ...summary.owed, byClientMore: 12 } }, []).clientsMore,
    ).toBe("12 more clients");
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
    // Past the newest suggestions shown, each list's rest opens on its suggestions only.
    const suggesting = kinMoneyView(
      {
        ...summary,
        suggested: [
          {
            record: { key: "INV-9", rev: 1, title: "Guess", list: "invoices" },
            listName: "Invoices",
          },
        ] as never,
        suggestedLists: [
          { list: "invoices", listName: "Invoices", count: 21 },
          { list: "expenses", listName: "Expenses", count: 1 },
          { list: "quotes", listName: "Quotes", count: 0 },
        ] as never,
      },
      [list("invoices")],
    );
    expect(suggesting.suggestedMore).toEqual([
      {
        label: "20 more in Invoices",
        open: { list: "invoices", filter: expect.objectContaining({ kept: false, show: "all" }) },
      },
      {
        label: "1 more in Expenses",
        open: { list: "expenses", filter: expect.objectContaining({ kept: false }) },
      },
    ]);
  });

  it("names and opens the company's own financial year", () => {
    const calendar = kinMoneyView({ ...summary, financialYear: "FY2026" }, [list("expenses")]);
    expect(calendar.yearLabel).toBe("FY 2026, January to December");
    expect(calendar.yearSpent.open?.filter.spent).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
    const july = kinMoneyView({ ...summary, financialYearStartMonth: 7 }, [list("expenses")]);
    expect(july.yearLabel).toBe("FY 2026–27, July to June");
    expect(july.yearSpent.open?.filter.spent).toEqual({ from: "2026-07-01", to: "2027-06-30" });
    // A host from before company years says none: April to March, as it always was.
    expect(kinMoneyView(summary, []).yearLabel).toBe("FY 2026–27, April to March");
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

  it("puts this month right after who owes us, and an empty bank in one line", () => {
    expect(KIN_MONEY_BLOCKS.slice(0, 3)).toEqual(["owed", "month", "suggested"]);
    const cash: KinCash = {
      asOf: "2026-11-12T06:00:00.000Z",
      today: "2026-11-12",
      timeZone: "Asia/Kolkata",
      known: false,
      accounts: [],
      notOfRecord: [],
      byCurrency: [],
    };
    expect(kinCashEmpty(cash)).toBe(true);
    expect(kinCashEmpty({ ...cash, bankKnown: { through: null } })).toBe(true);
    // Anything Kin knows of the bank keeps the whole block.
    expect(kinCashEmpty({ ...cash, bankKnown: { through: "2026-10-31" } })).toBe(false);
    expect(
      kinCashEmpty({
        ...cash,
        notOfRecord: [
          {
            label: "Invented current account",
            kind: "account",
            balance: { minor: 100, currency: "INR" },
            on: "2026-10-31",
            standing: "not yet confirmed",
          },
        ],
      }),
    ).toBe(false);
  });

  it("keeps the settings of Kin's own money lists for the computer", () => {
    expect(
      ["invoices", "expenses", "receipts", "quotes", "dates", "jobs"].map((id) =>
        kinListSettingsOnPhone(list(id)),
      ),
    ).toEqual([false, false, false, false, true, true]);
    expect(kinListSettingsOnPhone({ ...list("work"), builtIn: true })).toBe(false);
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
    country: "IN",
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
    }); // "Not registered" clears the GSTIN, a GSTIN typed unsays it, and the way back sends null.
    const unregistered = kinCompanyDraftEdit(
      { ...draft, gstin: "29ABCDE1234F1Z5" },
      "notRegistered",
      true,
    );
    expect([unregistered.gstin, unregistered.notRegistered]).toEqual(["", "yes"]);
    expect(kinCompanyInput("org" as never, profile, unregistered)).toEqual({
      ok: true,
      input: { orgId: "org", rev: 4, taxRegistered: false },
    });
    expect(kinCompanyDraftEdit(unregistered, "gstin", "29").notRegistered).toBe("");
    const said = { ...(profile as object), taxRegistered: false } as never;
    expect(kinCompanyDraftOf(said).notRegistered).toBe("yes");
    expect(
      kinCompanyInput(
        "org" as never,
        said,
        kinCompanyDraftEdit(kinCompanyDraftOf(said), "notRegistered", false),
      ),
    ).toEqual({ ok: true, input: { orgId: "org", rev: 4, taxRegistered: null } });
    // It reads as the GSTIN's answer, never as a gap.
    expect(
      kinCompanyRead(said)
        .flatMap((one) => one.rows)
        .filter((row) => row.id === "gstin" || row.id === "notRegistered"),
    ).toEqual([{ id: "gstin", label: "GSTIN", value: "Not registered for GST", missing: false }]);
    // What only a registered company fills is no gap to read and no field to fill.
    const bare = { ...(profile as object), taxRegistered: false, placeOfSupply: null } as never;
    expect(
      kinCompanyRead(bare)
        .flatMap((one) => one.rows)
        .map((row) => row.id),
    ).not.toContain("placeOfSupply");
    const offered = kinCompanyEditSections(said, kinCompanyDraftOf(said)).flatMap((section) =>
      section.fields.map((field) => field.id),
    );
    expect(offered).toContain("pan");
    for (const id of ["placeOfSupply", "sac", "lutNumber", "lutDate"])
      expect(offered).not.toContain(id);
  });

  it("asks for India's tax ids only in India, and for its own tax anywhere else", () => {
    const fields = (sections: ReturnType<typeof kinCompanyEditSections>) =>
      sections.flatMap((section) => section.fields.map((field) => field.id));
    const india = ["gstin", "pan", "placeOfSupply", "sac", "lutNumber", "lutDate", "ifsc", "upi"];
    const uk = {
      ...(profile as object),
      country: "GB",
      financialYearStartMonth: 4,
      tax: { name: "VAT", rate: "20", pricesInclude: null },
      homeCurrency: "GBP",
    } as never;
    const ukDraft = kinCompanyDraftOf(uk);
    expect(fields(kinCompanyEditSections(uk, ukDraft))).not.toContain("gstin");
    expect(fields(kinCompanyEditSections(uk, ukDraft))).toContain("taxRate");
    for (const id of india) expect(fields(kinCompanyEditSections(uk, ukDraft))).not.toContain(id);
    // The LUT's day reads as a day, as it does everywhere else, and is still edited as stored.
    const filed = { ...(profile as object), lutDate: "2026-04-01" } as never;
    expect(
      kinCompanyRead(filed)
        .flatMap((one) => one.rows)
        .find((row) => row.id === "lutDate")?.value,
    ).toBe("Apr 1, 2026");
    expect(kinCompanyDraftOf(filed).lutDate).toBe("2026-04-01");
    // What an invoice needs reads "Not set" while empty, so a missing GSTIN is seen; the rest
    // is left out. A UPI id is a way to be paid, so the account is then no gap.
    const read = (company: unknown) =>
      kinCompanyRead(company as never)
        .flatMap((one) => one.rows)
        .filter((row) => row.missing)
        .map((row) => row.id);
    expect(read(profile)).toEqual([
      "address",
      "gstin",
      "placeOfSupply",
      "accountName",
      "accountNumber",
      "bankName",
    ]);
    const upi = {
      ...(profile as { bank: object }),
      bank: { ...(profile as { bank: object }).bank, upi: "invented@hdfcbank" },
    };
    expect(read(upi)).toEqual(["address", "gstin", "placeOfSupply"]);
    expect(
      kinCompanyRead(profile)
        .flatMap((one) => one.rows)
        .find((row) => row.id === "gstin")?.value,
    ).toBe(KIN_COMPANY.notSet);
    // An IFSC kept from before shows only while the company is in India.
    expect(kinCompanyRead(uk).flatMap((one) => one.rows.map((row) => row.id))).not.toContain(
      "ifsc",
    );
    for (const country of [null, undefined]) {
      const unset = { ...(profile as object), country } as typeof uk;
      expect(fields(kinCompanyEditSections(unset, kinCompanyDraftOf(unset)))).not.toContain(
        "gstin",
      );
      expect(fields(kinCompanyEditSections(unset, kinCompanyDraftOf(unset)))).toContain("taxRate");
    }
    // Typing India brings its ids back.
    expect(fields(kinCompanyEditSections(uk, { ...ukDraft, country: "in" }))).toContain("gstin");
    expect(fields(kinCompanyEditSections(profile, kinCompanyDraftOf(profile)))).toContain("gstin");
    expect(fields(kinCompanyEditSections(profile, kinCompanyDraftOf(profile)))).not.toContain(
      "taxRate",
    );
    expect(
      kinCompanyInput("org" as never, uk, {
        ...ukDraft,
        taxRate: "17.5",
        financialYearStartMonth: "jan",
      }),
    ).toEqual({
      ok: true,
      input: {
        orgId: "org",
        rev: 4,
        financialYearStartMonth: 1,
        tax: { name: "VAT", rate: "17.5", pricesInclude: null },
      },
    });
    expect(kinCompanyInput("org" as never, uk, { ...ukDraft, taxName: "" })).toEqual({
      ok: false,
      problems: { taxName: "Name the tax this rate is for, like VAT." },
    });
    // A company that never saved its details is offered this device's country, and only it.
    const unsaved = { ...(uk as object), rev: 0 } as never;
    expect(kinCompanyDraftOf(unsaved, "US").country).toBe("US");
    expect(kinCompanyDraftOf(uk, "US").country).toBe("GB");
    expect(kinCompanyInput("org" as never, unsaved, kinCompanyDraftOf(unsaved, "US"))).toEqual({
      ok: true,
      input: { orgId: "org", rev: 0, country: "US" },
    });
    // A new company still waiting on its country only takes the device's with a tap: saving just
    // an address saves the address and leaves it waiting.
    const waiting = { ...(profile as object), country: null, rev: 0 } as never;
    const fresh = kinCompanyDraftOf(waiting, "IN", true);
    expect(fresh.country).toBe("");
    expect(
      kinCompanyInput("org" as never, waiting, { ...fresh, address: "1 Invented Road" }),
    ).toEqual({ ok: true, input: { orgId: "org", rev: 0, address: "1 Invented Road" } });
    const offer = kinCompanyCountrySuggestion(fresh, "IN", true);
    expect(offer?.label).toBe("Use India?");
    // Settings reads the country by its name, and keeps a code no device can name.
    expect([kinCountryName("GB"), kinCountryName("QQ")]).toEqual(["United Kingdom", "QQ"]);
    expect(kinCompanyInput("org" as never, waiting, offer!.accept())).toEqual({
      ok: true,
      input: { orgId: "org", rev: 0, country: "IN" },
    });
    expect(kinCompanyCountrySuggestion({ ...fresh, country: "GB" }, "IN", true)).toBeNull();
    expect(kinCompanyCountrySuggestion(kinCompanyDraftOf(unsaved, "IN"), "IN", false)).toBeNull();
  });

  it("reads on the phone as one screen: the country in words, the company's own tax", () => {
    const glance = (company: unknown) =>
      kinCompanyGlance(company as never).map((section) => ({
        title: section.title,
        rows: section.rows.map((row) => `${row.label}: ${row.value}`),
      }));
    const india = { ...(profile as object), country: "IN", gstin: "29ABCDE1234F1Z5" };
    expect(glance(india)).toEqual([
      {
        title: "Company",
        rows: ["Legal name: Invented Studio Private Limited", "Registered address: Not set"],
      },
      {
        title: "Tax",
        rows: ["Country: India", "GSTIN: 29ABCDE1234F1Z5", "Place of supply: Not set"],
      },
      {
        title: "Bank",
        rows: [
          "Account name: Not set",
          "Account number: Not set",
          "IFSC: HDFC0001234",
          "Bank: Not set",
        ],
      },
    ]);
    const nz = {
      ...(profile as object),
      country: "NZ",
      tax: { name: "Invented levy", rate: "15", pricesInclude: null },
      bank: { ...(profile as { bank: object }).bank, accountNumber: "0212340123456700" },
    };
    const tax = glance(nz).find((section) => section.title === "Tax")?.rows;
    expect(tax).toEqual(["Country: New Zealand", "Tax charged: Invented levy at 15%"]);
    expect(JSON.stringify(glance(nz))).not.toMatch(/GST|IFSC/);
  });
});

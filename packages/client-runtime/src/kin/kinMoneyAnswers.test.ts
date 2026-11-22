// @effect-diagnostics globalDate:off - Fixtures build days relative to a fixed clock.
import {
  KinOrgId,
  type KinCash,
  type KinMoneyBudget,
  type KinRecord,
  type KinRunway,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_OUTLOOK,
  kinBudgetDraftOf,
  kinBudgetInput,
  kinBudgetRemoval,
  kinBudgetsSummary,
  kinBudgetsView,
  kinCashView,
  kinLinesInput,
  kinQuoteActions,
  kinQuoteRow,
  kinQuoteState,
  kinQuotesSummary,
  kinRunwayText,
} from "./kinMoneyAnswers.ts";

const orgId = KinOrgId.make("org");
const now = new Date("2026-11-15T06:00:00.000Z");
const rates = { home: "INR", rates: [{ currency: "USD", rate: "84", asOf: "2026-11-01" }] };
const inr = (minor: number) => ({ minor, currency: "INR" });

describe("kinQuoteState", () => {
  it("reads draft, sent, expired, accepted and declined from the quote's state and valid-until", () => {
    const at = (state: "open" | "waiting" | "done" | "dropped", dueAt: string | null) =>
      kinQuoteState({ state, dueAt }, now);
    expect([
      at("open", null),
      at("waiting", "2026-11-20T18:29:59.999Z"),
      at("waiting", "2026-11-10T18:29:59.999Z"),
      at("waiting", null),
      at("done", "2026-11-10T18:29:59.999Z"),
      at("dropped", null),
    ]).toEqual(["draft", "sent", "expired", "sent", "accepted", "declined"]);
    // A quote nobody kept was sent by nobody: it reads Suggested, and says so before Draft.
    const quote = (state: "open" | "waiting", confirmed: boolean) =>
      kinQuoteRow(
        {
          key: "QT-2",
          title: "Invented recall dashboard",
          list: "quotes",
          state,
          confirmed,
          dueAt: "2026-11-30T18:29:59.999Z",
        } as unknown as KinRecord,
        null,
        now,
      ).stateLabel;
    expect([quote("waiting", false), quote("open", false), quote("waiting", true)]).toEqual([
      "Suggested",
      "Suggested · Draft",
      "Sent",
    ]);
  });

  it("offers each way in with its way back", () => {
    expect(kinQuoteActions("accepted", true)).toMatchObject({ unaccept: true, accept: false });
    expect(kinQuoteActions("declined", true)).toMatchObject({
      undecline: true,
      makeInvoice: false,
      decline: false,
    });
    expect(kinQuoteActions("draft", false).send).toBe(false);
    expect(kinQuoteActions("accepted", true, true).makeInvoice).toBe(false);
  });
});

describe("kinLinesInput", () => {
  const line = {
    description: "Design",
    sac: "998391",
    quantity: "5",
    unit: "days",
    rate: "20,000",
  };
  it("takes SAC or HSN codes of 4 to 8 digits, and drops empty rows", () => {
    expect(kinLinesInput([line, { ...line, description: "", sac: "", rate: "" }], "INR")).toEqual({
      ok: true,
      lines: [
        { description: "Design", sac: "998391", quantity: "5", unit: "days", rate: "₹20,000.00" },
      ],
    });
    expect(kinLinesInput([{ ...line, sac: "" }], "INR")).toMatchObject({
      ok: true,
      lines: [{ sac: null }],
    });
    for (const sac of ["123", "123456789", "99A3"])
      expect(kinLinesInput([{ ...line, sac }], "INR")).toEqual({
        ok: false,
        problem: "Line 1: a SAC or HSN code is 4 to 8 digits.",
      });
    expect(kinLinesInput([], "INR")).toEqual({ ok: true, lines: null });
  });

  it("refuses a zero quantity and a rate in another currency", () => {
    expect(kinLinesInput([{ ...line, quantity: "0" }], "INR")).toMatchObject({ ok: false });
    expect(kinLinesInput([{ ...line, rate: "$200" }], "INR")).toMatchObject({ ok: false });
  });
});

describe("kinBudgets", () => {
  const budget = (
    budgetId: string,
    spent: number,
    limit: number,
    status: KinMoneyBudget["status"],
    currency = "INR",
  ): KinMoneyBudget => ({
    budgetId,
    category: "travel",
    project: null,
    limit: { minor: limit, currency },
    spent: { minor: spent, currency },
    expenses: 1,
    status,
  });

  it("puts over first, then near, each in its own currency with a foreign one's estimate", () => {
    const view = kinBudgetsView(
      {
        month: "2026-11",
        budgets: [budget("a", 100, 10_000, "ok", "USD"), budget("b", 1_200_000, 1_000_000, "over")],
      },
      null,
      rates,
    );
    expect(view.map((one) => [one.id, one.standing, one.estimate])).toEqual([
      ["b", "₹2,000 over", null],
      ["a", "$99 left", "about ₹8,400"],
    ]);
    const euros = kinBudgetsView(
      {
        month: "2026-11",
        budgets: [
          {
            ...budget("c", 30_000, 50_000, "ok", "USD"),
            notCounted: [{ currency: "EUR", spent: { minor: 76_800, currency: "EUR" } }],
          },
        ],
      },
      null,
      null,
    );
    expect(euros.map((one) => one.notCounted)).toEqual(["+ €768 not counted in this USD budget"]);
    // A project the host gives no name for is gone: never shown by its key.
    const nameless = { ...budget("d", 0, 100, "ok"), project: { key: "P-7", title: null } };
    expect(kinBudgetsView({ month: "2026-11", budgets: [nameless] }, null, null)[0]?.label).toBe(
      "travel in a removed project",
    );
    expect(kinBudgetDraftOf(nameless).project).toBeNull();
  });

  it("says in a line what is over or near, else that all are within their limits", () => {
    expect(kinBudgetsSummary([{ status: "over" }, { status: "near" }, { status: "ok" }])).toBe(
      "1 over, 1 near the limit",
    );
    expect(kinBudgetsSummary([{ status: "ok" }, { status: "ok" }])).toBe("2 within their limits");
    expect(kinQuotesSummary([{ state: "sent" }, { state: "expired" }], 4)).toBe(
      "4 open, 1 expired",
    );
    expect(kinQuotesSummary([], 0)).toBe("No open quotes");
  });

  it("needs a target and a limit, and removes by the same target and currency", () => {
    expect(
      kinBudgetInput(orgId, { category: null, project: null, limit: "5k" }, "INR", "r"),
    ).toMatchObject({ ok: false });
    expect(
      kinBudgetInput(orgId, { category: "travel", project: null, limit: "$200" }, "INR", "r"),
    ).toMatchObject({ ok: true, input: { currency: "USD", limitMinor: 20_000 } });
    expect(kinBudgetRemoval(orgId, budget("a", 0, 100, "ok", "USD"), "r")).toMatchObject({
      currency: "USD",
      limitMinor: null,
    });
  });
});

describe("kinCashView", () => {
  it("keeps each currency apart and says when two accounts can't be told apart", () => {
    const cash: KinCash = {
      asOf: "2026-11-15T06:00:00.000Z",
      today: "2026-11-15",
      timeZone: "Asia/Kolkata",
      known: true,
      accounts: [
        {
          label: "Invented Bank Account ••1111",
          kind: "account",
          balance: inr(50_000_00),
          on: "2026-10-31",
          ageDays: 15,
          stale: true,
          check: "adds_up",
          cannotTellApart: true,
          newerRead: null,
        },
        {
          label: "Invented Bank Account ••2222",
          kind: "account",
          balance: { minor: 1_000_00, currency: "USD" },
          on: "2026-11-10",
          ageDays: 5,
          stale: false,
          check: "adds_up",
          cannotTellApart: false,
          newerRead: {
            balance: { minor: 900_00, currency: "USD" },
            on: "2026-11-14",
            standing: "not yet confirmed",
          },
        },
      ],
      notOfRecord: [],
      byCurrency: [
        {
          currency: "INR",
          accounts: 2,
          total: null,
          since: "2026-10-31",
          sameDay: true,
          stale: true,
          receivedSince: inr(0),
          spentSince: inr(0),
          estimate: null,
        },
        {
          currency: "USD",
          accounts: 1,
          total: { minor: 1_000_00, currency: "USD" },
          since: "2026-11-10",
          sameDay: true,
          stale: false,
          receivedSince: { minor: 0, currency: "USD" },
          spentSince: { minor: 50_00, currency: "USD" },
          estimate: { minor: 950_00, currency: "USD" },
        },
      ],
    };
    const view = kinCashView(cash, rates, now);
    expect(view.accounts[0]!.notes[0]).toContain("can't tell this apart");
    expect(view.accounts[1]!.notes[0]).toContain("not yet confirmed");
    expect(view.accounts.map((one) => one.flag).slice(0, 2)).toEqual([
      "Looks like another account",
      "Newer statement to confirm",
    ]);
    expect(view.accounts[1]!.estimate).toBe("about ₹84,000");
    expect(view.currencies.map((one) => [one.currency, one.total, one.estimate])).toEqual([
      ["INR", null, null],
      ["USD", "$1,000.00", "$950"],
    ]);
    // How far Kin sees the bank, quietly; an older host says nothing, and with no balance at all
    // Money's own line already says no statement is confirmed.
    expect(view.bank).toBeNull();
    const bank = (known: boolean, through: string | null) =>
      kinCashView({ ...cash, known, bankKnown: { through } }, rates, now).bank;
    expect(bank(true, "2026-10-31")).toBe("Bank known to Oct 31");
    expect(bank(true, null)).toBe("Kin can't see the bank yet: upload a statement");
    expect(bank(false, null)).toBeNull();
  });
});

describe("kinCashView with bank alerts", () => {
  it("shows a newer alert's Avl bal as the balance, says it is one, and lists alert-only accounts", () => {
    const statement = {
      label: "HDFC Bank Account ••4821",
      kind: "account" as const,
      balance: inr(4_00_000_00),
      on: "2026-10-31",
      ageDays: 15,
      stale: true,
      check: "adds_up" as const,
      cannotTellApart: false,
      newerRead: null,
    };
    const cash: KinCash = {
      asOf: "2026-11-15T06:00:00.000Z",
      today: "2026-11-15",
      timeZone: "Asia/Kolkata",
      known: true,
      accounts: [
        { ...statement, alert: { balance: inr(4_10_250_50), at: "2026-11-14T08:35:09.000Z" } },
      ],
      notOfRecord: [],
      byCurrency: [],
      alertAccounts: [
        {
          label: "HDFC Bank ••9001",
          alert: { balance: inr(12_000_00), at: "2026-11-13T04:00:00.000Z" },
        },
      ],
    };
    const view = kinCashView(cash, rates, now);
    expect(view.accounts.map((one) => [one.label, one.amount, one.flag, one.stale])).toEqual([
      ["HDFC Bank Account ••4821", "₹4,10,250.50", "From a bank alert", false],
      ["HDFC Bank ••9001", "₹12,000.00", "From a bank alert", false],
    ]);
    expect(view.accounts[0]!.when).toMatch(/^From a bank alert · /);
    expect(view.accounts[0]!.notes).toEqual([
      "This is the available balance in the newest bank alert mail, not a confirmed statement. The last confirmed statement closed at ₹4,00,000.00 on Sat, Oct 31.",
    ]);
    // With no confirmed statement at all, an alert's balance is still a balance to show.
    expect(kinCashView({ ...cash, known: false, accounts: [] }, rates, now).known).toBe(true);
    expect(kinCashView({ ...cash, accounts: [statement] }, rates, now).accounts[0]!.amount).toBe(
      "₹4,00,000.00",
    );
  });
});

describe("kinRunwayText", () => {
  const runway: KinRunway = {
    currency: "INR",
    months: [],
    averageNet: inr(-100),
    balance: { money: inr(1_000), oldest: "2026-11-01", stale: false },
    withheld: false,
    enoughHistory: true,
    historySince: "2026-07-01",
    runwayTenths: 45,
  };
  it("gives months only with three full months of history", () => {
    expect(kinRunwayText(runway)).toBe(KIN_OUTLOOK.runwayMonths(45, "INR"));
    expect(
      kinRunwayText({ ...runway, runwayTenths: null, enoughHistory: false, historySince: null }),
    ).toBe("Runway needs three full months of history.");
  });
});

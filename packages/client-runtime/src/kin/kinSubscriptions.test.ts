// @effect-diagnostics globalDate:off - Fixtures build days relative to a fixed clock.
import {
  KinAgentId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinListDefinition,
  type KinRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { KinListContext } from "./kinLists.ts";
import {
  kinCycleStep,
  kinFinancialYearStart,
  kinRenewalsBetween,
  kinSubscriptionsList,
  kinSubscriptionsView,
} from "./kinSubscriptions.ts";

const def: KinListDefinition = {
  list: "subscriptions",
  name: "Subscriptions",
  prefix: "SUB",
  builtIn: false,
  states: ["open", "done", "dropped"],
  stateLabels: { open: "Active", dropped: "Cancelled" },
  defaultState: "open",
  categories: ["software"],
  fields: [
    {
      key: "billing",
      label: "Billing",
      type: "choice",
      choices: ["Monthly", "Yearly"],
      sensitive: false,
    },
    { key: "usedFor", label: "Used for", type: "text", sensitive: false },
    { key: "usedBy", label: "Used by", type: "person", sensitive: false },
  ],
  sensitive: false,
  amount: true,
  currency: "INR",
  dateLabel: "Renews on",
  archivedAt: null,
  rev: 1,
  open: 3,
};
const owner = KinPersonId.make("invented-owner");
const context: KinListContext = {
  names: { people: new Map([[owner, "Asha"]]), agents: new Map(), me: owner, zone: "UTC" },
  refs: new Map(),
  // 15 Nov 2026, local time.
  now: new Date(2026, 10, 15, 10, 0),
};
const day = (text: string) => new Date(`${text}T12:00:00`).toISOString();
const entry = (key: string, patch: Partial<KinRecord>): KinRecord => ({
  recordId: KinRecordId.make(`rec-${key}`),
  orgId: KinOrgId.make("org"),
  key,
  title: `Invented ${key}`,
  state: "open",
  waitingOn: null,
  owner: { _tag: "agent", agentId: KinAgentId.make("finance") },
  category: null,
  side: "ours",
  dueAt: null,
  dueAllDay: false,
  late: false,
  confirmed: true,
  sensitive: false,
  working: false,
  pullRequest: null,
  rev: 1,
  createdAt: day("2026-11-01"),
  updatedAt: day("2026-11-01"),
  closedAt: null,
  list: "subscriptions",
  ...patch,
});
const short = (month: number, date: number) =>
  new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(
    new Date(2026, month, date),
  );
const rates = { home: "INR", rates: [{ currency: "USD", rate: "84", asOf: "2026-11-10" }] };

describe("kinSubscriptions", () => {
  it("steps by months keeping the day where the month has it", () => {
    expect(kinCycleStep("2026-01-31", { months: 1 }, 1)).toBe("2026-02-28");
    expect(kinCycleStep("2026-03-31", { months: 12 }, -1)).toBe("2025-03-31");
    expect(kinRenewalsBetween("2026-11-20", { months: 1 }, "2026-04-01", "2026-11-15")).toEqual([
      "2026-04-20",
      "2026-05-20",
      "2026-06-20",
      "2026-07-20",
      "2026-08-20",
      "2026-09-20",
      "2026-10-20",
    ]);
  });

  it("counts the year so far from the company's own first month", () => {
    expect(kinFinancialYearStart(context.now)).toBe("2026-04-01");
    expect(kinFinancialYearStart(context.now, 7)).toBe("2026-07-01");
    expect(kinFinancialYearStart(new Date(2026, 5, 30), 7)).toBe("2025-07-01");
    expect(kinFinancialYearStart(new Date(2026, 0, 1), 1)).toBe("2026-01-01");
    // A ₹2,000 monthly plan renewing on the 20th: July to October in a year from July.
    const monthly = entry("SUB-1", {
      amount: { minor: 2_000_00, currency: "INR" },
      dateAt: day("2026-11-20"),
      fields: { billing: "Monthly" },
    });
    const soFar = (start: string) =>
      kinSubscriptionsView(def, [monthly], context, rates, start).yearSoFar.map(
        (line) => line.text,
      );
    expect(soFar(kinFinancialYearStart(context.now, 7))).toEqual(["₹8,000"]);
    expect(soFar(kinFinancialYearStart(context.now))).toEqual(["₹14,000"]);
  });

  it("finds the list by its name", () => {
    expect(kinSubscriptionsList([{ ...def, list: "tools", name: "Our subscriptions" }])?.list).toBe(
      "tools",
    );
    expect(kinSubscriptionsList([{ ...def, archivedAt: day("2026-11-01") }])).toBeNull();
  });

  it("keeps each currency's figures apart, counts yearly plans per month and says what renews", () => {
    const view = kinSubscriptionsView(
      def,
      [
        entry("SUB-1", {
          amount: { minor: 2_000_00, currency: "INR" },
          dateAt: day("2026-11-20"),
          fields: { billing: "Monthly", usedFor: "Design", usedBy: `person:${owner}` },
        }),
        entry("SUB-2", {
          amount: { minor: 125_00, currency: "USD" },
          dateAt: day("2027-03-01"),
          repeat: { every: "year" },
        }),
        entry("SUB-3", {
          amount: { minor: 10_00, currency: "USD" },
          dateAt: day("2026-12-05"),
          fields: { billing: "Monthly" },
          state: "dropped",
          closedAt: day("2026-11-10"),
        }),
        entry("SUB-4", { amount: { minor: 500_00, currency: "INR" } }),
        // A suggestion nobody kept is no subscription yet: no figure, count or renewal.
        entry("SUB-5", {
          amount: { minor: 9_000_00, currency: "INR" },
          dateAt: day("2026-11-25"),
          fields: { billing: "Monthly" },
          confirmed: false,
        }),
      ],
      context,
      rates,
      "2026-04-01",
    );
    expect(view.active.map((row) => [row.key, row.when, row.cycle])).toEqual([
      ["SUB-1", `Renews ${short(10, 20)}`, "Monthly"],
      [
        "SUB-2",
        `Renews ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date(2027, 2, 1))}`,
        "Yearly",
      ],
      ["SUB-4", "No renewal day", "Cycle not set"],
    ]);
    expect(view.active[0]).toMatchObject({ purpose: "Design", who: "You", amount: "₹2,000" });
    expect(view.active[1]?.estimate).toBe("about ₹10,500");
    expect(view.renewing.map((row) => row.key)).toEqual(["SUB-1"]);
    // Cancelled with a renewal still ahead: it runs until that day.
    expect(view.cancelled.map((row) => [row.key, row.when])).toEqual([
      ["SUB-3", `Ends ${short(11, 5)}`],
    ]);
    // $125 a year is $10.42 a month: an average, shown in whole dollars.
    expect(view.monthly.map((line) => [line.text, line.estimate])).toEqual([
      ["₹2,000", null],
      ["$10", "about ₹840"],
    ]);
    expect(view.monthlyAll).toBe("about ₹2,840 in all");
    expect(view.runRate.map((line) => line.text)).toEqual(["₹24,000", "$125"]);
    // Since April: seven monthly renewals of ₹2,000; SUB-3's monthly $10 from April to its end.
    expect(view.yearSoFar.map((line) => line.text)).toEqual(["₹14,000", "$80"]);
    expect(view.thisMonth.map((line) => line.text)).toEqual(["₹2,000", "$10"]);
    expect(view.uncounted).toBe(1);
    expect(view.summary).toBe("3 active · about ₹2,840 a month");
  });
});

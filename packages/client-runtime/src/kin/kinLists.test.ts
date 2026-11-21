import {
  formatKinMoney,
  KIN_CURRENCY_CODES,
  KinListId,
  KinOrgId,
  KinRecordId,
  type KinListDefinition,
  type KinRecord,
  type KinRecordDetail,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_LIST_DEFAULT_FILTER,
  kinFieldText,
  kinListColumns,
  kinListEditDraftOf,
  kinListEditInput,
  kinAmountCheck,
  kinFieldCheck,
  kinListEntryView,
  kinListFilterParam,
  kinListHeader,
  kinListFilterCleared,
  kinListFilterLabel,
  kinListNarrowings,
  kinMoneyDraft,
  kinParseMoney,
  kinPrincipalValue,
  kinListChips,
  kinListQuery,
  kinListRow,
  kinSuggestionKeep,
  kinMoneyText,
  kinPaymentCheck,
  kinPeriodLabel,
  kinTotalsText,
  type KinListContext,
  type KinListFieldView,
} from "./kinLists.ts";
import { formatKinChartValue } from "./kinChart.ts";

// Invented lists, people and amounts only.
const orgId = KinOrgId.make("org");
// @effect-diagnostics-next-line globalDate:off
const now = new Date("2026-11-12T10:00:00+05:30");
const context: KinListContext = {
  names: {
    people: new Map([["owner", "Asha"]]),
    agents: new Map([["fin", "Finance"]]),
    me: null,
    zone: "Asia/Kolkata",
  },
  refs: new Map([["rec-acme", { key: "C-1", title: "Acme Foods" }]]),
  now,
};

const list = (patch: Partial<KinListDefinition>): KinListDefinition => ({
  list: KinListId.make("equipment"),
  name: "Equipment" as KinListDefinition["name"],
  prefix: "EQ",
  builtIn: false,
  states: ["open", "done", "dropped"],
  stateLabels: { open: "In use" as never, done: "Returned" as never },
  defaultState: "open",
  categories: [],
  fields: [],
  sensitive: false,
  amount: false,
  currency: "INR",
  archivedAt: null,
  rev: 3,
  open: 2,
  ...patch,
});

const record = (patch: Partial<KinRecord>): KinRecord => ({
  recordId: KinRecordId.make("rec-1"),
  orgId,
  key: "EQ-1",
  title: "Standing desk" as KinRecord["title"],
  state: "open",
  waitingOn: null,
  owner: { _tag: "person", personId: "owner" as never },
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
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  closedAt: null,
  list: KinListId.make("equipment"),
  ...patch,
});

describe("money", () => {
  it("groups rupees in lakh and crore, keeps other currencies in thousands, and never mixes", () => {
    expect(kinMoneyText({ minor: 42_000_030, currency: "INR" })).toBe("₹4,20,000.30");
    expect(kinMoneyText({ minor: 1_25_00_000_00, currency: "INR" })).toBe("₹1,25,00,000");
    expect(kinMoneyText({ minor: 1_25_00_000_00, currency: "INR" }, true)).toBe("₹1,25,00,000.00");
    expect(kinMoneyText({ minor: 123_456_789, currency: "USD" })).toBe("$1,234,567.89");
    expect(
      kinTotalsText([
        { minor: 42_000_000, currency: "INR" },
        { minor: 1_300, currency: "USD" },
      ]),
    ).toBe("₹4,20,000 and $13");
    expect(kinTotalsText([])).toBe("Nothing");
  });

  // The apps read PKR, IDR and HUF with two decimals the server never wrote: 1,500 PKR was "PKR\u00a015".
  it("shows every currency's amount as the server and documents do", () => {
    for (const code of KIN_CURRENCY_CODES)
      for (const minor of [1_500, 123_456]) {
        expect([code, kinMoneyText({ minor, currency: code }, true)]).toEqual([
          code,
          formatKinMoney(minor, code, { cents: "always" }),
        ]);
        expect([code, formatKinChartValue({ kind: "money", currency: code }, minor)]).toEqual([
          code,
          formatKinMoney(minor, code),
        ]);
      }
    expect(kinMoneyText({ minor: 1_500, currency: "PKR" })).toBe("PKR\u00a01,500");
    expect(kinParseMoney("1,500", "PKR")).toEqual({ minor: 1_500, currency: "PKR" });
  });

  it("reads a typed amount into whole minor units, or refuses it", () => {
    expect(kinParseMoney("40,000", "INR")).toEqual({ minor: 4_000_000, currency: "INR" });
    expect(kinParseMoney("₹ 1,00,000.5", "INR")).toEqual({ minor: 10_000_050, currency: "INR" });
    expect(kinParseMoney("0.1", "INR")).toEqual({ minor: 10, currency: "INR" });
    expect(kinParseMoney("1200", "JPY")).toEqual({ minor: 1200, currency: "JPY" });
    expect(kinParseMoney("4.2 lakh", "INR")).toEqual({ minor: 42_000_000, currency: "INR" });
    for (const wrong of ["", "0", "12.345", "-5", "1.5"])
      expect(kinParseMoney(wrong, wrong === "1.5" ? "JPY" : "INR")).toBeNull();
  });

  it("refuses a payment over what is owed", () => {
    const left = { minor: 6_000_000, currency: "INR" };
    expect(kinPaymentCheck({ amount: "60,000", paidOn: "2026-11-12", note: "" }, left)).toEqual({
      ok: true,
      amount: left,
    });
    expect(kinPaymentCheck({ amount: "60,000.01", paidOn: "2026-11-12", note: "" }, left)).toEqual({
      ok: false,
      problem: "That's more than the ₹60,000.00 still owed.",
    });
    // TDS counts towards what is owed, and alone it may settle the rest.
    const day = { paidOn: "2026-11-12", note: "" };
    expect(kinPaymentCheck({ ...day, amount: "54,000", tds: "6,000" }, left)).toEqual({
      ok: true,
      amount: { minor: 5_400_000, currency: "INR" },
      tds: { minor: 600_000, currency: "INR" },
    });
    expect(kinPaymentCheck({ ...day, amount: "", tds: "6,000" }, left)).toMatchObject({
      ok: true,
      amount: { minor: 0 },
    });
    expect(kinPaymentCheck({ ...day, amount: "55,000", tds: "6,000" }, left).ok).toBe(false);
  });
});

describe("a list by its definition", () => {
  it("names whole months and financial years, and asks the host for exactly that", () => {
    expect(kinPeriodLabel({ from: "2026-02-01", to: "2026-02-28" })).toBe("February 2026");
    expect(kinPeriodLabel({ from: "2026-04-01", to: "2027-03-31" })).toBe("FY 2026–27");
    expect(
      kinListQuery(orgId, KinListId.make("expenses"), {
        ...KIN_LIST_DEFAULT_FILTER,
        show: "done",
        category: "travel",
        period: { from: "2026-11-01", to: "2026-11-30" },
        party: { key: "C-1", title: "Acme Foods" },
        groupBy: "month",
        text: "  cab ",
      }),
    ).toEqual({
      orgId,
      list: "expenses",
      states: ["done"],
      listCategory: "travel",
      dateFrom: "2026-11-01",
      dateTo: "2026-11-30",
      party: "C-1",
      text: "cab",
      totalsBy: "month",
    });
  });

  it("totals every match per currency and narrows to a group, with the way back", () => {
    const expenses = list({
      amount: true,
      categories: ["travel" as never],
      dateLabel: "Date" as never,
    });
    const filter = { ...KIN_LIST_DEFAULT_FILTER, groupBy: "month" as const };
    const totals = {
      total: [
        { minor: 42_000_030, currency: "INR" },
        { minor: 1_300, currency: "USD" },
      ],
      groups: [
        { group: "2026-10", count: 2, total: [{ minor: 30, currency: "INR" }] },
        { group: "2026-11", count: 1, total: [{ minor: 42_000_000, currency: "INR" }] },
      ],
    };
    const header = kinListHeader(expenses, filter, totals, 3);
    expect(header.totals).toEqual(["₹4,20,000.30", "$13"]);
    expect(header.groups.map((group) => [group.label, group.count, group.totals])).toEqual([
      ["November 2026", "1 entry", ["₹4,20,000"]],
      ["October 2026", "2 entries", ["₹0.30"]],
    ]);
    const narrowed = header.groups[0]!.narrowed!;
    expect(narrowed.period).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(kinListHeader(expenses, narrowed, totals, 1).groups[0]!.narrowed!.period).toBeNull();
    // A financial year's group runs from the company's first month: April where the host doesn't say.
    const byYear = { ...KIN_LIST_DEFAULT_FILTER, groupBy: "financialYear" as const };
    const years = {
      total: totals.total,
      groups: [{ group: "FY2026-27", count: 3, total: totals.total }],
    };
    const yearOf = (startMonth?: number) =>
      kinListHeader(expenses, byYear, years, 3, startMonth).groups[0]!.narrowed!.period!;
    expect(yearOf()).toEqual({ from: "2026-04-01", to: "2027-03-31" });
    expect(yearOf(4)).toEqual({ from: "2026-04-01", to: "2027-03-31" });
    expect(yearOf(7)).toEqual({ from: "2026-07-01", to: "2027-06-30" });
    expect(kinListFilterLabel(expenses, { ...byYear, period: yearOf(7) })).toBe("FY 2026–27");
  });

  it("draws any list's own fields by type, in rows, columns and the entry", () => {
    const def = list({
      fields: [
        {
          key: "condition",
          label: "Condition" as never,
          type: "choice",
          choices: ["New" as never],
          sensitive: false,
        },
        { key: "heldBy", label: "Held by" as never, type: "person", sensitive: false },
        { key: "boughtFrom", label: "Bought from" as never, type: "link", sensitive: false },
        { key: "warranty", label: "Warranty until" as never, type: "date", sensitive: false },
        { key: "value", label: "Value" as never, type: "money", sensitive: true },
        { key: "photo", label: "Photo" as never, type: "file", sensitive: false },
        {
          key: "old",
          label: "Old tag" as never,
          type: "text",
          sensitive: false,
          retired: true,
        },
      ],
    });
    const fields = {
      condition: "New",
      heldBy: "agent:fin",
      boughtFrom: "rec-acme",
      warranty: "2027-03-31",
      value: { minor: 4_500_000, currency: "INR" },
      photo: ["att-1"],
    };
    const row = kinListRow(record({ fields }), def, context);
    expect(kinListColumns(def, [record({})]).map((column) => column.label)).toEqual([
      "Entry",
      "Status",
      "Condition",
      "Held by",
      "Bought from",
      "Warranty until",
      "Value",
      "Photo",
    ]);
    expect(row.cells).toMatchObject({
      state: "In use",
      "field:condition": "New",
      "field:heldBy": "Finance",
      "field:boughtFrom": "Acme Foods",
      "field:value": "₹45,000.00",
      "field:photo": "1 file",
    });
    expect(row.cells["field:warranty"]).toContain("2027");
    expect(row.amount).toBeNull();
    const detail = {
      ...record({ fields }),
      notes: "",
      source: { chatId: null, messageId: null },
      assignedBy: null,
      assignedAt: null,
      createdBy: { _tag: "system" },
      links: [],
      changes: [],
      files: [
        {
          attachmentId: "att-1",
          name: "desk.jpg",
          mimeType: "image/jpeg",
          chatId: "chat",
          messageId: "msg",
        },
      ],
    } as unknown as KinRecordDetail;
    const entry = kinListEntryView(detail, def, context);
    // The retired field holds nothing here, so it isn't shown; the photo opens from its field.
    expect(entry.fields.map((field) => field.key)).not.toContain("old");
    expect(entry.fields.find((field) => field.key === "photo")?.files).toHaveLength(1);
    expect(entry.fields.find((field) => field.key === "boughtFrom")?.opens).toEqual({
      list: "clients",
      key: "C-1",
    });
    expect([entry.finish?.label, entry.finish?.pays, entry.balance]).toEqual([
      "Mark returned",
      null,
      null,
    ]);
    expect(kinFieldText({ type: "link" }, "rec-gone", context)).toBe(
      "Something that isn't here any more",
    );
  });

  it("finishes a part-paid entry by receiving exactly what is left", () => {
    const invoices = list({ amount: true, stateLabels: { done: "Paid" as never } });
    const detail = {
      ...record({
        state: "waiting",
        amount: { minor: 10_000_000, currency: "INR" },
        balance: { minor: 6_000_000, currency: "INR" },
      }),
      notes: "",
      links: [],
      changes: [],
      payments: [
        {
          paymentId: "p1",
          amount: { minor: 4_000_000, currency: "INR" },
          paidOn: "2026-11-05",
          note: " ",
          recordedAt: "2026-11-05T00:00:00.000Z",
          voidedAt: null,
        },
      ],
    } as unknown as KinRecordDetail;
    const entry = kinListEntryView(detail, invoices, context);
    expect(entry.finish).toEqual({
      label: "Mark paid",
      pays: { minor: 6_000_000, currency: "INR" },
    });
    expect([entry.balance?.leftText, entry.balance?.receivedText]).toEqual([
      "₹60,000.00",
      "₹40,000.00",
    ]);
    expect(entry.payments[0]).toMatchObject({ amount: "₹40,000.00", note: null, voided: false });
    expect(kinListRow(detail, invoices, context).owed).toBe("₹60,000 still owed");
    // An Invoices draft nothing came in on leaves Left empty, and Mark paid still pays its amount;
    // issued or paid, Left is as it was, and another list's open entry owes as before.
    const amount = { minor: 10_000_000, currency: "INR" };
    const billed = { ...detail, list: KinListId.make("invoices"), payments: [] };
    const drafted = { ...billed, state: "open" as const, balance: amount };
    expect(kinListRow(drafted, invoices, context).cells.owed).toBeUndefined();
    expect(kinListEntryView(drafted, invoices, context).finish?.pays).toEqual(amount);
    // A list of nothing but such drafts has no Left column; one issued invoice brings it back.
    const columnIds = (rows: ReadonlyArray<KinRecord>) =>
      kinListColumns(invoices, rows).map((column) => column.id);
    expect(columnIds([drafted])).not.toContain("owed");
    expect(columnIds([drafted, billed])).toContain("owed");
    expect(kinListRow(billed, invoices, context).cells.owed).toBe("₹60,000.00");
    expect(
      kinListRow(
        { ...billed, state: "done", balance: { minor: 0, currency: "INR" } },
        invoices,
        context,
      ).cells.owed,
    ).toBe("₹0.00");
    expect(kinListRow({ ...drafted, list: undefined }, invoices, context).cells.owed).toBe(
      "₹1,00,000.00",
    );
    // Named by its key until it is issued, then by its number.
    expect(kinListRow(detail, invoices, context).line).toMatch(/^EQ-1 · /);
    // Its due day wraps as one piece, the state before it staying on the first line.
    const due = kinListRow({ ...detail, dueAt: "2026-12-06", dueAllDay: true }, invoices, context);
    expect(due.line.split(" · ").at(-1)).toBe("Due\u00a0Sun,\u00a0Dec\u00a06");
    expect(due.accessibilityLabel).toContain("Due ");
    const numbered = { ...detail, fields: { number: "AM/26-27/004" } };
    expect(kinListRow(numbered, invoices, context).line).toMatch(/^AM\/26-27\/004 · /);
    expect(kinListEntryView(numbered, invoices, context).heading).toBe("AM/26-27/004 · Equipment");
    // A suggestion says so before its state, and is paid by nobody until it is kept; as a
    // deadline it is never overdue in a money list. Stored issued, it reads Suggested alone, and
    // its day is no issue day.
    const issued = list({
      list: KinListId.make("invoices"),
      amount: true,
      states: ["open", "waiting", "done", "dropped"],
      stateLabels: {
        open: "Draft" as never,
        waiting: "Issued" as never,
        done: "Paid" as never,
        dropped: "Void" as never,
      },
      dateLabel: "Issued" as never,
    });
    const suggested = {
      ...detail,
      list: "invoices",
      confirmed: false,
      late: true,
      dateAt: "2026-12-01T00:00:00.000Z",
    };
    expect(kinListEntryView(suggested, issued, context)).toMatchObject({
      stateLabel: "Suggested",
      dateLabel: "Date",
      suggested: true,
      late: false,
      finish: null,
    });
    const row = kinListRow(suggested, issued, context);
    expect([row.stateLabel, row.cells.state, row.suggested, row.late]).toEqual([
      "Suggested",
      "Suggested",
      true,
      false,
    ]);
    expect(row.line.split(" · ").filter((part) => part.startsWith("Suggested"))).toHaveLength(1);
    expect(row.line).not.toContain("Issued");
    expect(kinListColumns(issued, [suggested]).find((one) => one.id === "date")?.label).toBe(
      "Date",
    );
    const draft = { ...suggested, state: "open" as const };
    expect(kinListEntryView(draft, issued, context)).toMatchObject({
      stateLabel: "Suggested · Draft",
      dateLabel: "Date",
    });
    const paid = kinListRow({ ...suggested, state: "done" }, issued, context);
    expect([paid.stateLabel, paid.suggested]).toEqual(["Suggested · Paid", true]);
    expect(kinListRow({ ...suggested, state: "dropped" }, issued, context).suggested).toBe(false);
    // Kept, it reads by its state and its day is the issue day again.
    const kept = { ...suggested, confirmed: true };
    expect(kinListEntryView(kept, issued, context)).toMatchObject({
      stateLabel: "Issued",
      dateLabel: "Issued",
    });
    expect(kinListColumns(issued, [kept]).find((one) => one.id === "date")?.label).toBe("Issued");
    // Its page notes Money only where Money would count it, a draft that it is owed only once
    // issued, and offers Not needed only where it can drop it.
    expect(kinSuggestionKeep(suggested, issued)).toEqual({
      note: "Not in any Money figure until you keep it.",
      declines: true,
    });
    expect(kinSuggestionKeep(draft, issued).note).toBe(
      "Not in any Money figure until you keep it, and not owed until it's issued.",
    );
    expect(kinSuggestionKeep({ list: "work" }, null)).toEqual({ note: null, declines: true });
    expect(kinSuggestionKeep({ list: "leave" as never }, { states: ["open", "done"] })).toEqual({
      note: null,
      declines: false,
    });
    // Opened from a figure it asks for what the figure counts, and says so with a way back.
    const counted = { ...KIN_LIST_DEFAULT_FILTER, show: "waiting" as const, kept: true };
    expect(kinListQuery(orgId, "invoices" as never, counted)).toMatchObject({ kept: true });
    expect(kinListNarrowings(counted)).toEqual([
      { id: "kept", label: "Counted in Money", cleared: { ...counted, kept: null } },
    ]);
    // Each status pill asks for that status alone and is the one selected; All asks for all.
    const cleared = { ...counted, kept: null };
    for (const [id, states] of [
      ["open", ["open"]],
      ["waiting", ["waiting"]],
      ["done", ["done"]],
      ["dropped", ["dropped"]],
      ["all", undefined],
    ] as const) {
      const picked = kinListChips(issued, cleared).find((chip) => chip.id === id)!.filter;
      expect(kinListQuery(orgId, issued.list, picked).states, id).toEqual(states);
      expect(
        kinListChips(issued, picked)
          .filter((chip) => chip.selected)
          .map((chip) => chip.id),
        id,
      ).toEqual([id]);
    }
  });

  it("sends only the names that changed when a list is renamed", () => {
    const def = list({});
    const draft = kinListEditDraftOf(def);
    expect(kinListEditInput(orgId, def, draft)).toEqual({ ok: true, input: null });
    expect(
      kinListEditInput(orgId, def, {
        ...draft,
        name: " Kit ",
        stateLabels: { ...draft.stateLabels, dropped: "Sold" },
      }),
    ).toEqual({
      ok: true,
      input: { orgId, list: "equipment", rev: 3, name: "Kit", stateLabels: { dropped: "Sold" } },
    });
    expect(
      kinListEditInput(orgId, def, { ...draft, stateLabels: { ...draft.stateLabels, open: " " } }),
    ).toEqual({ ok: false, problem: "Every status needs a name." });
  });

  it("shows a category as it was written unless the list labels it, and saves only label changes", () => {
    const def = list({
      amount: true,
      categories: ["gst" as never, "income tax" as never],
      categoryLabels: { gst: "GST" as never },
    });
    expect(kinListRow(record({ listCategory: "gst" as never }), def, context).cells.category).toBe(
      "GST",
    );
    expect(
      kinListRow(record({ listCategory: "income tax" as never }), def, context).cells.category,
    ).toBe("income tax");
    const draft = kinListEditDraftOf(def);
    expect(draft.categoryLabels).toEqual({ gst: "GST", "income tax": "income tax" });
    expect(
      kinListEditInput(orgId, def, {
        ...draft,
        categoryLabels: { gst: " ", "income tax": "Income tax" },
        payments: true,
      }),
    ).toEqual({
      ok: true,
      input: {
        orgId,
        list: "equipment",
        rev: 3,
        categoryLabels: { gst: null, "income tax": "Income tax" },
        payments: true,
      },
    });
  });

  it("leads with what is still owed or was received, and makes none a filter of its own", () => {
    const inr = (minor: number) => [{ minor, currency: "INR" }];
    const def = list({ amount: true, payments: true, categories: ["rent" as never] });
    const byCategory = { ...KIN_LIST_DEFAULT_FILTER, groupBy: "category" as const };
    const header = kinListHeader(
      def,
      byCategory,
      {
        total: inr(15_000_000),
        owed: inr(6_000_000),
        groups: [
          { group: "rent", count: 1, total: inr(10_000_000), owed: inr(6_000_000) },
          { group: null, count: 1, total: inr(5_000_000), owed: [] },
        ],
      },
      2,
    );
    expect(header.figures).toEqual([
      { id: "owed", label: "Still owed", lines: ["₹60,000"] },
      { id: "total", label: "Billed", lines: ["₹1,50,000"] },
    ]);
    expect(header.groups.map((group) => [group.label, group.totals, group.billed])).toEqual([
      ["rent", ["₹60,000"], "₹1,00,000 billed"],
      ["No category", ["Nothing"], "₹50,000 billed"],
    ]);
    const none = header.groups[1]!.narrowed!;
    expect(kinListQuery(orgId, def.list, none)).toMatchObject({ listCategory: null });
    expect(kinListNarrowings(none, def)[0]).toMatchObject({ label: "No category" });
    // The Filter's one chip names every narrowing, and clearing it keeps search and the split.
    expect(kinListFilterLabel(def, byCategory)).toBeNull();
    expect(kinListFilterLabel(def, { ...none, noParty: true })).toBe("No category · No client");
    expect(kinListFilterCleared({ ...none, text: "rent" })).toEqual({
      ...byCategory,
      text: "rent",
    });
    expect(kinListQuery(orgId, def.list, { ...byCategory, noParty: true })).toMatchObject({
      party: null,
    });
    // A paid window leads with the payments made in it; a plain list has one unnamed figure.
    expect(
      kinListHeader(
        def,
        KIN_LIST_DEFAULT_FILTER,
        { total: inr(100), owed: inr(60), received: inr(40), groups: [] },
        1,
      ).figures.map((figure) => figure.label),
    ).toEqual(["Paid", "Billed"]);
    expect(
      kinListHeader(
        list({ amount: true }),
        KIN_LIST_DEFAULT_FILTER,
        { total: inr(100), groups: [] },
        1,
      ).figures,
    ).toEqual([{ id: "total", label: null, lines: ["₹1"] }]);
    // Quotes total only what is out and what was won, never one sum across drafts.
    const quotes = kinListHeader(
      list({ amount: true }),
      KIN_LIST_DEFAULT_FILTER,
      { total: inr(300), sent: inr(100), accepted: inr(200), groups: [] },
      3,
    );
    expect(quotes.totals).toEqual([]);
    expect(quotes.summary).toBe("Sent, waiting: ₹1 · Accepted: ₹2");
    // Bank rows add money in and out apart, then their net, which may go below zero; `total`
    // stays the plain sum older phone builds show. A side with nothing in it goes unsaid.
    const out = { moneyIn: inr(100), moneyOut: inr(300), net: inr(-200), total: inr(400) };
    const outOnly = { moneyIn: [], moneyOut: inr(300), net: inr(-300), total: inr(300) };
    const inOnly = { moneyIn: inr(100), moneyOut: [], net: inr(100), total: inr(100) };
    const bank = kinListHeader(
      list({ amount: true }),
      { ...KIN_LIST_DEFAULT_FILTER, groupBy: "month" },
      {
        ...out,
        groups: [
          { group: "2026-09", count: 1, ...inOnly },
          { group: "2026-10", count: 1, ...outOnly },
          { group: "2026-11", count: 2, ...out },
        ],
      },
      4,
    );
    expect([bank.figures, bank.totals, bank.summary]).toEqual([
      [
        { id: "moneyIn", label: "Money in", lines: ["₹1"] },
        { id: "moneyOut", label: "Money out", lines: ["₹3"] },
        { id: "net", label: "Net", lines: ["−₹2"] },
      ],
      [],
      "Money in: ₹1 · Money out: ₹3 · Net: −₹2",
    ]);
    expect(bank.groups.map((group) => [group.totals, group.billed])).toEqual([
      [["−₹2"], "₹1 in · ₹3 out"],
      [["−₹3"], "₹3 out"],
      [["₹1"], "₹1 in"],
    ]);
    expect(kinListFilterParam(JSON.stringify({ noParty: true, noCategory: true }))).toMatchObject({
      noParty: true,
      noCategory: true,
      party: null,
      category: null,
    });
  });

  it("turns each kind of edited detail into what the host stores, or says why not", () => {
    const check = (type: KinListFieldView["type"], draft: string | ReadonlyArray<string> | null) =>
      kinFieldCheck({ type, label: "Detail" }, draft, "INR");
    expect(check("text", "  Q3 lease ")).toEqual({ ok: true, value: "Q3 lease" });
    expect(check("text", " ")).toEqual({ ok: true, value: null });
    expect(check("text", "x".repeat(501)).ok).toBe(false);
    expect(check("choice", "upi")).toEqual({ ok: true, value: "upi" });
    expect(check("date", "2026-11-10")).toEqual({ ok: true, value: "2026-11-10" });
    expect(check("date", "10 Nov").ok).toBe(false);
    expect(check("money", "9,000")).toEqual({
      ok: true,
      value: { minor: 900_000, currency: "INR" },
    });
    expect(check("money", "$120.50")).toEqual({
      ok: true,
      value: { minor: 12_050, currency: "USD" },
    });
    expect(check("money", "lots").ok).toBe(false);
    expect(check("file", ["a", "b"])).toEqual({ ok: true, value: ["a", "b"] });
    expect(check("file", [])).toEqual({ ok: true, value: null });
    expect(
      check(
        "file",
        Array.from({ length: 11 }, (_, index) => `f${index}`),
      ).ok,
    ).toBe(false);
    expect(kinPrincipalValue({ _tag: "agent", agentId: "fin" as never })).toBe("agent:fin");

    const received = { minor: 4_000_000, currency: "INR" };
    expect(kinAmountCheck("", "INR", null)).toEqual({ ok: true, value: null });
    expect(kinAmountCheck("", "INR", received).ok).toBe(false);
    expect(kinAmountCheck("USD 500", "INR", received).ok).toBe(false);
    expect(kinAmountCheck("39,999.99", "INR", received)).toEqual({
      ok: false,
      problem:
        "₹40,000.00 has already been received, so the amount can't be less. Take a payment back first.",
    });
    expect(kinAmountCheck("40000", "INR", received)).toEqual({ ok: true, value: received });
    // What an edit starts with reads back as the same amount.
    for (const money of [
      { minor: 5_000_050, currency: "INR" },
      { minor: 12_000, currency: "USD" },
      { minor: 1200, currency: "JPY" },
    ])
      expect(kinParseMoney(kinMoneyDraft(money, "INR"), "INR")).toEqual(money);
    // Each symbol an amount is shown with reads back as its own currency, not as dollars.
    expect(
      ["S$40", "A$40", "CA$40", "HK$40", "NZ$40", "US$40", "$40", "€40", "¥40", "CN¥40"].map(
        (text) => kinParseMoney(text, "INR")?.currency,
      ),
    ).toEqual(["SGD", "AUD", "CAD", "HKD", "NZD", "USD", "USD", "EUR", "JPY", "CNY"]);
  });
});

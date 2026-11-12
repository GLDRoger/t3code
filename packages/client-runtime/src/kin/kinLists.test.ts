import {
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
  kinListEntryView,
  kinListHeader,
  kinListQuery,
  kinListRow,
  kinMoneyText,
  kinParseAmount,
  kinPaymentCheck,
  kinPeriodLabel,
  kinTotalsText,
  type KinListContext,
} from "./kinLists.ts";

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

  it("reads a typed amount into whole minor units, or refuses it", () => {
    expect(kinParseAmount("40,000", "INR")).toEqual({ minor: 4_000_000, currency: "INR" });
    expect(kinParseAmount("₹ 1,00,000.5", "INR")).toEqual({ minor: 10_000_050, currency: "INR" });
    expect(kinParseAmount("0.1", "INR")).toEqual({ minor: 10, currency: "INR" });
    expect(kinParseAmount("1200", "JPY")).toEqual({ minor: 1200, currency: "JPY" });
    for (const wrong of ["", "0", "12.345", "4.2 lakh", "-5", "1.5"])
      expect(kinParseAmount(wrong, wrong === "1.5" ? "JPY" : "INR")).toBeNull();
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
  });

  it("sends only the names that changed when a list is renamed", () => {
    const def = list({});
    const draft = kinListEditDraftOf(def);
    expect(kinListEditInput(orgId, def, draft)).toEqual({ ok: true, input: null });
    expect(
      kinListEditInput(orgId, def, {
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
});

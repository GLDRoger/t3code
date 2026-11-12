import {
  KinChatError,
  KinListId,
  KinOrgId,
  KinRecordId,
  type KinListDefinition,
  type KinReceipt,
  type KinRecordDetail,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  kinAdvanceDraft,
  kinAdvanceInput,
  kinInvoiceActions,
  kinInvoiceTitle,
  kinInvoiceMissingClient,
  kinInvoiceView,
  kinReceiptNotice,
  kinReceiptView,
} from "./kinInvoices.ts";
import { kinListSend } from "./kinLists.ts";

// Invented company, clients and amounts only.
const orgId = KinOrgId.make("org");
// @effect-diagnostics-next-line globalDate:off
const now = new Date("2026-11-12T10:00:00+05:30");

const invoices = {
  list: KinListId.make("invoices"),
  name: "Invoices",
  prefix: "INV",
  builtIn: false,
  states: ["open", "waiting", "done", "dropped"],
  stateLabels: {},
  defaultState: "open",
  categories: [],
  fields: [],
  sensitive: true,
  amount: true,
  currency: "INR",
  payments: true,
  numbering: { prefix: "QST", series: "financial_year", width: 3 },
  archivedAt: null,
  rev: 1,
  open: 1,
} as unknown as KinListDefinition;

const invoice = (patch: Partial<KinRecordDetail>) =>
  ({
    recordId: KinRecordId.make("rec-inv"),
    orgId,
    key: "INV-8",
    title: "QST/2026-27/008 · Website build",
    state: "waiting",
    list: KinListId.make("invoices"),
    amount: { minor: 10_000_000, currency: "INR" },
    balance: { minor: 6_000_000, currency: "INR" },
    fields: { number: "QST/2026-27/008" },
    links: [],
    payments: [],
    changes: [],
    notes: "",
    ...patch,
  }) as unknown as KinRecordDetail;

const payment = (id: string, receipt: unknown, voidedAt: string | null = null, note = "") => ({
  paymentId: id,
  amount: { minor: 2_000_000, currency: "INR" },
  paidOn: "2026-11-05",
  note,
  recordedAt: "2026-11-05T00:00:00.000Z",
  voidedAt,
  receipt,
});

describe("kinInvoiceTitle", () => {
  it.each([
    ["QST/2026-27/008 · Website build", "QST/2026-27/008", "QST/2026-27/008", "Website build"],
    ["QST/2026-27/008 · Website build", null, "QST/2026-27/008", "Website build"],
    ["KIN/26-27/014 - Retainer", null, "KIN/26-27/014", "Retainer"],
    ["Website build", "QST/2026-27/009", "QST/2026-27/009", "Website build"],
    ["QST/2026-27/010", "QST/2026-27/010", "QST/2026-27/010", null],
    ["Website build for Acme", null, null, "Website build for Acme"],
    ["INV-12 notes: nothing", null, null, "INV-12 notes: nothing"],
  ])("reads %j with number field %j", (title, field, number, description) => {
    expect(kinInvoiceTitle(title, field)).toEqual({ number, description });
  });
});

describe("kinInvoiceView", () => {
  it("heads with the number, totals the money, and gives each payment its receipt", () => {
    const view = kinInvoiceView(
      invoice({
        payments: [
          payment("p1", null),
          payment("p2", {
            key: null,
            number: "R/25-26/031",
            receivedOn: "2026-11-05",
            amount: { minor: 2_000_000, currency: "INR" },
            document: null,
          }),
          payment(
            "p3",
            {
              key: "RCT-2",
              number: "R/26-27/002",
              receivedOn: "2026-11-05",
              amount: { minor: 2_000_000, currency: "INR" },
              document: "D-9",
            },
            null,
            "R/26-27/002",
          ),
          payment("p4", undefined, "2026-11-06T00:00:00.000Z"),
        ] as never,
        links: [
          { kind: "record", record: { key: "D-4", title: "Invoice QST/2026-27/008" } },
          { kind: "record", record: { key: "C-1", title: "Acme Foods" } },
          { kind: "record", record: { key: "D-7", title: "Invoice QST/2026-27/008 (2)" } },
        ] as never,
      }),
      invoices,
      now,
    );
    expect(view).toMatchObject({
      heading: "QST/2026-27/008",
      description: "Website build",
      total: "₹1,00,000.00",
      received: "₹40,000.00",
      balance: "₹60,000.00",
      void: false,
      prefix: "QST",
    });
    expect(view.payments.map((one) => one.receipt)).toEqual([
      { _tag: "none" },
      { _tag: "noted", number: "R/25-26/031" },
      { _tag: "ready", number: "R/26-27/002", document: "D-9" },
      null,
    ]);
    expect(view.payments[2]?.note).toBeNull();
    expect(view.documents.map((doc) => doc.key)).toEqual(["D-7", "D-4"]);
  });

  it("reads a void invoice as void, owing nothing, with its way back", () => {
    const view = kinInvoiceView(invoice({ state: "dropped", late: true }), invoices, now);
    expect([view.void, view.balance]).toEqual([true, null]);
  });
});

describe("kinInvoiceMissingClient", () => {
  it("opens the invoice's client when its missing tax details stopped the invoice", () => {
    const party = { key: "C-4", title: "Invented Foods" };
    const reason =
      "Nothing was made: the client has no place of supply: give it a GSTIN or a place of supply";
    expect(kinInvoiceMissingClient(reason, party)).toEqual({ key: "C-4", name: "Invented Foods" });
    expect(kinInvoiceMissingClient("Kin couldn't make it.", party)).toBeNull();
    expect(kinInvoiceMissingClient(reason, null)).toBeNull();
  });
});

describe("kinInvoiceActions", () => {
  const all = { render: true, issue: true, receipt: true };
  it.each([
    ["a draft", { void: false, number: null }, all, { make: true, issue: true, void: true }],
    ["an issued one", { void: false, number: "Q/1" }, all, { issue: false, void: true }],
    ["a void one", { void: true, number: "Q/1" }, all, { make: false, void: false, unvoid: true }],
    [
      "a device that may only read",
      { void: false, number: null },
      { render: false, issue: false, receipt: false },
      { make: false, issue: false, void: false, unvoid: false, receipt: false },
    ],
  ])("offers what fits %s", (_name, view, allowed, expected) => {
    expect(kinInvoiceActions(view, invoices, allowed)).toMatchObject(expected);
  });

  it("offers no number in a list that doesn't number its entries", () => {
    const plain = { ...invoices, numbering: undefined };
    expect(kinInvoiceActions({ void: false, number: null }, plain, all)).toMatchObject({
      issue: false,
      void: false,
    });
  });
});

describe("receipts", () => {
  const receipt = (patch: Partial<KinReceipt>): KinReceipt =>
    ({
      key: "RCT-3",
      number: "R/26-27/003",
      state: "done",
      receivedOn: "2026-11-10",
      amount: { minor: 2_500_000, currency: "INR" },
      receivedFrom: { recordId: "rec-acme", key: "C-1", title: "Acme Foods" },
      towards: "Advance for the website build",
      mode: null,
      reference: null,
      invoice: null,
      paymentId: null,
      advance: true,
      document: { key: "D-11", title: "Receipt R/26-27/003" },
      ...patch,
    }) as KinReceipt;

  it("lets an unapplied advance be set against an invoice, and nothing else", () => {
    expect(kinReceiptView(receipt({}), now)).toMatchObject({
      heading: "R/26-27/003",
      amount: "₹25,000.00",
      advance: true,
      applied: "Not set against an invoice yet",
      settable: { party: "C-1" },
      document: "D-11",
    });
    expect(kinReceiptView(receipt({ invoice: "INV-8" as never }), now)).toMatchObject({
      applied: "Set against INV-8",
      settable: null,
    });
    expect(
      kinReceiptView(receipt({ invoice: "INV-8" as never, towards: "Invoice INV-8" }), now).towards,
    ).toBeNull();
    expect(kinReceiptView(receipt({ state: "dropped" }), now)).toMatchObject({
      void: true,
      settable: null,
    });
    expect(kinReceiptView(receipt({ receivedFrom: null }), now).settable).toBeNull();
    expect(kinReceiptView(receipt({ advance: false, number: null }), now)).toMatchObject({
      heading: "RCT-3",
      applied: null,
      settable: null,
    });
  });

  it("says an advance was set against its invoice, not made again", () => {
    expect(kinReceiptNotice({ receipt: receipt({}), problems: [] })).toBe(
      "Receipt R/26-27/003 made.",
    );
    expect(
      kinReceiptNotice({ receipt: receipt({ invoice: "INV-8" as never }), problems: ["no font"] }),
    ).toBe(
      "Receipt R/26-27/003 is set against INV-8. The receipt and its number stand, but Kin couldn't make its PDF: no font",
    );
  });

  it("makes an advance's receipt from what was typed, or says what is missing", () => {
    const draft = {
      ...kinAdvanceDraft("2026-11-12"),
      party: "C-1" as never,
      towards: "  Phase 1 ",
    };
    expect(kinAdvanceInput(orgId, { ...draft, amount: "25,000" }, "INR", "req-1")).toEqual({
      ok: true,
      input: {
        orgId,
        advance: {
          client: "C-1",
          amount: { minor: 2_500_000, currency: "INR" },
          receivedOn: "2026-11-12",
        },
        towards: "Phase 1",
        clientRequestId: "req-1",
      },
    });
    expect(kinAdvanceInput(orgId, draft, "INR", "req-1")).toMatchObject({ ok: false });
  });
});

describe("kinListSend refusals", () => {
  const refused = (reason: KinChatError["reason"], message: string) =>
    kinListSend({
      online: () => true,
      send: async () =>
        AsyncResult.failure(Cause.fail(new KinChatError({ reason, message }))) as never,
    });

  it.each([
    [
      "not_allowed",
      "That retry key already created a different entry.",
      "This was already sent once with different details. Close it and start again.",
    ],
    [
      "not_allowed",
      "Only the owner can see Work yet.",
      "Only whoever runs this Kin can change this.",
    ],
    [
      "limit",
      "Too many chats are open on this device. Close some and try again.",
      "Too many chats are open on this device. Close some and try again.",
    ],
    ["limit", "kin_work over cap", "That didn't go through. Check the details and try again."],
  ] as const)("shows %s (%s) in plain words", async (reason, message, shown) => {
    expect(await refused(reason, message)).toMatchObject({ ok: false, problem: shown });
  });
});

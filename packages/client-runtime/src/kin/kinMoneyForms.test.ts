// @effect-diagnostics globalDate:off - Fixtures count due days from a fixed day.
import { KinOrgId, KinRecordKey } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_MONEY_FORMS,
  kinExpenseChoices,
  kinExpenseDraft,
  kinExpenseInput,
  kinExpenseTyped,
  kinPersonChoices,
  kinInvoiceBeforeTax,
  kinInvoiceDraft,
  kinInvoiceDueChoices,
  kinInvoiceInput,
  kinInvoiceTax,
  kinInvoiceTaxText,
  kinInvoiceTyped,
} from "./kinMoneyForms.ts";

const orgId = KinOrgId.make("org");
const acme = KinRecordKey.make("CL-1");
const line = (description: string, quantity: string, rate: string) => ({
  description,
  sac: "",
  quantity,
  unit: "",
  rate,
});
const options = { currency: "INR", gst: true, clientRequestId: "form-1" };

describe("an invoice typed by hand", () => {
  it("is sent only with a client, what it's for and a line, and India's rate only in India", () => {
    const empty = kinInvoiceDraft();
    expect(kinInvoiceInput(orgId, empty, options)).toEqual({
      ok: false,
      problem: KIN_MONEY_FORMS.problem.client,
    });
    const forAcme = kinInvoiceDraft(acme);
    expect(kinInvoiceInput(orgId, { ...forAcme, title: "  " }, options)).toEqual({
      ok: false,
      problem: KIN_MONEY_FORMS.problem.what,
    });
    const titled = { ...forAcme, title: " November   design " };
    expect(kinInvoiceInput(orgId, titled, options)).toEqual({
      ok: false,
      problem: KIN_MONEY_FORMS.problem.noLines,
    });
    const filled = { ...titled, lines: [line("Design", "2", "10,000")], dueOn: "2026-12-12" };
    expect(kinInvoiceInput(orgId, { ...filled, gstRate: "eighteen" }, options)).toEqual({
      ok: false,
      problem: KIN_MONEY_FORMS.problem.gstRate,
    });
    expect(kinInvoiceInput(orgId, { ...filled, gstRate: "5" }, options)).toEqual({
      ok: true,
      input: {
        orgId,
        client: acme,
        title: "November design",
        lines: [{ description: "Design", sac: null, quantity: "2", rate: "₹10,000.00" }],
        gstRate: "5",
        dueOn: "2026-12-12",
        clientRequestId: "form-1",
      },
    });
    // Elsewhere the company's own tax applies, so no rate is sent however it reads.
    const abroad = kinInvoiceInput(
      orgId,
      { ...filled, gstRate: "eighteen", lines: [line("Design", "1", "£400")] },
      { ...options, currency: "GBP", gst: false },
    );
    expect(abroad.ok && abroad.input).toMatchObject({ lines: [{ rate: "£400.00" }] });
    expect(abroad.ok && "gstRate" in abroad.input).toBe(false);
  });

  it("asks before closing only when something was typed, not for the client it opened with", () => {
    const opened = kinInvoiceDraft(acme);
    expect(kinInvoiceTyped(opened, opened)).toBe(false);
    expect(kinInvoiceTyped({ ...opened, party: null }, opened)).toBe(true);
    expect(kinInvoiceTyped({ ...opened, lines: [line("", "1", "500")] }, opened)).toBe(true);
    expect(kinInvoiceTyped({ ...opened, lines: [] }, opened)).toBe(false);
  });

  it("says the tax Company details sets: GST by GSTIN in India, else the company's one tax", () => {
    const profile = { country: "IN", homeCurrency: "INR", gstin: null, tax: null } as const;
    expect(kinInvoiceTax(profile)).toEqual({ _tag: "gst", registered: false });
    expect(kinInvoiceTaxText(kinInvoiceTax(profile))).toBe(KIN_MONEY_FORMS.invoice.noGstin);
    const { country: _country, ...before } = { ...profile, gstin: "29AAAAA1111A1Z5" };
    expect(kinInvoiceTax(before)).toEqual({
      _tag: "gst",
      registered: true,
    });
    const uk = { country: "GB", homeCurrency: "GBP", gstin: null } as const;
    const vat = kinInvoiceTax({ ...uk, tax: { name: "VAT", rate: "20", pricesInclude: false } });
    expect(kinInvoiceTaxText(vat)).toBe(
      "VAT at 20% is added to the lines, as Company details says.",
    );
    expect(kinInvoiceTax({ ...uk, tax: { name: "VAT", rate: null, pricesInclude: null } })).toEqual(
      { _tag: "none" },
    );
    expect(kinInvoiceTax({ ...uk, country: null, tax: null })).toEqual({ _tag: "none" });
  });

  it("adds the lines up before tax as the template does, each rounded half up", () => {
    expect(kinInvoiceBeforeTax([line("Design", "2", "10,000")], "INR")).toBe(
      "The lines come to ₹20,000.00 before tax.",
    );
    expect(
      kinInvoiceBeforeTax([line("Hours", "1.5", "333.33"), line("Call", "1", "")], "INR"),
    ).toBe("The lines come to ₹500.00 before tax.");
    expect(kinInvoiceBeforeTax([line("Design", "1", "$10")], "INR")).toBeNull();
    expect(kinInvoiceBeforeTax([line("Design", "1", "")], "INR")).toBeNull();
  });

  it("offers due days on the usual terms from today", () => {
    expect(
      kinInvoiceDueChoices("2026-11-21", new Date(2026, 10, 21, 12)).map((one) => one.day),
    ).toEqual(["2026-11-28", "2026-12-06", "2026-12-21", "2027-01-05", "2027-01-20"]);
  });
});

describe("an expense typed by hand", () => {
  it("is sent with what it was, an amount in its own currency and the day it was paid", () => {
    const draft = kinExpenseDraft("2026-11-21");
    const send = { currency: "INR", clientRequestId: "form-1" };
    expect(kinExpenseInput(orgId, draft, send)).toEqual({
      ok: false,
      problem: KIN_MONEY_FORMS.problem.expenseWhat,
    });
    const named = { ...draft, title: "Courier" };
    expect(kinExpenseInput(orgId, { ...named, amount: "lots" }, send)).toEqual({
      ok: false,
      problem: KIN_MONEY_FORMS.problem.amount,
    });
    expect(
      kinExpenseInput(
        orgId,
        { ...named, amount: "$12.50", vendor: " Invented  Couriers ", receipt: "att-1" },
        send,
      ),
    ).toEqual({
      ok: true,
      input: {
        orgId,
        title: "Courier",
        amount: { minor: 1_250, currency: "USD" },
        paidOn: "2026-11-21",
        vendor: "Invented Couriers",
        receipt: ["att-1"],
        clientRequestId: "form-1",
      },
    });
    expect(kinExpenseInput(orgId, { ...named, amount: "-$5" }, send)).toMatchObject({
      ok: true,
      input: { amount: { minor: -500, currency: "USD" } },
    });
    expect(kinExpenseTyped(draft, draft)).toBe(false);
    expect(kinExpenseTyped({ ...draft, paidOn: "2026-11-20" }, draft)).toBe(true);
    // A partner who paid it themselves goes as who funded it; left empty, the company did.
    const funded = kinExpenseInput(orgId, { ...named, amount: "12", fundedBy: "meera" }, send);
    expect(funded.ok && funded.input.fundedBy).toBe("meera");
    expect(kinExpenseTyped({ ...draft, fundedBy: "meera" }, draft)).toBe(true);
  });

  it("offers only people, and only on a list that has Funded by, as who funded an expense", () => {
    const people = new Map([
      ["zoya", "Zoya"],
      ["meera", "Meera"],
    ]);
    expect(kinExpenseChoices(null, people).fundedBy).toEqual([
      { value: "meera", label: "Meera" },
      { value: "zoya", label: "Zoya" },
    ]);
    expect(
      kinPersonChoices("fundedBy", [{ value: "person:meera" }, { value: "agent:finance" }]),
    ).toEqual([{ value: "person:meera" }]);
    expect(kinPersonChoices("paidBy", [{ value: "agent:finance" }])).toEqual([
      { value: "agent:finance" },
    ]);
  });

  it("offers no categories before the Expenses list exists, which the first one makes", () => {
    expect(kinExpenseChoices(null)).toEqual({
      fundedBy: [],
      categories: [],
      paidWith: [],
      receipt: true,
      first: true,
    });
  });
});

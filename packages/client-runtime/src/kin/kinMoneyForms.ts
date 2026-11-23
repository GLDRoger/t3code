// @effect-diagnostics globalDate:off - Pure form helpers count due days for React render, outside an Effect runtime.
import {
  KIN_DEFAULT_HOME_CURRENCY,
  parseKinMoney,
  type KinCompanyProfile,
  type KinListDefinition,
  type KinMoney,
  type KinNewExpenseInput,
  type KinNewInvoiceInput,
  type KinOrgId,
  KinPersonId,
  type KinRecordKey,
} from "@t3tools/contracts";

import { KIN_RETRY } from "./kinAnswers.ts";
import { KIN_BILL_TO } from "./kinBillTo.ts";
import { kinCategoryLabel, kinMoneyText, kinParseMoney } from "./kinLists.ts";
import { KIN_EMPTY_LINE, kinLinesInput, type KinLineDraft } from "./kinMoneyAnswers.ts";
import { kinWorkDueLabel } from "./kinWork.ts";

/**
 * The invoice and the expense a person types by hand, the same on web and phone: what each form
 * holds, whether it holds anything worth asking about before it closes, and what the host takes.
 */

export const KIN_MONEY_FORMS = {
  invoice: {
    add: "Invoice",
    addDetail: "A draft, typed by hand",
    title: "New invoice",
    detail: "Saving makes a draft: it isn't numbered or owed until you issue it.",
    party: "Client",
    pickClient: "Pick a client",
    noClients: "Add the client in Clients first.",
    what: "What it's for",
    whatPlaceholder: "Such as November design work",
    whatHint: "Printed on the invoice.",
    linesDetail: "What is billed, one row each: quantity times rate.",
    beforeTax: (total: string) => `The lines come to ${total} before tax.`,
    gstRate: "GST rate (%)",
    gstHint: "Kin charges CGST and SGST, or IGST, by the client's state.",
    noGstin: "No GST is charged: Company details has no GSTIN yet.",
    tax: (name: string, rate: string, included: boolean) =>
      included
        ? `${name} at ${rate}% is included in the rates, as Company details says.`
        : `${name} at ${rate}% is added to the lines, as Company details says.`,
    noTax: "No tax is added: Company details sets none.",
    due: "Due",
    noDue: "No due date",
    inDays: (days: number, day: string) => `In ${days} days · ${day}`,
    more: "More",
    notes: "Notes",
    notesHint: "Kept with the invoice, not printed on it.",
    project: "Project",
    noProject: "No project",
    save: "Save draft",
    /** The draft stands; only its document, which holds the lines, couldn't be made. */
    savedWithout: (key: string, problems: ReadonlyArray<string>) =>
      `Saved as draft ${key}, but Kin couldn't make it from the lines: ${problems.join(" ")}`,
    openDraft: (key: string) => `Open ${key}`,
    tryAgain: KIN_RETRY,
  },
  expense: {
    add: "Expense",
    addDetail: "Typed by hand",
    title: "New expense",
    what: "What it was",
    whatPlaceholder: "Such as courier for samples",
    amount: "Amount",
    amountPlaceholder: "Such as 2,350",
    /** Under the amount: an amount below zero is a refund or credit. */
    amountRefundHint: "For a refund, put a minus in front: -500.",
    paidOn: "Paid on",
    paidOnHint: "A day still ahead saves it as to pay.",
    vendor: "Who was paid",
    category: "Category",
    noCategory: "No category",
    paidWith: "Paid with",
    notSaid: "Not said",
    fundedBy: "Funded by",
    company: "The company",
    fundedByHint: "A partner who paid from their own money is owed it back until it's repaid.",
    fundedByNoRoom:
      "Expenses has no room for Funded by: a list holds at most 20 fields, so who paid from their own money can't be recorded.",
    receipt: "Receipt",
    noReceipt: "No receipt",
    receiptHint:
      "A photo or file sent in one of your chats. Send it in a chat first to pick it here.",
    firstList: "This starts your Expenses list.",
    save: "Save expense",
  },
  discard: {
    invoice: "Discard this invoice?",
    expense: "Discard this expense?",
    detail: "What you typed will be lost.",
    keep: "Keep editing",
    discard: "Discard",
  },
  problem: {
    client: "Pick who the invoice is for.",
    what: "Say what the invoice is for.",
    noLines: "Add a line: what it is and its rate.",
    gstRate: "Enter a GST rate like 18 or 5.",
    expenseWhat: "Say what it was.",
    amount: "Enter the amount paid, like 2,350.",
    day: "Pick the day it was paid.",
  },
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RATE = /^(?:100|\d{1,2}(?:\.\d{1,3})?)$/;
const QUANTITY = /^(\d{1,9})(?:\.(\d{1,3}))?$/;
const GST_DEFAULT = "18";
const oneLine = (text: string) => text.trim().replace(/\s+/g, " ");

// The invoice

/** A name to bill instead of a client, and its details; a blank one is left out. */
export interface KinBillToDraft {
  readonly name: string;
  readonly address: string;
  readonly taxNumber: string;
  readonly place: string;
  readonly email: string;
}

const NO_BILL_TO: KinBillToDraft = { name: "", address: "", taxNumber: "", place: "", email: "" };

export interface KinInvoiceDraft {
  readonly party: KinRecordKey | null;
  /** The person chose "Bill someone else by name" over the client picker. */
  readonly byName: boolean;
  readonly billTo: KinBillToDraft;
  readonly title: string;
  readonly lines: ReadonlyArray<KinLineDraft>;
  /** India's GST percent; unused elsewhere. */
  readonly gstRate: string;
  /** `YYYY-MM-DD`, or none. */
  readonly dueOn: string | null;
  readonly notes: string;
  readonly project: KinRecordKey | null;
}

/** An empty invoice, already for `client` when it is opened from one, with one line to fill. */
export const kinInvoiceDraft = (party: KinRecordKey | null = null): KinInvoiceDraft => ({
  party,
  byName: false,
  billTo: NO_BILL_TO,
  title: "",
  lines: [KIN_EMPTY_LINE],
  gstRate: GST_DEFAULT,
  dueOn: null,
  notes: "",
  project: null,
});

/** Whether closing the form would lose words the person typed: a client it opened with isn't theirs. */
export const kinInvoiceTyped = (draft: KinInvoiceDraft, opened: KinInvoiceDraft) =>
  draft.party !== opened.party ||
  Object.values(draft.billTo).some((value) => value.trim() !== "") ||
  draft.title.trim() !== "" ||
  draft.notes.trim() !== "" ||
  draft.dueOn !== null ||
  draft.project !== null ||
  draft.gstRate.trim() !== GST_DEFAULT ||
  draft.lines.some(
    (line) =>
      line.description.trim() !== "" ||
      line.rate.trim() !== "" ||
      line.sac.trim() !== "" ||
      line.unit.trim() !== "" ||
      line.quantity.trim() !== KIN_EMPTY_LINE.quantity,
  );

/** The tax the company's invoices carry, as Company details sets it, for the form to say. */
export type KinInvoiceTax =
  | { readonly _tag: "gst"; readonly registered: boolean }
  | {
      readonly _tag: "flat";
      readonly name: string;
      readonly rate: string;
      readonly included: boolean;
    }
  | { readonly _tag: "none" };

/** As the host decides it: India charges GST when the company has a GSTIN; elsewhere its one tax. */
export function kinInvoiceTax(
  profile: Pick<KinCompanyProfile, "country" | "homeCurrency" | "gstin" | "tax">,
): KinInvoiceTax {
  // A company stored before countries existed reads as India while it keeps rupees.
  const country =
    profile.country !== undefined
      ? profile.country
      : profile.homeCurrency === KIN_DEFAULT_HOME_CURRENCY
        ? "IN"
        : null;
  if (country === "IN") return { _tag: "gst", registered: profile.gstin !== null };
  const tax = profile.tax ?? null;
  return tax === null || tax.rate === null
    ? { _tag: "none" }
    : { _tag: "flat", name: tax.name, rate: tax.rate, included: tax.pricesInclude === true };
}

/** The tax line the form shows; null where a rate is typed instead. */
export function kinInvoiceTaxText(tax: KinInvoiceTax): string | null {
  if (tax._tag === "gst") return tax.registered ? null : KIN_MONEY_FORMS.invoice.noGstin;
  if (tax._tag === "none") return KIN_MONEY_FORMS.invoice.noTax;
  return KIN_MONEY_FORMS.invoice.tax(tax.name, tax.rate, tax.included);
}

/**
 * What the lines come to before tax, each quantity times rate rounded half up as the invoice
 * template works it out; null until a line has both, or when one is in another currency.
 */
export function kinInvoiceBeforeTax(
  lines: ReadonlyArray<KinLineDraft>,
  currency: string,
): string | null {
  let total = 0n;
  let any = false;
  for (const line of lines) {
    if (line.rate.trim() === "") continue;
    const rate = kinParseMoney(line.rate, currency);
    const quantity = QUANTITY.exec(line.quantity.trim());
    if (rate === null || rate.currency !== currency || quantity === null) return null;
    const places = quantity[2] ?? "";
    const num = BigInt(`${quantity[1]}${places}`);
    const den = 10n ** BigInt(places.length);
    const product = BigInt(rate.minor) * num;
    total += product / den + (2n * (product % den) >= den ? 1n : 0n);
    any = true;
  }
  if (!any || total === 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return KIN_MONEY_FORMS.invoice.beforeTax(
    kinMoneyText({ minor: Number(total), currency } satisfies KinMoney, true),
  );
}

/** The invoice's amount as its lines hold it, for the form's one question about a slip. */
export const kinInvoiceAmountAbout = (lines: ReadonlyArray<KinLineDraft>) =>
  lines.map((line) => `${line.quantity.trim()} x ${line.rate.trim()}`).join(" + ");

/** The due days people pick for an invoice, counted from `today`: the usual terms. */
export function kinInvoiceDueChoices(
  today: string,
  now: Date,
): ReadonlyArray<{ readonly day: string; readonly label: string }> {
  const [year, month, date] = today.split("-").map((part) => Number.parseInt(part, 10));
  return [7, 15, 30, 45, 60].map((days) => {
    const at = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + days));
    const day = at.toISOString().slice(0, 10);
    return { day, label: KIN_MONEY_FORMS.invoice.inDays(days, kinWorkDueLabel(day, now)) };
  });
}

export type KinMoneyFormCheck<A> =
  | { readonly ok: true; readonly input: A }
  | { readonly ok: false; readonly problem: string };

/**
 * Whether the form bills a typed name: always with Clients off, never when the chosen project has
 * a client, and otherwise when the person chose it on a host that takes it.
 */
export const kinInvoiceBillsByName = (
  draft: Pick<KinInvoiceDraft, "byName">,
  context: {
    readonly clientsOn: boolean;
    readonly offered: boolean;
    readonly projectClient: string | null;
  },
) => !context.clientsOn || (context.projectClient === null && context.offered && draft.byName);

const billToInput = (billTo: KinBillToDraft) => {
  const text = (value: string, max: number) => value.trim().slice(0, max);
  const address = text(billTo.address, 500);
  const taxNumber = text(billTo.taxNumber, 100);
  const place = text(billTo.place, 100);
  const email = text(billTo.email, 100);
  return {
    name: text(billTo.name, 200),
    ...(address === "" ? {} : { address }),
    ...(taxNumber === "" ? {} : { taxNumber }),
    ...(place === "" ? {} : { place }),
    ...(email === "" ? {} : { email }),
  };
};

/**
 * The invoice as the host takes it, or the first thing to fix; `gst` when India's rate applies,
 * `byName` (from `kinInvoiceBillsByName`) when it bills a typed name instead of a client.
 */
export function kinInvoiceInput(
  orgId: KinOrgId,
  draft: KinInvoiceDraft,
  options: {
    readonly currency: string;
    readonly gst: boolean;
    readonly clientRequestId: string;
    readonly byName?: boolean;
  },
): KinMoneyFormCheck<KinNewInvoiceInput> {
  const billTo = options.byName === true ? billToInput(draft.billTo) : null;
  if (billTo !== null && billTo.name === "") return { ok: false, problem: KIN_BILL_TO.noName };
  if (billTo === null && draft.party === null)
    return { ok: false, problem: KIN_MONEY_FORMS.problem.client };
  const title = oneLine(draft.title).slice(0, 280);
  if (title === "") return { ok: false, problem: KIN_MONEY_FORMS.problem.what };
  const lines = kinLinesInput(draft.lines, options.currency);
  if (!lines.ok) return { ok: false, problem: lines.problem };
  if (lines.lines === null) return { ok: false, problem: KIN_MONEY_FORMS.problem.noLines };
  const gstRate = draft.gstRate.trim();
  if (options.gst && !RATE.test(gstRate))
    return { ok: false, problem: KIN_MONEY_FORMS.problem.gstRate };
  const notes = draft.notes.trim().slice(0, 4_000);
  return {
    ok: true,
    input: {
      orgId,
      ...(billTo !== null ? { billTo } : draft.party === null ? {} : { client: draft.party }),
      title,
      lines: lines.lines.slice(0, 50),
      ...(options.gst ? { gstRate } : {}),
      ...(draft.dueOn !== null && DAY.test(draft.dueOn) ? { dueOn: draft.dueOn } : {}),
      ...(notes === "" ? {} : { notes }),
      ...(draft.project === null ? {} : { project: draft.project }),
      clientRequestId: options.clientRequestId,
    },
  };
}

// The expense

export interface KinExpenseDraft {
  readonly title: string;
  /** As typed: a plain number is in the company's currency, a symbol or code names its own. */
  readonly amount: string;
  /** `YYYY-MM-DD`. */
  readonly paidOn: string;
  readonly vendor: string;
  /** One of the list's categories as stored, or empty. */
  readonly category: string;
  readonly paidWith: string;
  /** The partner who paid from their own money, as a person id; empty is the company. */
  readonly fundedBy: string;
  /** A file's attachment id from the person's chats, or none. */
  readonly receipt: string | null;
}

export const kinExpenseDraft = (today: string): KinExpenseDraft => ({
  title: "",
  amount: "",
  paidOn: today,
  vendor: "",
  category: "",
  paidWith: "",
  fundedBy: "",
  receipt: null,
});

/** The expense's amount as typed, for the form's one question about a slip. */
export const kinExpenseAmountAbout = (draft: KinExpenseDraft) => draft.amount.trim();

export const kinExpenseTyped = (draft: KinExpenseDraft, opened: KinExpenseDraft) =>
  draft.title.trim() !== "" ||
  draft.amount.trim() !== "" ||
  draft.vendor.trim() !== "" ||
  draft.paidOn !== opened.paidOn ||
  draft.category !== "" ||
  draft.paidWith !== "" ||
  draft.fundedBy !== "" ||
  draft.receipt !== null;

/**
 * What the Expenses list offers to pick: its categories, its Paid with choices, and the people who
 * may have funded it. With no list yet there are no categories; the first expense makes the list.
 */
export function kinExpenseChoices(
  def: KinListDefinition | null | undefined,
  people: ReadonlyMap<string, string> = new Map(),
) {
  const funded =
    def == null || def.fields.some((field) => field.key === "fundedBy" && !field.retired);
  return {
    /** Said in place of the picker when Expenses has no Funded by to save it in. */
    fundedByNote: funded || people.size === 0 ? null : KIN_MONEY_FORMS.expense.fundedByNoRoom,
    fundedBy: funded
      ? [...people]
          .map(([value, label]) => ({ value, label }))
          .sort((a, b) => a.label.localeCompare(b.label))
      : [],
    categories: (def?.categories ?? []).map((value) => ({
      value,
      label: kinCategoryLabel(value, def),
    })),
    paidWith:
      def?.fields.find((field) => field.key === "paidWith" && field.retired !== true)?.choices ??
      [],
    receipt: def == null || def.fields.some((field) => field.key === "receipt" && !field.retired),
    first: def == null,
  };
}

/** The expense as the host takes it, or the first thing to fix. */
export function kinExpenseInput(
  orgId: KinOrgId,
  draft: KinExpenseDraft,
  options: { readonly currency: string; readonly clientRequestId: string },
): KinMoneyFormCheck<KinNewExpenseInput> {
  const title = oneLine(draft.title).slice(0, 280);
  if (title === "") return { ok: false, problem: KIN_MONEY_FORMS.problem.expenseWhat };
  const read = parseKinMoney(draft.amount, options.currency);
  if (!("money" in read) || read.money.minor === 0)
    return { ok: false, problem: KIN_MONEY_FORMS.problem.amount };
  const amount = read.money;
  if (!DAY.test(draft.paidOn)) return { ok: false, problem: KIN_MONEY_FORMS.problem.day };
  const vendor = oneLine(draft.vendor).slice(0, 200);
  return {
    ok: true,
    input: {
      orgId,
      title,
      amount,
      paidOn: draft.paidOn,
      ...(vendor === "" ? {} : { vendor }),
      ...(draft.category === "" ? {} : { category: draft.category }),
      ...(draft.paidWith === "" ? {} : { paidWith: draft.paidWith }),
      ...(draft.fundedBy === "" ? {} : { fundedBy: KinPersonId.make(draft.fundedBy) }),
      ...(draft.receipt === null ? {} : { receipt: [draft.receipt] }),
      clientRequestId: options.clientRequestId,
    },
  };
}

/** Who a person field offers: Funded by takes only people, since only a person pays themselves. */
export const kinPersonChoices = <C extends { readonly value: string }>(
  fieldKey: string,
  choices: ReadonlyArray<C>,
): ReadonlyArray<C> =>
  fieldKey === "fundedBy" ? choices.filter((one) => one.value.startsWith("person:")) : choices;

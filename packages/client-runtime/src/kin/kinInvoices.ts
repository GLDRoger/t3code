import type {
  KinDocFile,
  KinIssueResult,
  KinListDefinition,
  KinMakeReceiptInput,
  KinMakeReceiptResult,
  KinOrgId,
  KinPayment,
  KinReceipt,
  KinRecipe,
  KinRecordDetail,
  KinRecordKey,
} from "@t3tools/contracts";

import { kinWorkDueLabel } from "./kinWork.ts";
import { kinMoneyText, kinParseMoney } from "./kinLists.ts";

/**
 * Invoices and receipts as the owner reads and handles them: an invoice's own number, what came
 * in against it and the receipt for each payment, the documents made for it, and Money's receipts.
 */

export const KIN_INVOICES = {
  number: "Invoice number",
  draft: "Draft",
  void: "Void",
  voidNote: "Kept with its number so the series stays complete. It counts for nothing.",
  total: "Total",
  received: "Received",
  balance: "Balance due",
  paidInFull: "Paid in full",
  documents: "Documents",
  noDocuments: "No PDF made yet.",
  makeInvoice: "Make invoice",
  template: "Template",
  preview: "Preview",
  previewing: "Making a preview…",
  previewFailed: "Kin couldn't make the preview.",
  file: "File it",
  filed: "Filed. It's under Documents.",
  noTemplate: "No invoice template yet. Ask an agent to set one up.",
  issue: "Issue",
  issueTitle: "Issue this invoice?",
  issueDetail: (prefix: string | null) =>
    prefix === null
      ? "It gets the next number in its series, for good, and counts as owed."
      : `It gets the next ${prefix} number, for good, and counts as owed.`,
  issued: (number: string | null) => (number === null ? "Issued." : `Issued as ${number}.`),
  issuedProblems: "The number stands, but Kin couldn't make its PDF again:",
  voidAction: "Void",
  voidTitle: "Void this invoice?",
  voidDetail: "It stays in the list with its number and stops counting as owed. You can undo this.",
  unvoid: "Undo void",
  payments: "Payments",
  noPayments: "No payments yet.",
  takenBack: "Taken back",
  makeReceipt: "Make receipt",
  makePdf: "Make its PDF",
  openPdf: "Open PDF",
  receiptMade: (number: string | null) =>
    number === null ? "Receipt made." : `Receipt ${number} made.`,
  receiptSet: (number: string | null, invoice: string) =>
    `${number === null ? "The receipt" : `Receipt ${number}`} is set against ${invoice}.`,
  receiptProblems: "The receipt and its number stand, but Kin couldn't make its PDF:",
};

export const KIN_RECEIPTS = {
  title: "Receipts",
  empty: "A receipt is the note you give a client for money received. None yet.",
  loadFailed: "Couldn't load receipts",
  advance: "Advance",
  against: (invoice: string) => `Set against ${invoice}`,
  unapplied: "Not set against an invoice yet",
  void: "Void",
  newReceipt: "New receipt",
  newDetail: "For money received before an invoice, such as an advance.",
  party: "Received from",
  noClient: "No client",
  amount: "Amount",
  amountPlaceholder: "25,000",
  day: "Received on",
  towards: "What it is for",
  towardsPlaceholder: "Advance for the website build",
  mode: "How it was paid",
  noMode: "Not said",
  reference: "Reference",
  referencePlaceholder: "UTR or cheque number",
  save: "Make receipt",
  setAgainst: "Set against invoice",
  setAgainstDetail: "It is recorded as a payment on the invoice you pick.",
  noInvoices: "This client has no open invoice to set it against.",
  pickInvoice: "Pick an invoice",
};

/** The host's receipt modes; it refuses any other. */
export const KIN_RECEIPT_MODES = [
  { value: "bank transfer", label: "Bank transfer" },
  { value: "upi", label: "UPI" },
  { value: "cheque", label: "Cheque" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
] as const;

export const kinReceiptModeLabel = (mode: string) =>
  KIN_RECEIPT_MODES.find((one) => one.value === mode)?.label ?? KIN_RECEIPTS.noMode;

/** An invoice number at the start of a title: `QST/2026-27/008 · Website build`. */
const NUMBER_FIRST = /^([A-Z][A-Z0-9-]*(?:\/[A-Z0-9-]+)+)\s*(?:[·•|:–—]|-\s)\s*(.+)$/;

/**
 * An invoice's own number and the rest of its title, so the number is the heading and is never
 * shown twice: from its `number` field, else the number its title starts with.
 */
export function kinInvoiceTitle(
  title: string,
  numberField: string | null,
): { readonly number: string | null; readonly description: string | null } {
  const trimmed = title.trim();
  const field = numberField?.trim() || null;
  const found = NUMBER_FIRST.exec(trimmed);
  if (field !== null) {
    if (trimmed === field) return { number: field, description: null };
    if (found !== null && found[1] === field) return { number: field, description: found[2]! };
    return { number: field, description: trimmed };
  }
  return found === null
    ? { number: null, description: trimmed }
    : { number: found[1]!, description: found[2]! };
}

export const kinIsInvoice = (item: Pick<KinRecordDetail, "list">) => item.list === "invoices";

/** The field an issued number is written to; the invoice heading shows it instead. */
export const KIN_INVOICE_NUMBER_FIELD = "number";

const numberFieldOf = (item: KinRecordDetail) => {
  const value = item.fields?.[KIN_INVOICE_NUMBER_FIELD];
  return typeof value === "string" ? value : null;
};

/** Where a payment's receipt is, and the one tap it takes next. */
export type KinPaymentReceiptView =
  | { readonly _tag: "none" }
  /** Only the number another system gave it, from its note: Kin can make the receipt itself. */
  | { readonly _tag: "noted"; readonly number: string }
  | { readonly _tag: "noPdf"; readonly key: KinRecordKey; readonly number: string | null }
  | { readonly _tag: "ready"; readonly number: string | null; readonly document: KinRecordKey };

export interface KinInvoicePaymentView {
  readonly paymentId: string;
  readonly amount: string;
  readonly when: string;
  readonly note: string | null;
  readonly voided: boolean;
  /** Null on a voided payment, which gets no receipt. */
  readonly receipt: KinPaymentReceiptView | null;
}

export interface KinInvoiceView {
  /** The heading: its number, else its title. */
  readonly heading: string;
  /** The rest of the title, under the heading. */
  readonly description: string | null;
  readonly number: string | null;
  readonly void: boolean;
  readonly total: string | null;
  readonly received: string | null;
  /** Null on a void invoice: nothing is due on it. */
  readonly balance: string | null;
  readonly settled: boolean;
  readonly payments: ReadonlyArray<KinInvoicePaymentView>;
  /** Newest first. */
  readonly documents: ReadonlyArray<{ readonly key: KinRecordKey; readonly title: string }>;
  /** The series prefix the next number comes from, for Issue's confirmation. */
  readonly prefix: string | null;
}

const receiptOf = (payment: KinPayment): KinPaymentReceiptView => {
  const receipt = payment.receipt;
  if (receipt === undefined || receipt === null) return { _tag: "none" };
  if (receipt.key === null)
    return receipt.number === null ? { _tag: "none" } : { _tag: "noted", number: receipt.number };
  if (receipt.document === null)
    return { _tag: "noPdf", key: receipt.key as KinRecordKey, number: receipt.number };
  return { _tag: "ready", number: receipt.number, document: receipt.document as KinRecordKey };
};

const DOC_KEY = /^D-\d+$/;

/** An invoice as its page shows it. */
export function kinInvoiceView(
  item: KinRecordDetail,
  def: KinListDefinition | null,
  now: Date,
): KinInvoiceView {
  const { number, description } = kinInvoiceTitle(item.title, numberFieldOf(item));
  const isVoid = item.state === "dropped";
  const received =
    item.amount === undefined || item.balance === undefined
      ? null
      : { minor: item.amount.minor - item.balance.minor, currency: item.amount.currency };
  const seen = new Set<string>();
  const documents = item.links.flatMap((link) => {
    const ref = link.record;
    if (link.kind !== "record" || ref === undefined || !DOC_KEY.test(ref.key) || seen.has(ref.key))
      return [];
    seen.add(ref.key);
    return [{ key: ref.key as KinRecordKey, title: ref.title }];
  });
  return {
    heading: number ?? item.title,
    description: number === null ? null : description,
    number,
    void: isVoid,
    total: item.amount === undefined ? null : kinMoneyText(item.amount, true),
    received: received === null ? null : kinMoneyText(received, true),
    balance: isVoid || item.balance === undefined ? null : kinMoneyText(item.balance, true),
    settled: item.balance?.minor === 0,
    payments: (item.payments ?? []).map((payment) => {
      const receipt = payment.voidedAt !== null ? null : receiptOf(payment);
      const note = payment.note.trim();
      const shown = receipt !== null && "number" in receipt && receipt.number === note;
      return {
        paymentId: payment.paymentId,
        amount: kinMoneyText(payment.amount, true),
        when: kinWorkDueLabel(payment.paidOn, now),
        note: note === "" || shown ? null : note,
        voided: payment.voidedAt !== null,
        receipt,
      };
    }),
    documents: documents.reverse(),
    prefix: def?.numbering?.prefix ?? null,
  };
}

/** What the owner may do on an invoice now, by its state and what this device is allowed. */
export function kinInvoiceActions(
  view: Pick<KinInvoiceView, "void" | "number">,
  def: Pick<KinListDefinition, "numbering" | "states"> | null,
  allowed: {
    readonly render: boolean;
    readonly issue: boolean;
    readonly change: boolean;
    readonly receipt: boolean;
  },
) {
  const numbered = def?.numbering !== undefined;
  return {
    make: allowed.render && !view.void,
    issue: allowed.issue && numbered && !view.void && view.number === null,
    void: allowed.issue && numbered && !view.void && def?.states.includes("dropped") === true,
    unvoid: allowed.change && view.void,
    receipt: allowed.receipt && !view.void,
  };
}

/** The state an undone void goes back to: owed again once it has its number, else a draft. */
export const kinInvoiceUnvoidState = (view: Pick<KinInvoiceView, "number">) =>
  view.number === null ? ("open" as const) : ("waiting" as const);

/** The templates that make documents for `list`. */
export const kinTemplatesFor = (recipes: ReadonlyArray<KinRecipe>, list: string) =>
  recipes.filter((recipe) => recipe.list === list);

// Receipts

export interface KinReceiptView {
  readonly key: KinRecordKey;
  /** Its number, else its key while it has none. */
  readonly heading: string;
  readonly amount: string | null;
  readonly when: string | null;
  readonly from: string | null;
  readonly towards: string | null;
  readonly void: boolean;
  readonly advance: boolean;
  /** "Set against INV-12", or that an advance isn't set against one yet; null otherwise. */
  readonly applied: string | null;
  readonly invoice: KinRecordKey | null;
  /** An advance not yet set against an invoice: the owner can. */
  /** Only an advance from a client: Kin sets one only against that client's own invoice. */
  readonly settable: { readonly party: KinRecordKey } | null;
  readonly document: KinRecordKey | null;
}

export function kinReceiptView(receipt: KinReceipt, now: Date): KinReceiptView {
  const isVoid = receipt.state === "dropped";
  const unapplied = receipt.advance && receipt.invoice === null && !isVoid;
  const towards = receipt.towards?.trim() || null;
  return {
    key: receipt.key,
    heading: receipt.number ?? receipt.key,
    amount: receipt.amount === null ? null : kinMoneyText(receipt.amount, true),
    when: receipt.receivedOn === null ? null : kinWorkDueLabel(receipt.receivedOn, now),
    from: receipt.receivedFrom?.title ?? null,
    // "Invoice INV-6" says no more than "Set against INV-6" beside it.
    towards: towards === `Invoice ${receipt.invoice}` ? null : towards,
    void: isVoid,
    advance: receipt.advance,
    applied:
      receipt.invoice !== null
        ? KIN_RECEIPTS.against(receipt.invoice)
        : unapplied
          ? KIN_RECEIPTS.unapplied
          : null,
    invoice: receipt.invoice,
    settable:
      unapplied && receipt.receivedFrom !== null
        ? { party: receipt.receivedFrom.key as KinRecordKey }
        : null,
    document: (receipt.document?.key as KinRecordKey | undefined) ?? null,
  };
}

export interface KinAdvanceDraft {
  readonly party: KinRecordKey | null;
  readonly amount: string;
  /** `YYYY-MM-DD`. */
  readonly receivedOn: string;
  readonly towards: string;
  readonly mode: string;
  readonly reference: string;
}

export const kinAdvanceDraft = (today: string): KinAdvanceDraft => ({
  party: null,
  amount: "",
  receivedOn: today,
  towards: "",
  mode: "",
  reference: "",
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const optional = (key: "towards" | "mode" | "reference", text: string, max: number) => {
  const value = text.trim().replace(/\s+/g, " ");
  return value === "" ? {} : { [key]: value.slice(0, max) };
};

/** A new advance's receipt as the host takes it, or why it can't be made yet. */
export function kinAdvanceInput(
  orgId: KinOrgId,
  draft: KinAdvanceDraft,
  currency: string,
  clientRequestId: string,
):
  | { readonly ok: true; readonly input: KinMakeReceiptInput }
  | { readonly ok: false; readonly problem: string } {
  const amount = kinParseMoney(draft.amount, currency);
  if (amount === null) return { ok: false, problem: "Enter the amount received, like 25,000." };
  if (!DAY.test(draft.receivedOn)) return { ok: false, problem: "Pick the day it was received." };
  return {
    ok: true,
    input: {
      orgId,
      advance: {
        ...(draft.party === null ? {} : { client: draft.party }),
        amount,
        receivedOn: draft.receivedOn,
      },
      ...optional("towards", draft.towards, 300),
      ...optional("mode", draft.mode, 40),
      ...optional("reference", draft.reference, 120),
      clientRequestId,
    },
  };
}

/** A preview's file, sent as base64, as bytes a client can show or save. */
export function kinBase64Bytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A made file's one line: "PDF · 2 pages · QST/2026-27/008", or "Draft" before its number. */
export function kinDocFileLine(file: KinDocFile): string {
  const kind =
    file.mimeType === "application/pdf"
      ? "PDF"
      : (file.name.split(".").at(-1) ?? "File").toUpperCase();
  return [
    kind,
    file.pages === null ? null : file.pages === 1 ? "1 page" : `${file.pages} pages`,
    file.draft ? "Draft" : file.number,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

const withProblems = (first: string, lead: string, problems: ReadonlyArray<string>) =>
  problems.length === 0 ? first : `${first} ${lead} ${problems.join(" ")}`;

/** What Issue did, in a line: the number it got, and any PDF it couldn't make again. */
export const kinIssueNotice = (result: Pick<KinIssueResult, "number" | "problems">) =>
  withProblems(KIN_INVOICES.issued(result.number), KIN_INVOICES.issuedProblems, result.problems);

/** What Make receipt did, in a line: its number, and why its PDF couldn't be made if it wasn't. */
export const kinReceiptNotice = (result: KinMakeReceiptResult) =>
  withProblems(
    result.receipt.advance && result.receipt.invoice !== null
      ? KIN_INVOICES.receiptSet(result.receipt.number, result.receipt.invoice)
      : KIN_INVOICES.receiptMade(result.receipt.number),
    KIN_INVOICES.receiptProblems,
    result.problems,
  );

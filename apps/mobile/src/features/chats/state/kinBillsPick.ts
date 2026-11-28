import type { KinBillFixDraft, kinBillExpenseStart } from "@t3tools/client-runtime/kin/kinBills";
import type { KinExpenseDraft } from "@t3tools/client-runtime/kin/kinMoneyForms";

/**
 * "Enter by hand" on the phone: the new-expense form is a screen of its own, so what a bill
 * starts it with rides in its address as text, and is read back there.
 */
export type KinExpenseNewParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** A bill's file, as its attachment id and name. */
  readonly receipt?: string;
  readonly receiptName?: string;
  readonly title?: string;
  readonly vendor?: string;
  readonly paidOn?: string;
  readonly amount?: string;
  readonly currency?: string;
  readonly category?: string;
};

export const kinExpenseParamsOfBill = (
  target: { readonly environmentId: string; readonly orgId: string },
  start: ReturnType<typeof kinBillExpenseStart>,
  receiptName: string,
): KinExpenseNewParams => ({
  environmentId: target.environmentId,
  orgId: target.orgId,
  ...start,
  receiptName,
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z]{3}$/;

/** "Fix and keep" on the phone: its editor is a screen too, started from the bill's read. */
export type KinBillFixParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly bill: string;
  readonly receiptName: string;
} & Partial<KinBillFixDraft>;

export const kinBillFixParamsOf = (
  target: { readonly environmentId: string; readonly orgId: string },
  bill: { readonly sha256: string; readonly name: string },
  start: KinBillFixDraft,
): KinBillFixParams => ({
  ...target,
  bill: bill.sha256,
  receiptName: bill.name,
  ...start,
});

/** The editor's start from its address; anything malformed is left empty for the person. */
export function kinBillFixStartOf(params: KinBillFixParams, home: string): KinBillFixDraft {
  const text = (value: string | undefined) => (typeof value === "string" ? value.trim() : "");
  const date = text(params.date);
  const currency = text(params.currency);
  return {
    vendor: text(params.vendor),
    date: DAY.test(date) ? date : "",
    amount: text(params.amount),
    currency: CODE.test(currency) ? currency : home,
    tax: text(params.tax),
    category: text(params.category),
    number: text(params.number),
  };
}

/** What the form starts with from its address; anything malformed is left for the person. */
export function kinExpenseStartOf(params: KinExpenseNewParams): {
  readonly draft: Partial<KinExpenseDraft>;
  readonly receipt: { readonly attachmentId: string; readonly name: string } | null;
} {
  const text = (value: string | undefined) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  const receipt = text(params.receipt);
  const title = text(params.title);
  const vendor = text(params.vendor);
  const paidOn = text(params.paidOn);
  const amount = text(params.amount);
  const currency = text(params.currency);
  const category = text(params.category);
  return {
    draft: {
      ...(receipt === null ? {} : { receipt }),
      ...(title === null ? {} : { title }),
      ...(vendor === null ? {} : { vendor }),
      ...(paidOn === null || !DAY.test(paidOn) ? {} : { paidOn }),
      ...(amount === null ? {} : { amount }),
      ...(currency === null || !CODE.test(currency) ? {} : { currency }),
      ...(category === null ? {} : { category }),
    },
    receipt:
      receipt === null
        ? null
        : { attachmentId: receipt, name: text(params.receiptName) ?? receipt },
  };
}

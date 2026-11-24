import type { kinBillExpenseStart } from "@t3tools/client-runtime/kin/kinBills";
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
  readonly vendor?: string;
  readonly paidOn?: string;
  readonly amount?: string;
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

/** What the form starts with from its address; anything malformed is left for the person. */
export function kinExpenseStartOf(params: KinExpenseNewParams): {
  readonly draft: Partial<KinExpenseDraft>;
  readonly receipt: { readonly attachmentId: string; readonly name: string } | null;
} {
  const text = (value: string | undefined) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  const receipt = text(params.receipt);
  const vendor = text(params.vendor);
  const paidOn = text(params.paidOn);
  const amount = text(params.amount);
  const category = text(params.category);
  return {
    draft: {
      ...(receipt === null ? {} : { receipt }),
      ...(vendor === null ? {} : { vendor }),
      ...(paidOn === null || !DAY.test(paidOn) ? {} : { paidOn }),
      ...(amount === null ? {} : { amount }),
      ...(category === null ? {} : { category }),
    },
    receipt:
      receipt === null
        ? null
        : { attachmentId: receipt, name: text(params.receiptName) ?? receipt },
  };
}

/** Picked files as the add takes them; a photo taken with the camera gets a name of its own. */
export const kinBillChoices = <
  F extends { readonly id: string; readonly name: string; readonly mimeType: string },
>(
  picked: ReadonlyArray<F>,
) =>
  picked.map((source) => ({ id: source.id, name: source.name, mimeType: source.mimeType, source }));

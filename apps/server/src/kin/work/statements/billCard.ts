import { KinChatError, type KinChoiceOutcome, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { retell } from "../../pulse/KinPulse.ts";
import type { BillPaidPlan, BillPlan, CardDraw } from "../../widgets/cardPlans.ts";
import { homeCurrency } from "../companyProfile.ts";
import type { KinRecords, Writer } from "../KinRecords.ts";
import { fieldText, parseFields } from "../lists.ts";
import { dayIn, formatMoney } from "../money.ts";
import { byKey, endOfDay, ownerZone } from "../recordRows.ts";
import { shortDay } from "./bankKnown.ts";
import { bankStates, findBankList } from "./bankList.ts";
import { keyRow } from "./creditPayment.ts";
import { billMatch, billPaidFactKey, MARKED_BILL_PAID } from "./debitBill.ts";

const refuse = (message: string) => new KinChatError({ reason: "invalid_state", message });
const dueText = (day: string | null) => (day === null ? "No date" : shortDay(day));
const amount = (plan: Pick<BillPlan, "amountMinor" | "currency">) =>
  formatMoney({ minor: plan.amountMinor, currency: plan.currency });
const lineVendor = (vendor: string) => {
  const flat = vendor.replace(/\s+/g, " ").trim();
  return flat.length <= 112 ? flat : `${flat.slice(0, 111)}…`;
};

export const drawBill = Effect.fn("KinBillCard.draw")(function* (
  orgId: KinOrgId,
  target: string,
  draw: CardDraw,
) {
  const key = target.trim().toUpperCase();
  const bill = yield* byKey(orgId, key);
  if (
    bill === undefined ||
    bill.registerId !== "expenses" ||
    bill.state !== "open" ||
    bill.confirmed !== 0 ||
    bill.amountMinor === null
  )
    return yield* refuse(
      `${key} isn't a suggested bill to pay: record_bill's target is an Expenses entry an agent suggested, in To pay with an amount.`,
    );
  const due = bill.dueAt ?? bill.dateAt;
  return {
    kind: "record_bill",
    recordId: bill.recordId,
    key: bill.key,
    rev: bill.rev,
    vendor: fieldText(parseFields(bill.fieldsJson), "vendor") ?? bill.title,
    amountMinor: bill.amountMinor,
    currency: bill.currency ?? (yield* homeCurrency(orgId)),
    dueDay: due === null ? null : dayIn(due, yield* ownerZone(orgId)),
    draw,
  } satisfies BillPlan;
});

export const recordBillLabel = "Record this bill";
export const recordBillLine = (plan: BillPlan) =>
  `${lineVendor(plan.vendor)}, ${amount(plan)}, due ${dueText(plan.dueDay)}`;

export const recordBill = Effect.fn("KinBillCard.record")(function* (
  orgId: KinOrgId,
  plan: BillPlan,
  writer: Writer,
  records: KinRecords["Service"],
) {
  const row = yield* records.get(orgId, plan.key);
  if (
    row === undefined ||
    row.recordId !== plan.recordId ||
    row.rev !== plan.rev ||
    row.confirmed !== 0 ||
    row.state !== "open"
  ) {
    const changed = `${plan.key} changed since this card was made, so nothing was recorded.`;
    const text =
      row === undefined || row.recordId !== plan.recordId
        ? `${plan.key} isn't there any more, so nothing was recorded.`
        : row.state === "dropped"
          ? `${plan.key} is void, so nothing was recorded.`
          : row.confirmed !== 0
            ? `${plan.key} is already recorded.`
            : row.state === "open"
              ? `${changed} It is in Money's suggestions.`
              : changed;
    return { title: "Not recorded", text } satisfies KinChoiceOutcome;
  }
  yield* records.update(orgId, writer, plan.key, { confirmed: true }, plan.rev);
  return {
    title: "Recorded",
    text: `${plan.key} is recorded: ${amount(plan)} to ${lineVendor(plan.vendor)}, due ${dueText(plan.dueDay)}. It counts in To pay.`,
  } satisfies KinChoiceOutcome;
});

export const drawBillPaid = Effect.fn("KinBillCard.drawPaid")(function* (
  orgId: KinOrgId,
  target: string,
  draw: CardDraw,
) {
  const key = target.trim().toUpperCase();
  const bank = yield* keyRow(orgId, key);
  const def = yield* findBankList(orgId);
  if (bank === undefined || def === undefined || bank.registerId !== def.id)
    return yield* refuse(
      "mark_bill_paid's target is one Bank transactions debit's key, such as BNK-4.",
    );
  const match = yield* billMatch(orgId, bank.recordId);
  if (match === undefined)
    return yield* refuse(`${bank.key} does not match one bill to pay. Nothing was asked.`);
  return {
    kind: "mark_bill_paid",
    recordId: match.debit.recordId,
    key: match.debit.key,
    rev: match.debit.rev,
    amountMinor: match.debit.amountMinor,
    currency: match.debit.currency,
    day: match.debit.date,
    bill: {
      recordId: match.bill.recordId,
      key: match.bill.key,
      rev: match.bill.rev,
      vendor: match.bill.vendor ?? match.bill.title,
    },
    draw,
  } satisfies BillPaidPlan;
});

export const billPaidLabel = (plan: BillPaidPlan) => `Mark ${plan.bill.key} paid`;
export const billPaidLine = (plan: BillPaidPlan) =>
  `${plan.key}, ${amount(plan)} paid ${shortDay(plan.day)}, for the bill ${plan.bill.key} from ${lineVendor(plan.bill.vendor)}`;

export const markBillPaid = Effect.fn("KinBillCard.markPaid")(function* (
  orgId: KinOrgId,
  plan: BillPaidPlan,
  writer: Writer,
  records: KinRecords["Service"],
) {
  const def = yield* findBankList(orgId);
  const match = yield* billMatch(orgId, plan.recordId);
  if (
    def === undefined ||
    match === undefined ||
    match.debit.key !== plan.key ||
    match.debit.rev !== plan.rev ||
    match.debit.date !== plan.day ||
    match.bill.recordId !== plan.bill.recordId ||
    match.bill.rev !== plan.bill.rev
  ) {
    yield* retell(orgId, billPaidFactKey(plan.key));
    return undefined;
  }
  const dateAt = endOfDay(plan.day, yield* ownerZone(orgId));
  yield* records.update(
    orgId,
    writer,
    plan.bill.key,
    { state: "done", dateAt, dateAllDay: true },
    plan.bill.rev,
  );
  yield* records.update(
    orgId,
    writer,
    plan.key,
    {
      state: bankStates(def).explained,
      ...(def.categories.includes("expense") ? { category: "expense" } : {}),
    },
    plan.rev,
  );
  yield* records.link(orgId, writer, plan.bill.recordId, {
    kind: "record",
    target: plan.recordId,
    relation: "evidence",
    label: `${plan.day} · ${plan.key}`,
  });
  yield* records.link(orgId, writer, plan.recordId, {
    kind: "record",
    target: plan.bill.recordId,
    relation: "relates",
    label: plan.bill.key,
  });
  return {
    title: MARKED_BILL_PAID,
    text: `${plan.bill.key} is paid on ${shortDay(plan.day)} by ${plan.key}, which is explained in Bank transactions.`,
  } satisfies KinChoiceOutcome;
});

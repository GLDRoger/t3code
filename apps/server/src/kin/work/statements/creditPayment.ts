import { KinChatError, type KinChoiceOutcome, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { CardDraw, PaymentPlan } from "../../widgets/cardPlans.ts";
import type { KinRecords, Writer } from "../KinRecords.ts";
import { formatMoney } from "../money.ts";
import { bankStates, findBankList } from "./bankList.ts";
import { shortDay } from "./bankKnown.ts";
import { creditOffer } from "./invoiceCredits.ts";

/**
 * A `kin_ask` option that records a Bank transactions credit as an invoice's payment: drawn only
 * for a pair the statement matcher offers, run only by an owner-level tap while the credit and the
 * invoice are as drawn, with the same writes a statement's Confirm makes for one row.
 */

const refuse = (message: string) => new KinChatError({ reason: "invalid_state", message });

const keyRow = Effect.fn("KinCreditPayment.keyRow")(function* (orgId: KinOrgId, key: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ recordId: string; registerId: string; key: string; title: string }>`
    SELECT record_id AS "recordId", register_id AS "registerId", key, title FROM kin_records
    WHERE org_id = ${orgId} AND key = ${key.toUpperCase()}`;
  return row;
});

export const drawPayment = Effect.fn("KinCreditPayment.draw")(function* (
  orgId: KinOrgId,
  target: string,
  draw: CardDraw,
) {
  const [bankKey, invoiceKey, ...extra] = target.trim().split(/\s+/);
  if (bankKey === undefined || invoiceKey === undefined || extra.length > 0)
    return yield* refuse(
      "record_payment's target is a Bank transactions credit's key, a space, then an invoice's key, such as BNK-1 INV-1.",
    );
  const def = yield* findBankList(orgId);
  const bank = yield* keyRow(orgId, bankKey);
  const invoice = yield* keyRow(orgId, invoiceKey);
  if (bank === undefined || def === undefined || bank.registerId !== def.id)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No Bank transactions entry ${bankKey.slice(0, 40)}.`,
    });
  if (invoice === undefined || invoice.registerId !== "invoices")
    return yield* new KinChatError({
      reason: "not_found",
      message: `No invoice ${invoiceKey.slice(0, 40)}.`,
    });
  const pair = yield* creditOffer(orgId, bank.recordId, invoice.recordId);
  if (pair === undefined)
    return yield* refuse(
      `Kin doesn't offer ${bank.key} as ${invoice.key}'s payment: a card records only an unexplained credit that Kin's bank matching takes for an issued invoice's payment. Nothing was asked; tell the owner what you see instead.`,
    );
  return {
    kind: "record_payment",
    recordId: invoice.recordId,
    key: invoice.key,
    title: invoice.title,
    seen: pair.invoice.seen,
    bankRecordId: bank.recordId,
    bankKey: bank.key,
    rev: pair.credit.rev,
    amountMinor: pair.credit.amountMinor,
    currency: pair.credit.currency,
    day: pair.credit.date,
    withheldMinor:
      pair.candidate.fit === "tds" && pair.candidate.tdsMinor !== undefined
        ? pair.candidate.tdsMinor
        : null,
    draw,
  } satisfies PaymentPlan;
});

const quoted = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return `“${flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`}”`;
};
const received = (plan: PaymentPlan) =>
  `${formatMoney({ minor: plan.amountMinor, currency: plan.currency })} received ${shortDay(plan.day)} (${plan.bankKey})`;
const withheld = (plan: PaymentPlan) =>
  plan.withheldMinor === null
    ? ""
    : `, with ${formatMoney({ minor: plan.withheldMinor, currency: plan.currency })} of tax the client withheld`;

export const paymentLabel = (plan: PaymentPlan) =>
  `Record ${plan.bankKey} as ${plan.key}'s payment`;
export const paymentLine = (plan: PaymentPlan) =>
  `Record ${received(plan)} as ${plan.key} ${quoted(plan.title)}'s payment${withheld(plan)}`;

/**
 * The tap's writes, as `person`: the payment (and the tax withheld) on the invoice, the credit
 * explained, each linked to the other. A changed credit or invoice since the draw does nothing.
 */
export const recordPayment = Effect.fn("KinCreditPayment.record")(function* (
  orgId: KinOrgId,
  plan: PaymentPlan,
  writer: Writer,
  widgetId: string,
  records: KinRecords["Service"],
) {
  const pair = yield* creditOffer(orgId, plan.bankRecordId, plan.recordId);
  const def = yield* findBankList(orgId);
  if (
    pair === undefined ||
    def === undefined ||
    pair.credit.rev !== plan.rev ||
    pair.invoice.seen !== plan.seen ||
    (pair.candidate.fit === "tds" ? (pair.candidate.tdsMinor ?? null) : null) !== plan.withheldMinor
  )
    return undefined;
  const origin = `card:${widgetId}:${plan.bankRecordId}`;
  yield* records.pay(orgId, writer, plan.key, {
    amount: { minor: plan.amountMinor, currency: plan.currency },
    paidOn: plan.day,
    note: `${plan.bankKey} in Bank transactions, ${plan.day}`,
    originKey: `${origin}:received`,
  });
  if (plan.withheldMinor !== null)
    yield* records.pay(orgId, writer, plan.key, {
      amount: { minor: plan.withheldMinor, currency: plan.currency },
      paidOn: plan.day,
      note: `Tax the client withheld on ${plan.day}`,
      withheld: true,
      originKey: `${origin}:withheld`,
    });
  yield* records.update(
    orgId,
    writer,
    plan.bankKey,
    {
      state: bankStates(def).explained,
      ...(def.categories.includes("payment received") ? { category: "payment received" } : {}),
    },
    plan.rev,
  );
  yield* records.link(orgId, writer, plan.recordId, {
    kind: "record",
    target: plan.bankRecordId,
    relation: "evidence",
    label: `${plan.day} · ${plan.bankKey}`,
  });
  yield* records.link(orgId, writer, plan.bankRecordId, {
    kind: "record",
    target: plan.recordId,
    relation: "relates",
    label: plan.key,
  });
  return {
    title: "Payment recorded",
    text: `Recorded ${received(plan)} as ${plan.key} ${quoted(plan.title)}'s payment${withheld(plan)}. ${plan.bankKey} is explained in Bank transactions.`,
  } satisfies KinChoiceOutcome;
});

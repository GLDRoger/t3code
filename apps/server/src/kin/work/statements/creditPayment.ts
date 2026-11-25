import { KinChatError, type KinChoiceOutcome, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { retell } from "../../pulse/KinPulse.ts";
import type { CardDraw, PaymentPlan } from "../../widgets/cardPlans.ts";
import type { KinRecords, Writer } from "../KinRecords.ts";
import { formatMoney } from "../money.ts";
import { byNumber, recordName } from "../recordRows.ts";
import { BANK_CREDIT_ORIGIN, bankStates, findBankList } from "./bankList.ts";
import { shortDay } from "./bankKnown.ts";
import { agentWrote, creditMatch, type CreditPair } from "./invoiceCredits.ts";

/**
 * A `kin_ask` option that records a Bank transactions credit as an invoice's payment: drawn only
 * for the invoice the statement matcher ranks first for that credit, run only by an owner-level
 * tap while the credit and the invoice are as drawn, with the writes a statement's Confirm makes
 * for one row. Every word the card shows is Kin's, from the records.
 */

const refuse = (message: string) => new KinChatError({ reason: "invalid_state", message });
const NOTHING_ASKED = "Nothing was asked; tell the owner what you see instead.";

export const keyRow = Effect.fn("KinCreditPayment.keyRow")(function* (
  orgId: KinOrgId,
  key: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ recordId: string; registerId: string; key: string }>`
    SELECT record_id AS "recordId", register_id AS "registerId", key FROM kin_records
    WHERE org_id = ${orgId} AND key = ${key.toUpperCase()}`;
  return row;
});

const targetOf = (bankKey: string, pair: CreditPair) => `"${bankKey} ${pair.invoice.key}"`;
const names = (pairs: ReadonlyArray<CreditPair>) =>
  pairs.map((pair) => recordName(pair.invoice.key, pair.invoice.number)).join(" and ");

export const drawPayment = Effect.fn("KinCreditPayment.draw")(function* (
  orgId: KinOrgId,
  target: string,
  draw: CardDraw,
) {
  const [bankKey, invoiceWord, ...extra] = target.trim().split(/\s+/);
  if (bankKey === undefined || bankKey === "" || extra.length > 0)
    return yield* refuse(
      "record_payment's target is a Bank transactions credit's key, alone or followed by a space and an invoice's key or number, such as BNK-1 or BNK-1 INV-1.",
    );
  const def = yield* findBankList(orgId);
  const bank = yield* keyRow(orgId, bankKey);
  if (bank === undefined || def === undefined || bank.registerId !== def.id)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No Bank transactions entry ${bankKey.slice(0, 40)}.`,
    });
  if (yield* agentWrote(orgId, bank.recordId))
    return yield* refuse(
      `${bank.key} was written or changed by an agent, so Kin can't take it as the bank's word that money came in. ${NOTHING_ASKED} A person can record the payment on the invoice.`,
    );
  const match = yield* creditMatch(orgId, bank.recordId);
  if (match === undefined)
    return yield* refuse(
      `${bank.key} isn't an unexplained credit that Kin's bank matching takes for an open invoice's payment. ${NOTHING_ASKED}`,
    );
  if (match.recorded !== undefined)
    return yield* refuse(
      `${bank.key} may be the payment already recorded on ${match.recorded.key} on ${match.recorded.paidOn}, so Kin offers no card for it. ${NOTHING_ASKED}`,
    );
  const { first } = match;
  let pair: CreditPair | undefined;
  if (invoiceWord === undefined) {
    if (first.length > 1)
      return yield* refuse(
        `${bank.key} fits ${names(first)} equally, so Kin can't pick one. Offer one option per invoice, with targets ${first.map((one) => targetOf(bank.key, one)).join(" and ")}.`,
      );
    pair = first[0];
  } else {
    const named = yield* keyRow(orgId, invoiceWord);
    const invoice =
      named?.registerId === "invoices"
        ? named
        : yield* Effect.map(byNumber(orgId, invoiceWord), (row) =>
            row?.registerId === "invoices" ? row : undefined,
          );
    if (invoice === undefined)
      return yield* new KinChatError({
        reason: "not_found",
        message: `No invoice ${invoiceWord.slice(0, 40)}.`,
      });
    pair = first.find((one) => one.invoice.recordId === invoice.recordId);
    if (pair === undefined)
      return yield* refuse(
        `Kin ranks ${names(first)} first for ${bank.key}, not ${invoice.key}. Offer ${first.map((one) => targetOf(bank.key, one)).join(" and ")} instead.`,
      );
  }
  const chosen = pair!;
  const withheldMinor =
    chosen.candidate.fit === "tds" && chosen.candidate.tdsMinor !== undefined
      ? chosen.candidate.tdsMinor
      : null;
  return {
    kind: "record_payment",
    recordId: chosen.invoice.recordId,
    key: chosen.invoice.key,
    title: chosen.invoice.title,
    number: chosen.invoice.number ?? chosen.invoice.key,
    client: chosen.invoice.client,
    seen: chosen.invoice.seen,
    bankRecordId: bank.recordId,
    bankKey: bank.key,
    rev: chosen.credit.rev,
    amountMinor: chosen.credit.amountMinor,
    currency: chosen.credit.currency,
    day: chosen.credit.date,
    withheldMinor,
    owedAfterMinor:
      chosen.invoice.amountMinor -
      chosen.invoice.paidMinor -
      chosen.credit.amountMinor -
      (withheldMinor ?? 0),
    draw,
  } satisfies PaymentPlan;
});

const money = (plan: PaymentPlan, minor: number) => formatMoney({ minor, currency: plan.currency });
const what = (plan: PaymentPlan) =>
  `${money(plan, plan.amountMinor)} received ${shortDay(plan.day)} (${plan.bankKey}) as the payment of ${plan.number}${
    plan.client === null ? "" : ` from ${plan.client}`
  }${
    plan.withheldMinor === null
      ? ""
      : `, with ${money(plan, plan.withheldMinor)} of tax the client withheld`
  }`;

export const paymentLabel = (plan: PaymentPlan) =>
  `Record ${money(plan, plan.amountMinor)} for ${plan.number}`;
export const paymentLine = (plan: PaymentPlan) =>
  `Record ${what(plan)}; ${
    plan.owedAfterMinor <= 0
      ? "it settles the invoice in full"
      : `${money(plan, plan.owedAfterMinor)} stays owed on it`
  }`;

/**
 * The tap's writes, as `person`: the payment (and the tax withheld) on the invoice, the credit
 * explained, each linked to the other. A credit or invoice changed since the draw records nothing,
 * and its fact is told again on the next pass if it still holds.
 */
export const recordPayment = Effect.fn("KinCreditPayment.record")(function* (
  orgId: KinOrgId,
  plan: PaymentPlan,
  writer: Writer,
  widgetId: string,
  records: KinRecords["Service"],
) {
  const match = yield* creditMatch(orgId, plan.bankRecordId);
  const pair = match?.first.find((one) => one.invoice.recordId === plan.recordId);
  const def = yield* findBankList(orgId);
  if (
    match === undefined ||
    match.recorded !== undefined ||
    pair === undefined ||
    def === undefined ||
    pair.credit.rev !== plan.rev ||
    pair.invoice.seen !== plan.seen ||
    (pair.candidate.fit === "tds" ? (pair.candidate.tdsMinor ?? null) : null) !== plan.withheldMinor
  ) {
    yield* retell(orgId, `payment_seen:${plan.bankKey}`);
    return undefined;
  }
  const origin = `${BANK_CREDIT_ORIGIN}${plan.bankRecordId}:${widgetId}`;
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
    text: `Recorded ${what(plan)}; ${
      plan.owedAfterMinor <= 0
        ? "the invoice is paid in full"
        : `${money(plan, plan.owedAfterMinor)} is still owed on it`
    }. ${plan.bankKey} is explained in Bank transactions.`,
  } satisfies KinChoiceOutcome;
});

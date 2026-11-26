import {
  KinChatError,
  type KinChoiceOutcome,
  type KinOrgId,
  kinRateShown,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { retell } from "../../pulse/KinPulse.ts";
import type { ApplyPlan, CardDraw, PaymentPlan, PaymentTerms } from "../../widgets/cardPlans.ts";
import { KinRecords, type Writer } from "../KinRecords.ts";
import { formatMoney } from "../money.ts";
import { backed, receiptsList, setAgainst } from "../../gendocs/receipts.ts";
import { invoiceCandidates } from "./statementReview.ts";
import {
  byKey,
  byNumber,
  creditForInvoice,
  endOfDay,
  ownerZone,
  recordName,
} from "../recordRows.ts";
import { BANK_CREDIT_ORIGIN, bankStates, findBankList } from "./bankList.ts";
import { shortDay } from "./bankKnown.ts";
import { parseFields } from "../lists.ts";
import { agentWrote, creditMatch, type CreditPair, rateMoney } from "./invoiceCredits.ts";

/**
 * A `kin_ask` option that records a Bank transactions credit as an invoice's payment: drawn only
 * for the invoice the statement matcher ranks first for that credit, run only by an owner-level
 * tap while the credit and the invoice are as drawn, with the writes a statement's Confirm makes
 * for one row. Every word the card shows is Kin's, from the records.
 */

const refuse = (message: string) => new KinChatError({ reason: "invalid_state", message });
export const PAYMENT_TAP_REFUSAL = "Only the owner or a co-owner confirms money received.";
export const paymentChanged = (bankKey: string, invoiceKey?: string): KinChoiceOutcome => ({
  title: "Nothing was done",
  text: `${invoiceKey === undefined ? bankKey : `${bankKey} or ${invoiceKey}`} changed since this was offered, so nothing was done.`,
});
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

const namedInvoice = Effect.fn("KinCreditPayment.namedInvoice")(function* (
  orgId: KinOrgId,
  word: string,
) {
  const keyed = yield* keyRow(orgId, word);
  const row = keyed?.registerId === "invoices" ? keyed : yield* byNumber(orgId, word);
  if (row?.registerId === "invoices") return row;
  return yield* new KinChatError({
    reason: "not_found",
    message: `No invoice ${word.slice(0, 40)}.`,
  });
});

export const drawPayment = Effect.fn("KinCreditPayment.draw")(function* (
  orgId: KinOrgId,
  target: string,
  draw: CardDraw,
) {
  const [bankKey, invoiceWord, ...extra] = target.trim().split(/\s+/);
  if (bankKey === undefined || bankKey === "" || extra.length > 4)
    return yield* refuse(
      "record_payment's target is a Bank transactions credit's key, alone or followed by up to five invoice keys or numbers, such as BNK-1 or BNK-1 INV-1 INV-2.",
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
  if (match === undefined || match.first.length === 0)
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
    const invoice = yield* namedInvoice(orgId, invoiceWord);
    pair = first.find((one) => one.invoice.recordId === invoice.recordId);
    if (pair === undefined)
      return yield* refuse(
        `Kin ranks ${names(first)} first for ${bank.key}, not ${invoice.key}. Offer ${first.map((one) => targetOf(bank.key, one)).join(" and ")} instead.`,
      );
  }
  const chosen = pair!;
  let split: Pick<PaymentPlan, "splits" | "leftMinor"> = {};
  let client: PaymentPlan["client"] = chosen.invoice.client;
  if (extra.length > 0 || chosen.candidate.fit === "over") {
    if ("rate" in chosen)
      return yield* refuse("A credit in another currency can settle only one invoice.");
    if (chosen.invoice.clientId == null || chosen.invoice.client === null)
      return yield* refuse("Every invoice must name the same client.");
    client = { id: chosen.invoice.clientId, name: chosen.invoice.client };
    const splits: Array<NonNullable<PaymentPlan["splits"]>[number]> = [];
    let rest = chosen.credit.amountMinor;
    const others = yield* Effect.forEach(extra, (word) => namedInvoice(orgId, word));
    const invoices = others.length === 0 ? [] : yield* invoiceCandidates(orgId, undefined);
    for (const invoice of [
      chosen.invoice,
      ...others.map((row) => invoices.find((one) => one.recordId === row.recordId)),
    ]) {
      if (
        invoice === undefined ||
        invoice.issued === null ||
        invoice.number === null ||
        invoice.paidMinor >= invoice.amountMinor
      )
        return yield* refuse("Every invoice must be issued and still owed.");
      if (invoice.clientId !== client.id || invoice.currency !== chosen.credit.currency)
        return yield* refuse(
          "Every invoice must be for the same client and in the credit's currency.",
        );
      if (splits.some((one) => one.recordId === invoice.recordId))
        return yield* refuse("Name each invoice only once.");
      if (rest <= 0) return yield* refuse("The credit is already used up by the earlier invoices.");
      const balance = invoice.amountMinor - invoice.paidMinor;
      const amountMinor = Math.min(balance, rest);
      splits.push({
        recordId: invoice.recordId,
        key: invoice.key,
        number: invoice.number ?? invoice.key,
        seen: invoice.seen,
        amountMinor,
        owedAfterMinor: balance - amountMinor,
      });
      rest -= amountMinor;
    }
    split = { splits, leftMinor: rest };
  }
  const withheldMinor =
    split.splits === undefined &&
    chosen.candidate.fit === "tds" &&
    chosen.candidate.tdsMinor !== undefined
      ? chosen.candidate.tdsMinor
      : null;
  const amount =
    "rate" in chosen
      ? chosen.owed
      : { minor: chosen.credit.amountMinor, currency: chosen.credit.currency };
  return {
    kind: "record_payment",
    recordId: chosen.invoice.recordId,
    key: chosen.invoice.key,
    title: chosen.invoice.title,
    number: chosen.invoice.number ?? chosen.invoice.key,
    client,
    ...split,
    seen: chosen.invoice.seen,
    bankRecordId: bank.recordId,
    bankKey: bank.key,
    rev: chosen.credit.rev,
    amountMinor: amount.minor,
    currency: amount.currency,
    ...("rate" in chosen ? { received: chosen.received, rate: chosen.rate } : {}),
    day: chosen.credit.date,
    withheldMinor,
    owedAfterMinor:
      chosen.invoice.amountMinor - chosen.invoice.paidMinor - amount.minor - (withheldMinor ?? 0),
    draw,
  } satisfies PaymentPlan;
});

const money = (plan: PaymentTerms, minor: number) =>
  formatMoney({ minor, currency: plan.currency });
const clientName = (plan: PaymentTerms) =>
  typeof plan.client === "string" ? plan.client : plan.client?.name;
const joined = (parts: ReadonlyArray<string>) =>
  parts.length < 3 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
const what = (plan: PaymentTerms) =>
  `${money(plan, plan.amountMinor)} received ${shortDay(plan.day)} (${plan.bankKey}) as the payment of ${plan.number}${
    clientName(plan) === undefined ? "" : ` from ${clientName(plan)}`
  }${
    plan.withheldMinor === null
      ? ""
      : `, with ${money(plan, plan.withheldMinor)} of tax the client withheld`
  }`;

const settledWhat = (plan: PaymentTerms, showBankKey: boolean) => {
  if (plan.received === undefined || plan.rate === undefined) return undefined;
  const client = showBankKey && clientName(plan) !== undefined ? ` from ${clientName(plan)}` : "";
  const bankKey = showBankKey ? ` (${plan.bankKey})` : "";
  const owed = rateMoney({ minor: plan.amountMinor, currency: plan.currency });
  return `${plan.number}${client} (${owed}) with ${rateMoney(plan.received)} received on ${shortDay(plan.day)}${bankKey}, a rate of ${kinRateShown(plan.rate)}`;
};

export const paymentLabel = (plan: PaymentPlan) =>
  plan.splits !== undefined
    ? `Record ${money(plan, plan.amountMinor)} from ${plan.bankKey}`
    : plan.rate === undefined
      ? `Record ${money(plan, plan.amountMinor)} for ${plan.number}`
      : `Settle ${plan.number}`;
export const paymentLine = (plan: PaymentPlan) => {
  if (plan.splits !== undefined) {
    const name = clientName(plan);
    const parts = plan.splits.map((part) =>
      part.owedAfterMinor === 0
        ? `${money(plan, part.amountMinor)} settles ${part.number}`
        : `${money(plan, part.amountMinor)} of the ${money(plan, part.amountMinor + part.owedAfterMinor)} owed on ${part.number}`,
    );
    if (plan.leftMinor) parts.push(`${money(plan, plan.leftMinor)} stays as ${name}'s credit`);
    return `Record ${money(plan, plan.amountMinor)} received ${shortDay(plan.day)} (${plan.bankKey}) from ${name}: ${joined(parts)}`;
  }
  const settlement = settledWhat(plan, true);
  if (settlement !== undefined) return `Settle ${settlement}`;
  return `Record ${what(plan)}; ${
    plan.owedAfterMinor <= 0
      ? "it settles the invoice in full"
      : `${money(plan, plan.owedAfterMinor)} stays owed on it`
  }`;
};

/**
 * The tap's writes, as `person`: the payment (and the tax withheld) on the invoice, the credit
 * explained, each linked to the other. A credit or invoice changed since the draw records nothing,
 * and its fact is told again on the next pass if it still holds.
 */
export const recordPayment = Effect.fn("KinCreditPayment.record")(
  function* (
    orgId: KinOrgId,
    plan: PaymentTerms,
    writer: Writer,
    widgetId: string,
    records: KinRecords["Service"],
  ) {
    const match = yield* creditMatch(orgId, plan.bankRecordId);
    const findInvoice = (one: { readonly invoice: { readonly recordId: string } }) =>
      one.invoice.recordId === plan.recordId;
    const choice =
      plan.invoiceRev === undefined ? undefined : match?.choice?.options.find(findInvoice);
    const pair = plan.invoiceRev === undefined ? match?.first.find(findInvoice) : choice;
    const def = yield* findBankList(orgId);
    const ratePair = pair !== undefined && "rate" in pair ? pair : undefined;
    if (
      match === undefined ||
      match.recorded !== undefined ||
      pair === undefined ||
      def === undefined ||
      match.credit.rev !== plan.rev ||
      choice?.invoice.rev !== plan.invoiceRev ||
      (choice !== undefined && choice.invoice.client !== plan.client) ||
      pair.invoice.seen !== plan.seen ||
      ratePair?.rate !== plan.rate ||
      ratePair?.received.minor !== plan.received?.minor ||
      ratePair?.received.currency !== plan.received?.currency ||
      (ratePair !== undefined &&
        (ratePair.owed.minor !== plan.amountMinor || ratePair.owed.currency !== plan.currency)) ||
      (plan.splits === undefined &&
        (pair.candidate.fit === "tds" ? (pair.candidate.tdsMinor ?? null) : null) !==
          plan.withheldMinor)
    ) {
      yield* retell(orgId, `payment_seen:${plan.bankKey}`);
      return undefined;
    }
    const origin = `${BANK_CREDIT_ORIGIN}${plan.bankRecordId}:${widgetId}`;
    let creditKey: string | undefined;
    if (plan.splits !== undefined) {
      const client = plan.client;
      if (typeof client !== "object" || client === null || writer.actor._tag !== "person")
        return yield* refuse(PAYMENT_TAP_REFUSAL);
      const invoices = yield* invoiceCandidates(orgId, undefined);
      if (
        plan.splits.some(
          (part) =>
            !invoices.some(
              (invoice) =>
                part.recordId === invoice.recordId &&
                part.seen === invoice.seen &&
                invoice.clientId === client.id &&
                invoice.currency === plan.currency &&
                invoice.issued !== null &&
                invoice.number !== null,
            ),
        )
      ) {
        yield* retell(orgId, `payment_seen:${plan.bankKey}`);
        return undefined;
      }
      for (const part of plan.splits) {
        yield* records.pay(orgId, writer, part.key, {
          amount: { minor: part.amountMinor, currency: plan.currency },
          paidOn: plan.day,
          note: `${plan.bankKey} in Bank transactions, ${plan.day}`,
          originKey: `${origin}:split:${part.recordId}`,
        });
        if (part.recordId !== plan.recordId)
          yield* records.link(orgId, writer, part.recordId, {
            kind: "record",
            target: plan.bankRecordId,
            relation: "evidence",
            label: `${plan.day} · ${plan.bankKey}`,
          });
      }
      if (plan.leftMinor) {
        const receipts = yield* receiptsList(orgId);
        const { row } = yield* records.create(orgId, writer, {
          list: receipts.id,
          originKey: `${origin}:left`,
          title: `Advance from ${client.name}`,
          owner: writer.actor,
          state: "open",
          amount: { minor: plan.leftMinor, currency: plan.currency },
          dateAt: endOfDay(plan.day, yield* ownerZone(orgId)),
          dateAllDay: true,
          partyId: client.id,
          fields: { towards: `Credit from ${plan.bankKey}` },
          links: [
            {
              kind: "record",
              target: plan.bankRecordId,
              relation: "evidence",
              label: plan.bankKey,
            },
          ],
        });
        yield* backed(orgId, writer, row.key, false);
        creditKey = row.key;
      }
    } else
      yield* records.pay(orgId, writer, plan.key, {
        amount: { minor: plan.amountMinor, currency: plan.currency },
        ...(ratePair === undefined ? {} : { received: ratePair.received, rate: ratePair.rate }),
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
    if (plan.splits !== undefined) {
      const settled = plan.splits
        .filter((part) => part.owedAfterMinor === 0)
        .map((part) => part.number);
      const partial = plan.splits
        .filter((part) => part.owedAfterMinor > 0)
        .map((part) => `${money(plan, part.owedAfterMinor)} is still owed on ${part.number}`);
      const parts = [
        ...(settled.length === 0
          ? []
          : [`${joined(settled)} ${settled.length === 1 ? "is" : "are"} paid in full`]),
        ...partial,
        ...(creditKey === undefined
          ? []
          : [`${money(plan, plan.leftMinor ?? 0)} is ${clientName(plan)}'s credit (${creditKey})`]),
      ];
      const result =
        creditKey !== undefined && settled.length > 0 ? parts.join(", and ") : joined(parts);
      return {
        title: "Payment recorded",
        text: `Recorded ${money(plan, plan.amountMinor)} received ${shortDay(plan.day)}: ${result}. ${plan.bankKey} is explained in Bank transactions.`,
      };
    }
    const settlement = settledWhat(plan, false);
    return {
      title: "Payment recorded",
      text:
        settlement !== undefined
          ? `Settled ${settlement}; the invoice is paid in full. ${plan.bankKey} is explained in Bank transactions.`
          : `Recorded ${what(plan)}; ${
              plan.owedAfterMinor <= 0
                ? "the invoice is paid in full"
                : `${money(plan, plan.owedAfterMinor)} is still owed on it`
            }. ${plan.bankKey} is explained in Bank transactions.`,
    } satisfies KinChoiceOutcome;
  },
  (effect) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(effect)),
);

export const undo = Effect.fn("KinCreditPayment.undo")(function* (
  orgId: KinOrgId,
  writer: Writer,
  key: string,
) {
  return yield* (yield* KinRecords).undoCreditPayment(orgId, writer, key);
});

export const drawApply = Effect.fn("KinCreditPayment.drawApply")(function* (
  orgId: KinOrgId,
  target: string,
  draw: CardDraw,
) {
  const [receipt, invoice, ...extra] = target.trim().split(/\s+/);
  if (!receipt || !invoice || extra.length > 0)
    return yield* refuse("apply_credit needs a receipt and an invoice, such as RCT-3 INV-14.");
  const named = yield* namedInvoice(orgId, invoice);
  const row = yield* byKey(orgId, named.key);
  if (row === undefined) return yield* refuse("That invoice changed. Nothing was asked.");
  const advance = yield* byKey(orgId, receipt);
  if (advance?.registerId !== "receipts")
    return yield* new KinChatError({
      reason: "not_found",
      message: `No receipt ${receipt.slice(0, 40)}.`,
    });
  const credit = yield* creditForInvoice(orgId, row, advance.key);
  if (credit === undefined || row.amountMinor === null || row.partyTitle === null)
    return yield* refuse("That credit does not fit this invoice. Nothing was asked.");
  const number = parseFields(row.fieldsJson).number;
  return {
    kind: "apply_credit",
    key: row.key,
    receipt: credit.key,
    client: row.partyTitle,
    invoiceRev: row.rev,
    receiptRev: credit.rev,
    paymentId: credit.paymentId,
    number: typeof number === "string" ? number : row.key,
    amount: credit.amount,
    receivedOn: credit.receivedOn,
    owedAfterMinor: row.amountMinor - row.paid - credit.amount.minor,
    draw,
  } satisfies ApplyPlan;
});

const applyBalance = (plan: ApplyPlan) =>
  formatMoney({ currency: plan.amount.currency, minor: plan.owedAfterMinor });
export const applyLabel = (plan: ApplyPlan) => `Apply ${formatMoney(plan.amount)} credit`;
export const applyLine = (plan: ApplyPlan) =>
  `Set ${plan.client}'s ${formatMoney(plan.amount)} credit from ${shortDay(plan.receivedOn)} (${plan.receipt}) against ${plan.number}; ${applyBalance(plan)} stays owed on it`;

export const applyCredit = Effect.fn("KinCreditPayment.applyCredit")(function* (
  orgId: KinOrgId,
  plan: ApplyPlan,
  writer: Writer,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const row = yield* records.get(orgId, plan.key);
      if (row === undefined || row.rev !== plan.invoiceRev) return undefined;
      const credit = yield* creditForInvoice(orgId, row, plan.receipt);
      if (credit?.rev !== plan.receiptRev || credit.paymentId !== plan.paymentId) return undefined;
      yield* setAgainst(orgId, writer, plan.receipt, plan.key, false);
      return {
        title: "Credit applied",
        text: `Applied ${formatMoney(plan.amount)} credit to ${plan.number}; ${applyBalance(plan)} is still owed on it.`,
      };
    }),
  );
});

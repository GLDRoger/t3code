import { KinChatError, type KinChoiceOutcome, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { retell } from "../../pulse/KinPulse.ts";
import type { CardDraw, RepaidPlan } from "../../widgets/cardPlans.ts";
import type { KinRecords, Writer } from "../KinRecords.ts";
import { formatMoney } from "../money.ts";
import { REIMBURSEMENT, REPAID_ON } from "../reimbursement.ts";
import { bankStates, findBankList } from "./bankList.ts";
import { shortDay } from "./bankKnown.ts";
import { keyRow } from "./creditPayment.ts";
import { type RepaidMatch, repaidMatch } from "./debitRepaid.ts";
import { agentWrote } from "./invoiceCredits.ts";

/**
 * A `kin_ask` option that marks a partner's owed expenses repaid by a Bank transactions debit:
 * drawn only when Kin's matcher reads the debit as paying back exactly a run of the oldest owed
 * expenses of the one partner it names, run only by an owner-level tap while the debit and every
 * expense are as drawn. Whole expenses only; who paid each is never changed.
 */

const refuse = (message: string) => new KinChatError({ reason: "invalid_state", message });
const NOTHING_ASKED = "Nothing was asked; tell the owner what you see instead.";
export const repaidFactKey = (bankKey: string) => `repaid_seen:${bankKey}`;

export const drawRepaid = Effect.fn("KinRepaidCard.draw")(function* (
  orgId: KinOrgId,
  target: string,
  draw: CardDraw,
) {
  const [bankKey, ...extra] = target.trim().split(/\s+/);
  if (bankKey === undefined || bankKey === "" || extra.length > 0)
    return yield* refuse(
      "mark_repaid's target is one Bank transactions debit's key, such as BNK-4.",
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
      `${bank.key} was written or changed by an agent, so Kin can't take it as the bank's word that money went out. ${NOTHING_ASKED} A person can mark the expenses repaid in Money.`,
    );
  const match = yield* repaidMatch(orgId, bank.recordId);
  if (match === undefined)
    return yield* refuse(
      `${bank.key} isn't an unexplained debit that names one partner the company owes, so Kin offers no card for it. ${NOTHING_ASKED}`,
    );
  if (match.marked)
    return yield* refuse(
      `${bank.key} may be the repayment already marked by hand for ${match.partner.name} on ${match.debit.date}, so Kin offers no card for it. ${NOTHING_ASKED}`,
    );
  if (match.repays === undefined)
    return yield* refuse(
      `${bank.key} names ${match.partner.name} but doesn't add up exactly to their oldest owed expenses, so Kin marks nothing and offers no card for it. ${NOTHING_ASKED}`,
    );
  return planOf(match, match.repays, draw);
});

const planOf = (match: RepaidMatch, repays: NonNullable<RepaidMatch["repays"]>, draw: CardDraw) =>
  ({
    kind: "mark_repaid",
    recordId: match.debit.recordId,
    key: match.debit.key,
    rev: match.debit.rev,
    amountMinor: match.debit.amountMinor,
    currency: match.debit.currency,
    day: match.debit.date,
    partner: match.partner,
    repays: repays.map((one) => ({ ...one })),
    owedAfterMinor: Number(match.owedMinor - BigInt(match.debit.amountMinor)),
    draw,
  }) satisfies RepaidPlan;

/** The same debit, partner, expenses and what stays owed as drawn: anything else marks nothing. */
const asDrawn = (match: RepaidMatch | undefined, plan: RepaidPlan) => {
  if (match === undefined || match.marked || match.repays === undefined) return false;
  const now = planOf(match, match.repays, plan.draw);
  return (
    now.recordId === plan.recordId &&
    now.key === plan.key &&
    now.rev === plan.rev &&
    now.amountMinor === plan.amountMinor &&
    now.currency === plan.currency &&
    now.day === plan.day &&
    now.partner.id === plan.partner.id &&
    now.partner.name === plan.partner.name &&
    now.owedAfterMinor === plan.owedAfterMinor &&
    now.repays.length === plan.repays.length &&
    now.repays.every((one, at) => {
      const was = plan.repays[at]!;
      return (
        one.recordId === was.recordId &&
        one.key === was.key &&
        one.rev === was.rev &&
        one.amountMinor === was.amountMinor &&
        one.day === was.day
      );
    })
  );
};

const money = (plan: RepaidPlan, minor: number) => formatMoney({ minor, currency: plan.currency });
/** The keys, all when they fit in `max` with the rest of `build`'s words, else the first and a count. */
const fitted = (plan: RepaidPlan, build: (keys: string) => string, max: number) => {
  const keys = plan.repays.map((one) => one.key);
  for (let shown = keys.length; shown > 0; shown--) {
    const left = keys.length - shown;
    const listed =
      left === 0
        ? keys.length === 1
          ? keys[0]!
          : `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`
        : `${keys.slice(0, shown).join(", ")} and ${left} more`;
    const text = build(listed);
    if (text.length <= max) return text;
  }
  return build(`${keys.length} expenses`);
};
const owedAfter = (plan: RepaidPlan) =>
  plan.owedAfterMinor <= 0
    ? `nothing more is owed to ${plan.partner.name}`
    : `${money(plan, plan.owedAfterMinor)} stays owed to ${plan.partner.name}`;
const total = (plan: RepaidPlan) =>
  `${money(plan, plan.amountMinor)}${plan.repays.length === 1 ? "" : " in all"}`;

const LABEL_MAX = 80;
export const repaidLabel = (plan: RepaidPlan) => {
  const n = plan.repays.length;
  const expenses = `${n} expense${n === 1 ? "" : "s"}`;
  const label = `Mark ${plan.partner.name}'s ${expenses} repaid`;
  return label.length <= LABEL_MAX ? label : `Mark ${expenses} repaid`;
};
export const repaidLine = (plan: RepaidPlan) =>
  fitted(
    plan,
    (keys) =>
      `Mark ${keys} (${total(plan)}) repaid on ${shortDay(plan.day)} by ${plan.key}; ${owedAfter(plan)}`,
    200,
  );

/**
 * The tap's writes, as `writer`: each expense marked repaid on the debit's day, the debit
 * explained, each linked to the other. Anything changed since the draw writes nothing, and the
 * fact is told again on the next pass if it still holds.
 */
export const markRepaid = Effect.fn("KinRepaidCard.mark")(function* (
  orgId: KinOrgId,
  plan: RepaidPlan,
  writer: Writer,
  records: KinRecords["Service"],
) {
  const def = yield* findBankList(orgId);
  if (def === undefined || !asDrawn(yield* repaidMatch(orgId, plan.recordId), plan)) {
    yield* retell(orgId, repaidFactKey(plan.key));
    return undefined;
  }
  for (const one of plan.repays)
    yield* records.update(
      orgId,
      writer,
      one.key,
      { fields: { [REIMBURSEMENT]: "repaid", [REPAID_ON]: plan.day } },
      one.rev,
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
  for (const one of plan.repays) {
    yield* records.link(orgId, writer, one.recordId, {
      kind: "record",
      target: plan.recordId,
      relation: "evidence",
      label: `${plan.day} · ${plan.key}`,
    });
    yield* records.link(orgId, writer, plan.recordId, {
      kind: "record",
      target: one.recordId,
      relation: "relates",
      label: one.key,
    });
  }
  const rest = owedAfter(plan);
  return {
    title: "Marked repaid",
    text: fitted(
      plan,
      (keys) =>
        `${keys} ${plan.repays.length === 1 ? "is" : "are"} repaid on ${shortDay(plan.day)} by ${plan.key}, which is explained in Bank transactions. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}.`,
      600,
    ),
  } satisfies KinChoiceOutcome;
});

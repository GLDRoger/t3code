import {
  KIN_CHOICE_UNDO_ACTION,
  KinChatError,
  type KinChoiceOutcome,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { retell } from "../../pulse/KinPulse.ts";
import type { CardDraw, RepaidPlan, RepaidUndoPlan } from "../../widgets/cardPlans.ts";
import type { KinRecords, Writer } from "../KinRecords.ts";
import { fieldText, parseFields } from "../lists.ts";
import { formatMoney } from "../money.ts";
import { endOfDay, ownerZone } from "../recordRows.ts";
import { REIMBURSEMENT, REPAID_ON } from "../reimbursement.ts";
import { bankStates, findBankList } from "./bankList.ts";
import { shortDay } from "./bankKnown.ts";
import { keyRow } from "./creditPayment.ts";
import { MARKED_REPAID, type RepaidMatch, repaidMatch } from "./debitRepaid.ts";
import { stateLabel } from "../registers.ts";
import { agentWrote } from "./invoiceCredits.ts";

/**
 * A `kin_ask` option that marks a partner's owed expenses repaid by a Bank transactions debit:
 * drawn only when Kin's matcher reads the debit as paying back exactly a run of the oldest owed
 * expenses of the one partner it names, run only by an owner-level tap while the debit and every
 * expense are as drawn. Whole expenses only; who paid each is never changed.
 */

const refuse = (message: string) => new KinChatError({ reason: "invalid_state", message });
const NOTHING_ASKED = "Nothing was asked; tell the owner what you see instead.";
const repaidFactKey = (bankKey: string) => `repaid_seen:${bankKey}`;

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
  const match = yield* repaidMatch(orgId, bank.recordId, yield* Clock.currentTimeMillis);
  if (match === undefined)
    return yield* refuse(
      `${bank.key} isn't an unexplained debit that names one partner the company owes, so Kin offers no card for it. ${NOTHING_ASKED}`,
    );
  if (match.setBack)
    return yield* refuse(
      `A person set ${bank.key} back to ${stateLabel(def, bankStates(def).open)} after a card marked it repaid, so Kin offers no card for it.`,
    );
  if (match.ahead)
    return yield* refuse(`${bank.key} is dated after today, so Kin offers no card for it.`);
  if (match.marked !== undefined)
    return yield* refuse(
      `${bank.key} may be the repayment already marked by hand for ${match.partner.name} on ${match.marked}, so Kin offers no card for it. ${NOTHING_ASKED}`,
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
    narration: match.debit.title,
    partner: match.partner,
    repays: repays.map((one) => ({ ...one })),
    owedAfterMinor: Number(match.owedMinor - BigInt(match.debit.amountMinor)),
    ...(match.expense === undefined ? {} : { expense: match.expense }),
    draw,
  }) satisfies RepaidPlan;

/** The same debit, partner, expenses and what stays owed as drawn: anything else marks nothing. */
const asDrawn = (match: RepaidMatch | undefined, plan: RepaidPlan) => {
  if (match === undefined || match.setBack || match.ahead || match.marked !== undefined)
    return false;
  if (match.repays === undefined) return false;
  const now = planOf(match, match.repays, plan.draw);
  return (
    now.recordId === plan.recordId &&
    now.key === plan.key &&
    now.rev === plan.rev &&
    now.amountMinor === plan.amountMinor &&
    now.currency === plan.currency &&
    now.day === plan.day &&
    now.narration === plan.narration &&
    now.partner.id === plan.partner.id &&
    now.partner.name === plan.partner.name &&
    now.owedAfterMinor === plan.owedAfterMinor &&
    now.expense?.recordId === plan.expense?.recordId &&
    now.expense?.rev === plan.expense?.rev &&
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
const fitted = (plan: RepaidPlan, build: (keys: string) => string, max: number) =>
  fittedKeys(
    plan.repays.map((one) => one.key),
    build,
    max,
  );
const fittedKeys = (keys: ReadonlyArray<string>, build: (keys: string) => string, max: number) => {
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
  if (plan.asExpense && plan.expense !== undefined) return `It paid ${plan.expense.key}`;
  const n = plan.repays.length;
  const expenses = `${n} expense${n === 1 ? "" : "s"}`;
  const label = `Mark ${plan.partner.name}'s ${expenses} repaid`;
  return label.length <= LABEL_MAX ? label : `Mark ${expenses} repaid`;
};
const NARRATION_MAX = 60;
/** The bank's words, flattened, cut at a whole word: a quotation, never an instruction. */
const narrationOf = (plan: RepaidPlan) => {
  const flat = plan.narration.replace(/\s+/g, " ").replaceAll('"', "'").trim();
  if (flat.length <= NARRATION_MAX) return flat;
  const cut = flat.slice(0, NARRATION_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
};
const LINE_MAX = 200;
export const repaidLine = (plan: RepaidPlan) => {
  if (plan.asExpense && plan.expense !== undefined) {
    const expense = plan.expense;
    return `Explain ${plan.key} in Bank transactions as paying ${expense.key}${expense.open ? `, and mark ${expense.key} paid` : ""}`;
  }
  const line = (quoted: boolean) =>
    fitted(
      plan,
      (keys) =>
        `Mark ${keys} (${total(plan)}) repaid on ${shortDay(plan.day)} by ${plan.key}${
          quoted && narrationOf(plan) !== "" ? ` "${narrationOf(plan)}"` : ""
        }; ${owedAfter(plan)}`,
      LINE_MAX,
    );
  const text = [line(true), line(false)].find((one) => one.length <= LINE_MAX) ?? line(false);
  return text.length <= LINE_MAX ? text : `${text.slice(0, LINE_MAX - 1)}…`;
};

/**
 * The tap's writes, as `writer`: each expense marked repaid on the debit's day, the debit
 * explained, each linked to the other. Anything changed since the draw writes nothing, and the
 * fact is told again on the next pass if it still holds.
 */
const linkDebit = Effect.fn("KinRepaidCard.linkDebit")(function* (
  orgId: KinOrgId,
  writer: Writer,
  plan: RepaidPlan,
  one: { readonly recordId: string; readonly key: string },
  records: KinRecords["Service"],
) {
  const evidence = yield* records.link(orgId, writer, one.recordId, {
    kind: "record",
    target: plan.recordId,
    relation: "evidence",
    label: `${plan.day} · ${plan.key}`,
  });
  const relates = yield* records.link(orgId, writer, plan.recordId, {
    kind: "record",
    target: one.recordId,
    relation: "relates",
    label: one.key,
  });
  return { evidence, relates };
});

const lastChanges = Effect.fn("KinRepaidCard.lastChanges")(function* (
  orgId: KinOrgId,
  ids: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ recordId: string; change: number }>`SELECT
    record_id AS "recordId", MAX(seq) AS change FROM kin_record_changes
    WHERE org_id = ${orgId} AND record_id IN ${sql.in(ids)} GROUP BY record_id`;
  return new Map(rows.map(({ recordId, change }) => [recordId, change]));
});

type RepaidWriter = Writer & { actor: { _tag: "person"; personId: KinPersonId } };

export const markRepaid = Effect.fn("KinRepaidCard.mark")(function* (
  orgId: KinOrgId,
  plan: RepaidPlan,
  writer: RepaidWriter,
  records: KinRecords["Service"],
) {
  const def = yield* findBankList(orgId);
  const bank = yield* records.get(orgId, plan.key);
  if (
    def === undefined ||
    bank === undefined ||
    !asDrawn(yield* repaidMatch(orgId, plan.recordId, yield* Clock.currentTimeMillis), plan)
  ) {
    yield* retell(orgId, repaidFactKey(plan.key));
    return undefined;
  }
  const explain = records.update(
    orgId,
    writer,
    plan.key,
    {
      state: bankStates(def).explained,
      ...(def.categories.includes("expense") ? { category: "expense" } : {}),
    },
    plan.rev,
  );
  if (plan.asExpense && plan.expense !== undefined) {
    const expense = plan.expense;
    if (expense.open)
      yield* records.update(
        orgId,
        writer,
        expense.key,
        {
          state: "done",
          ...(expense.day === null
            ? { dateAt: endOfDay(plan.day, yield* ownerZone(orgId)), dateAllDay: true }
            : {}),
        },
        expense.rev,
      );
    yield* explain;
    yield* linkDebit(orgId, writer, plan, expense, records);
    return {
      outcome: {
        title: "Explained",
        text: `${plan.key} is explained in Bank transactions as paying ${expense.key}${expense.open ? `, and ${expense.key} is marked paid` : ""}.`,
      },
    };
  }
  const expenses = yield* Effect.forEach(plan.repays, (one) =>
    Effect.gen(function* () {
      const before = yield* records.get(orgId, one.key);
      if (before === undefined) return yield* refuse(`${one.key} is no longer there.`);
      const fields = parseFields(before.fieldsJson);
      const marked = yield* records.update(
        orgId,
        writer,
        one.key,
        { fields: { [REIMBURSEMENT]: "repaid", [REPAID_ON]: plan.day } },
        one.rev,
      );
      return {
        recordId: one.recordId,
        key: one.key,
        rev: marked.rev,
        reimbursement: fieldText(fields, REIMBURSEMENT),
        repaidOn: fieldText(fields, REPAID_ON),
      };
    }),
  );
  const explained = yield* explain;
  const links = yield* Effect.forEach(expenses, (one) =>
    linkDebit(orgId, writer, plan, one, records),
  );
  const changes = yield* lastChanges(orgId, [
    plan.recordId,
    ...expenses.map((one) => one.recordId),
  ]);
  const rest = owedAfter(plan);
  return {
    outcome: {
      title: MARKED_REPAID,
      text: fitted(
        plan,
        (keys) =>
          `${keys} ${plan.repays.length === 1 ? "is" : "are"} repaid on ${shortDay(plan.day)} by ${plan.key}, which is explained in Bank transactions. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}.`,
        600,
      ),
      undo: {
        actionId: KIN_CHOICE_UNDO_ACTION,
        label: "Undo",
        line: fitted(
          plan,
          (keys) => `Mark ${keys} owed again and put ${plan.key} back as it was`,
          200,
        ),
      },
    } satisfies KinChoiceOutcome,
    undo: {
      kind: "undo_repaid",
      personId: writer.actor.personId,
      bank: {
        recordId: plan.recordId,
        key: plan.key,
        state: bank.state,
        category: bank.category,
        rev: explained.rev,
        change: changes.get(plan.recordId) ?? 0,
      },
      expenses: expenses.map((one, i) => ({
        ...one,
        ...links[i]!,
        change: changes.get(one.recordId) ?? 0,
      })),
    } satisfies RepaidUndoPlan,
  };
});

const changedSince = (key: string) =>
  refuse(`Nothing was undone. ${key} changed since the repayment was marked.`);

export const undoRepaid = Effect.fn("KinRepaidCard.undo")(function* (
  orgId: KinOrgId,
  plan: RepaidUndoPlan,
  writer: RepaidWriter,
  records: KinRecords["Service"],
) {
  const sql = yield* SqlClient.SqlClient;
  const entries = [plan.bank, ...plan.expenses];
  const changes = yield* lastChanges(
    orgId,
    entries.map((one) => one.recordId),
  );
  for (const saved of entries) {
    const now = yield* records.get(orgId, saved.key);
    if (now === undefined || now.recordId !== saved.recordId || now.state === "dropped")
      return yield* refuse(`Nothing was undone. ${saved.key} is no longer there.`);
    if (now.rev === saved.rev && (changes.get(saved.recordId) ?? 0) === saved.change) continue;
    if (
      saved !== plan.bank &&
      (yield* sql`SELECT 1 FROM kin_record_changes c, json_each(c.fields_json) f
      WHERE c.org_id = ${orgId} AND c.record_id = ${saved.recordId} AND c.seq > ${saved.change}
        AND json_extract(f.value, '$.field') = ${REIMBURSEMENT}
        AND json_extract(f.value, '$.to') = 'repaid' LIMIT 1`).length > 0
    )
      return yield* refuse(
        `Nothing was undone. ${saved.key} was marked repaid again after this card.`,
      );
    return yield* changedSince(saved.key);
  }
  for (const one of plan.expenses) {
    if (
      one.evidence &&
      !(yield* records.unlink(orgId, writer, one.recordId, {
        kind: "record",
        target: plan.bank.recordId,
      }))
    )
      return yield* changedSince(one.key);
    if (
      one.relates &&
      !(yield* records.unlink(orgId, writer, plan.bank.recordId, {
        kind: "record",
        target: one.recordId,
      }))
    )
      return yield* changedSince(plan.bank.key);
    yield* records.update(
      orgId,
      writer,
      one.key,
      {
        fields: { [REIMBURSEMENT]: one.reimbursement, [REPAID_ON]: one.repaidOn },
      },
      one.rev,
    );
  }
  const bank = plan.bank;
  yield* records.update(
    orgId,
    writer,
    bank.key,
    { state: bank.state, category: bank.category },
    bank.rev,
  );
  // Mark and Undo can both land between pulse ticks, without the fact ever clearing.
  yield* retell(orgId, repaidFactKey(bank.key));
  return {
    title: "Repayment undone",
    text: fittedKeys(
      plan.expenses.map((one) => one.key),
      (keys) =>
        `${keys} ${plan.expenses.length === 1 ? "is" : "are"} owed again, and ${bank.key} is back as it was in Bank transactions.`,
      600,
    ),
  } satisfies KinChoiceOutcome;
});

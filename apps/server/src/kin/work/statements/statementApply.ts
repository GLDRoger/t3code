import {
  KinChatError,
  KinChatId,
  type KinOrgId,
  type KinPersonId,
  type KinRecordState,
  type KinStatementApplyInput,
  type KinStatementReviewCard,
  type KinStatementRowsInput,
  type KinStatementSelectInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRecords, type Writer } from "../KinRecords.ts";
import type { RecordRow } from "../recordRows.ts";
import { type FieldValue, parseFields } from "../lists.ts";
import { endOfDay, ownerZone } from "../recordRows.ts";
import { defineList, listDef, PRESETS } from "../registers.ts";
import {
  accountLabel,
  bankStates,
  ensureBankList,
  originKeyOf,
  rowFields,
  rowFingerprints,
  rowTitle,
} from "./bankList.ts";
import { changeSelection, decisionsOf, reviewCard, rowsOf } from "./statementCard.ts";
import {
  cardState,
  encodeSelection,
  expenseCategories,
  heldRows,
  reviewOf,
  selectionOf,
  statementRow,
  updateCard,
} from "./statementReview.ts";
import type { StatementRow } from "./statementTable.ts";

/**
 * The owner's confirm on a review card, applied by Kin: exactly the set the card showed, once.
 * Payments go through the same path as Record payment, expenses through the entry writes every
 * change takes, each with its bank row linked. Undo takes back what one statement applied, row by
 * row; a row it can't take back keeps its entries, and no confirm records that row again.
 */

const isChatError = Schema.is(KinChatError);
// Builds from before selections were kept send no revision; they can't confirm what they show.
const outdated = new KinChatError({
  reason: "invalid_state",
  message: "Update the app to confirm this statement.",
});
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const changed = new KinChatError({
  reason: "conflict",
  message:
    "Something changed since this card was made, so nothing was applied. Ask Kin to read the statement again.",
});
const Prior = Schema.Struct({
  bank: Schema.Struct({ state: Schema.String, category: Schema.NullOr(Schema.String) }),
  expense: Schema.optional(
    Schema.Struct({
      state: Schema.String,
      dateAt: Schema.NullOr(Schema.Number),
      dateAllDay: Schema.Boolean,
      paidWith: Schema.NullOr(Schema.String),
    }),
  ),
});
const PriorJson = Schema.fromJsonString(Prior);
const encodePrior = Schema.encodeEffect(PriorJson);
const decodePrior = Schema.decodeUnknownOption(PriorJson);
/** What a person may change on an entry after Kin applied it; undo leaves an entry so changed. */
const Snapshot = Schema.Struct({
  state: Schema.String,
  dateAt: Schema.NullOr(Schema.Number),
  amountMinor: Schema.NullOr(Schema.Number),
  paidWith: Schema.NullOr(Schema.String),
  notes: Schema.String,
  category: Schema.NullOr(Schema.String),
});
const After = Schema.Struct({ bank: Snapshot, target: Schema.optional(Snapshot) });
const AfterJson = Schema.fromJsonString(After);
const encodeAfter = Schema.encodeEffect(AfterJson);
const decodeAfter = Schema.decodeUnknownOption(AfterJson);
const snapshot = (row: RecordRow): typeof Snapshot.Type => {
  const paid = parseFields(row.fieldsJson).paidWith;
  return {
    state: row.state,
    dateAt: row.dateAt,
    amountMinor: row.amountMinor,
    paidWith: typeof paid === "string" ? paid : null,
    notes: row.notes,
    category: row.category,
  };
};
/** Whether an entry is as Kin left it; one from before snapshots were kept counts as unchanged. */
const asLeft = (row: RecordRow, kept: typeof Snapshot.Type | undefined) =>
  kept === undefined || JSON.stringify(snapshot(row)) === JSON.stringify(kept);

/** The stored review, read for the owner on the card they act on. */
const ownersReview = Effect.fn("KinStatements.ownersReview")(function* (
  input: { readonly orgId: KinOrgId; readonly statementId: string; readonly hash: string },
  personId: KinPersonId,
  what: string,
) {
  const stored = yield* statementRow(input.orgId, input.statementId);
  if (stored === undefined)
    return yield* new KinChatError({ reason: "not_found", message: "No such statement." });
  if ((yield* ownerOf(input.orgId, stored.agentId)) !== personId)
    return yield* new KinChatError({ reason: "not_allowed", message: `Only the owner ${what}.` });
  const review = stored.reviewJson === null ? undefined : reviewOf(stored.reviewJson);
  if (stored.status !== "read" || review === undefined || stored.reviewHash !== input.hash)
    return yield* changed;
  return { stored, review };
});

type Action =
  | "payment"
  | "tds"
  | "expense_paid"
  | "expense_linked"
  | "expense_new"
  | "transfer"
  | "ignore";

const ownerOf = Effect.fn("KinStatements.applyOwner")(function* (orgId: KinOrgId, agentId: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    personId: string;
  }>`SELECT owner_person_id AS "personId" FROM kin_agents
    WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
  return row?.personId;
});

/** How a debit was paid, in the Expenses list's own choice. */
const paidWith = (choices: ReadonlyArray<string> | undefined, kind: "account" | "card") =>
  choices?.find((one) => one.toLowerCase() === (kind === "card" ? "card" : "bank"));

export const applyStatement = Effect.fn("KinStatements.apply")(function* (
  input: KinStatementApplyInput & { readonly personId: KinPersonId; readonly now: number },
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const { stored, review } = yield* ownersReview(input, input.personId, "confirms a statement");
      if (stored.appliedAt !== null)
        return yield* new KinChatError({
          reason: "widget_changed",
          message: "This statement was already applied.",
        });
      if (input.revision === undefined) return yield* outdated;
      const selection = selectionOf(stored, review);
      if (selection.revision !== input.revision)
        return yield* new KinChatError({
          reason: "conflict",
          message:
            "The card changed since you looked at it, so nothing was applied. Check it and confirm again.",
        });
      const { statement } = review;
      const currency = statement.currency;
      const zone = yield* ownerZone(input.orgId);
      const categories = yield* expenseCategories(input.orgId);
      const held = yield* heldRows(input.orgId, input.statementId);
      const decisions = decisionsOf(review, selection, held);
      // One entry answers one row: two rows naming one entry is refused before anything is written.
      const claimed = new Map<string, number>();
      for (const decision of decisions) {
        if (decision.option === undefined) continue;
        const candidate = review.matches.get(decision.row)?.candidates[decision.option];
        if (candidate === undefined) return yield* changed;
        const first = claimed.get(candidate.recordId);
        if (first !== undefined)
          return yield* invalid(
            `${candidate.key} is matched to two rows (${statement.rows[first]!.date} and ${statement.rows[decision.row]!.date}); one entry answers one row. Pick another for one of them. Nothing was applied.`,
          );
        claimed.set(candidate.recordId, decision.row);
      }

      const writer: Writer = {
        actor: { _tag: "person", personId: input.personId },
        via: "owner",
        chatId: KinChatId.make(stored.chatId),
        askedBy: input.personId,
      };
      const def = yield* ensureBankList(input.orgId, input.now);
      const states = bankStates(def);
      if (
        decisions.some((one) => one.action?.action === "expense") &&
        (yield* listDef(input.orgId, "expenses")) === undefined
      )
        yield* defineList(
          input.orgId,
          { _tag: "new", id: "expenses", ...PRESETS.expenses, definition: PRESETS.expenses },
          input.now,
        );
      const expenses = yield* listDef(input.orgId, "expenses");
      const paidWithChoice = paidWith(
        expenses?.fields.find((one) => one.key === "paidWith")?.choices,
        statement.kind,
      );
      const label = accountLabel(statement);
      const fingerprints = rowFingerprints(statement);
      // An undone confirm's payments stay as void lines, so each undo starts a generation of keys.
      const retryKey = (index: number, what: string) =>
        `statement:${input.statementId}:g${stored.generation}:${index}:${what}`;
      // A retry key's payment or entry taken back since means this isn't the confirm it was.
      const live = <A, E, R>(write: Effect.Effect<A, E, R>) =>
        write.pipe(
          Effect.catchIf(
            (error) => isChatError(error) && error.reason === "conflict",
            () => Effect.fail(changed),
          ),
        );
      const livePayment = Effect.fn("KinStatements.livePayment")(function* (paymentId: string) {
        const [payment] = yield* sql<{ voidedAt: number | null }>`SELECT voided_at AS "voidedAt"
          FROM kin_record_payments WHERE org_id = ${input.orgId} AND payment_id = ${paymentId}`;
        if (payment === undefined || payment.voidedAt !== null) return yield* changed;
        return paymentId;
      });

      // Every row is saved, so what is left for later is there to see in Bank transactions.
      const bankRows = new Map<number, { readonly recordId: string; readonly key: string }>();
      for (const row of statement.rows) {
        const known = review.known.get(row.index);
        if (known !== undefined) {
          const still = yield* records.getById(input.orgId, known.recordId);
          if (still === undefined) return yield* changed;
          bankRows.set(row.index, { recordId: still.recordId, key: still.key });
          continue;
        }
        const title = rowTitle(row);
        const { row: made } = yield* live(
          records.create(input.orgId, writer, {
            list: def.id,
            originKey: originKeyOf(fingerprints[row.index]!),
            title,
            owner: { _tag: "person", personId: input.personId },
            state: states.open,
            amount: { minor: row.amountMinor, currency },
            dateAt: endOfDay(row.date, zone),
            dateAllDay: true,
            fields: rowFields(def, statement, row),
            ...(title === row.description ? {} : { notes: row.description }),
            sensitive: true,
            confirmed: true,
          }),
        );
        bankRows.set(row.index, { recordId: made.recordId, key: made.key });
      }

      let seq =
        (yield* sql<{ seq: number | null }>`SELECT MAX(seq) AS seq FROM kin_bank_statement_entries
        WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}`)[0]?.seq ?? 0;
      const entry = Effect.fn("KinStatements.entry")(function* (
        row: StatementRow,
        action: Action,
        target: string | null,
        paymentId: string | null,
        prior: typeof Prior.Type,
      ) {
        seq += 1;
        const bank = yield* records.getById(input.orgId, bankRows.get(row.index)!.recordId);
        const made = target === null ? undefined : yield* records.getById(input.orgId, target);
        const after =
          bank === undefined
            ? null
            : yield* encodeAfter({
                bank: snapshot(bank),
                ...(made === undefined ? {} : { target: snapshot(made) }),
              });
        yield* sql`INSERT INTO kin_bank_statement_entries (org_id, statement_id, seq, row_index,
            bank_record_id, action, target_record_id, payment_id, prior_json, after_json)
          VALUES (${input.orgId}, ${input.statementId}, ${seq}, ${row.index},
            ${bankRows.get(row.index)!.recordId}, ${action}, ${target}, ${paymentId},
            ${yield* encodePrior(prior)}, ${after})`;
      });
      const settleBank = Effect.fn("KinStatements.settleBank")(function* (
        row: StatementRow,
        state: KinRecordState,
        category: string,
      ) {
        const bank = (yield* records.getById(input.orgId, bankRows.get(row.index)!.recordId))!;
        const prior = { state: bank.state, category: bank.category };
        yield* records.update(input.orgId, writer, bank.key, {
          state,
          ...(def.categories.includes(category) ? { category } : {}),
        });
        return prior;
      });
      const linkBoth = Effect.fn("KinStatements.linkBoth")(function* (
        row: StatementRow,
        targetId: string,
        targetKey: string,
      ) {
        const bank = bankRows.get(row.index)!;
        yield* records.link(input.orgId, writer, targetId, {
          kind: "record",
          target: bank.recordId,
          relation: "evidence",
          label: `${label} · ${row.date} · ${bank.key}`,
        });
        yield* records.link(input.orgId, writer, bank.recordId, {
          kind: "record",
          target: targetId,
          relation: "relates",
          label: targetKey,
        });
      });
      const tally = {
        payments: 0,
        tds: 0,
        paid: 0,
        linked: 0,
        created: 0,
        transfers: 0,
        ignored: 0,
      };
      const note = (row: StatementRow) =>
        `${label}, ${row.date}${row.reference === null ? "" : `, ref ${row.reference}`}`.slice(
          0,
          500,
        );

      for (const decision of decisions) {
        const index = decision.row;
        const row = statement.rows[index]!;
        const match = review.matches.get(index)!;
        if (decision.option !== undefined) {
          const candidate = match.candidates[decision.option]!;
          const targetRow = yield* records.getById(input.orgId, candidate.recordId);
          if (targetRow === undefined) return yield* changed;
          if (candidate.kind === "invoice") {
            const received = yield* live(
              records.pay(input.orgId, writer, targetRow.key, {
                amount: { minor: row.amountMinor, currency },
                paidOn: row.date,
                note: note(row),
                originKey: retryKey(index, "received"),
              }),
            );
            const prior = yield* settleBank(row, states.explained, "payment received");
            const paymentId = yield* livePayment(received.paymentId);
            yield* entry(row, "payment", candidate.recordId, paymentId, { bank: prior });
            tally.payments += 1;
            if (candidate.fit === "tds" && candidate.tdsMinor !== undefined) {
              const tds = yield* live(
                records.pay(input.orgId, writer, targetRow.key, {
                  amount: { minor: candidate.tdsMinor, currency },
                  paidOn: row.date,
                  note: `TDS deducted by the client on ${row.date}`,
                  withheld: true,
                  originKey: retryKey(index, "tds"),
                }),
              );
              const tdsId = yield* livePayment(tds.paymentId);
              yield* entry(row, "tds", candidate.recordId, tdsId, { bank: prior });
              tally.tds += 1;
            }
          } else {
            const fields = parseFields(targetRow.fieldsJson);
            const priorExpense = {
              state: targetRow.state,
              dateAt: targetRow.dateAt,
              dateAllDay: targetRow.dateAllDay === 1,
              paidWith: typeof fields.paidWith === "string" ? fields.paidWith : null,
            };
            const open = targetRow.state === "open";
            if (open || (paidWithChoice !== undefined && priorExpense.paidWith === null))
              yield* records.update(input.orgId, writer, targetRow.key, {
                ...(open ? { state: "done" as const } : {}),
                ...(open && targetRow.dateAt === null
                  ? { dateAt: endOfDay(row.date, zone), dateAllDay: true }
                  : {}),
                ...(paidWithChoice === undefined || priorExpense.paidWith !== null
                  ? {}
                  : { fields: { paidWith: paidWithChoice } }),
              });
            const prior = yield* settleBank(row, states.explained, "expense");
            yield* entry(row, open ? "expense_paid" : "expense_linked", candidate.recordId, null, {
              bank: prior,
              expense: priorExpense,
            });
            if (open) tally.paid += 1;
            else tally.linked += 1;
          }
          yield* linkBoth(row, candidate.recordId, targetRow.key);
          continue;
        }
        const action = decision.action;
        if (action === undefined) return yield* changed;
        if (action.action === "expense") {
          if (row.direction !== "debit")
            return yield* invalid("Only money out can be recorded as an expense.");
          const vendor = action.vendor;
          const category =
            action.category !== undefined && categories.includes(action.category)
              ? action.category
              : undefined;
          const fields: Record<string, FieldValue> = {
            ...(vendor === undefined ? {} : { vendor }),
            ...(paidWithChoice === undefined ? {} : { paidWith: paidWithChoice }),
          };
          const { row: made } = yield* live(
            records.create(input.orgId, writer, {
              list: "expenses",
              originKey: retryKey(index, "expense"),
              title: rowTitle({ ...row, description: vendor ?? row.description }),
              owner: { _tag: "person", personId: input.personId },
              state: "done",
              amount: { minor: row.amountMinor, currency },
              dateAt: endOfDay(row.date, zone),
              dateAllDay: true,
              ...(category === undefined ? {} : { category }),
              fields,
              notes: `From ${label}: ${row.description}`.slice(0, 4_000),
              sensitive: true,
              confirmed: true,
            }),
          );
          if (made.state === "dropped") return yield* changed;
          const prior = yield* settleBank(row, states.explained, "expense");
          yield* entry(row, "expense_new", made.recordId, null, { bank: prior });
          yield* linkBoth(row, made.recordId, made.key);
          tally.created += 1;
        } else if (action.action === "transfer") {
          const prior = yield* settleBank(row, states.explained, "transfer");
          yield* entry(row, "transfer", null, null, { bank: prior });
          tally.transfers += 1;
        } else {
          const prior = yield* settleBank(row, states.ignored, "other");
          yield* entry(row, "ignore", null, null, { bank: prior });
          tally.ignored += 1;
        }
      }

      yield* sql`UPDATE kin_bank_statements SET applied_at = ${input.now}, applied_by = ${input.personId},
          undone_at = NULL
        WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}`;
      const kept = [...held.keys()].filter((row) => review.matches.has(row)).length;
      const unexplained = yield* unexplainedCount(
        input.orgId,
        [...bankRows.values()].map((one) => one.recordId),
        states.open,
      );
      const result = [
        ...(tally.payments === 0
          ? []
          : [
              `Recorded ${tally.payments} payment${tally.payments === 1 ? "" : "s"} on invoices${tally.tds === 0 ? "" : `, ${tally.tds} with TDS deducted`}.`,
            ]),
        ...(tally.paid === 0
          ? []
          : [`Marked ${tally.paid} expense${tally.paid === 1 ? "" : "s"} paid from ${label}.`]),
        ...(tally.linked === 0
          ? []
          : [
              `Linked ${tally.linked} paid expense${tally.linked === 1 ? "" : "s"} to their bank rows.`,
            ]),
        ...(tally.created === 0
          ? []
          : [`Added ${tally.created} new expense${tally.created === 1 ? "" : "s"}.`]),
        ...(tally.transfers + tally.ignored === 0
          ? []
          : [
              [
                ...(tally.transfers === 0
                  ? []
                  : [
                      `${tally.transfers} marked as ${tally.transfers === 1 ? "a transfer" : "transfers"}`,
                    ]),
                ...(tally.ignored === 0 ? [] : [`${tally.ignored} ignored`]),
              ].join(", ") + ".",
            ]),
        ...(kept === 0
          ? []
          : [
              `${kept} row${kept === 1 ? " was" : "s were"} already recorded from this statement and left as ${kept === 1 ? "it was" : "they were"}.`,
            ]),
        unexplained === 0
          ? "Every row of this statement is explained."
          : `${unexplained} row${unexplained === 1 ? "" : "s"} left for later in Bank transactions, as Unexplained.`,
      ];
      const card = yield* cardState(input.orgId, stored.reviewWidgetId);
      const next = {
        ...(card ?? reviewCard(input.statementId, review, categories, selection, held)),
        status: "applied" as const,
        result,
        unexplained,
      } satisfies KinStatementReviewCard;
      if (stored.reviewWidgetId !== null)
        yield* updateCard(input.orgId, stored.reviewWidgetId, next, true);
      return { card: next };
    }),
  );
});

const unexplainedCount = Effect.fn("KinStatements.unexplained")(function* (
  orgId: KinOrgId,
  recordIds: ReadonlyArray<string>,
  open: KinRecordState,
) {
  if (recordIds.length === 0) return 0;
  const sql = yield* SqlClient.SqlClient;
  let count = 0;
  for (let at = 0; at < recordIds.length; at += 500) {
    const [row] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records
      WHERE org_id = ${orgId} AND record_id IN ${sql.in(recordIds.slice(at, at + 500))} AND state = ${open}`;
    count += row?.n ?? 0;
  }
  return count;
});

/**
 * Takes back what this statement applied, newest first; its rows stay, Unexplained again. A row
 * whose entry a person changed since, or whose payment has a receipt, is kept whole, all its
 * entries with it, and the card says so; a later undo takes it back once nothing holds it.
 */
export const undoStatement = Effect.fn("KinStatements.undo")(function* (input: {
  readonly orgId: KinOrgId;
  readonly statementId: string;
  readonly personId: KinPersonId;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const stored = yield* statementRow(input.orgId, input.statementId);
      if (stored === undefined)
        return yield* new KinChatError({ reason: "not_found", message: "No such statement." });
      if ((yield* ownerOf(input.orgId, stored.agentId)) !== input.personId)
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "Only the owner undoes a statement.",
        });
      const writer: Writer = {
        actor: { _tag: "person", personId: input.personId },
        via: "owner",
        chatId: KinChatId.make(stored.chatId),
        askedBy: input.personId,
      };
      const entries = yield* sql<{
        seq: number;
        row: number;
        bankRecordId: string;
        action: Action;
        target: string | null;
        paymentId: string | null;
        prior: string | null;
        after: string | null;
      }>`SELECT seq, row_index AS row, bank_record_id AS "bankRecordId", action,
          target_record_id AS target, payment_id AS "paymentId", prior_json AS prior,
          after_json AS after
        FROM kin_bank_statement_entries WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}
        ORDER BY seq DESC`;
      if (stored.appliedAt === null && entries.length === 0)
        return yield* invalid("Nothing from this statement is applied.");
      const paymentIds = entries.flatMap((one) => (one.paymentId === null ? [] : [one.paymentId]));
      const receipts: Array<{ payment: string; key: string; number: string | null }> = [];
      for (let at = 0; at < paymentIds.length; at += 500)
        receipts.push(
          ...(yield* sql<{ payment: string; key: string; number: string | null }>`
            SELECT json_extract(r.fields_json, '$.payment') AS payment, r.key, n.number
            FROM kin_records r
            LEFT JOIN kin_issued_numbers n ON n.org_id = r.org_id AND n.record_id = r.record_id
            WHERE r.org_id = ${input.orgId} AND r.register_id = 'receipts' AND r.state <> 'dropped'
              AND json_extract(r.fields_json, '$.payment') IN ${sql.in(paymentIds.slice(at, at + 500))}
            ORDER BY r.key`),
        );
      const receiptOf = (paymentId: string | null) =>
        receipts.find((one) => one.payment === paymentId);
      const targets = new Map<string, RecordRow | undefined>();
      for (const id of new Set(entries.flatMap((one) => (one.target === null ? [] : [one.target]))))
        targets.set(id, yield* records.getById(input.orgId, id));

      // Which rows stay whole, and why: a receipt on its payment, or an entry a person changed.
      const receipted = new Map<number, string>();
      const changed = new Map<number, string>();
      for (const entry of entries) {
        const target = entry.target === null ? undefined : targets.get(entry.target);
        if (target === undefined) continue;
        const receipt =
          entry.action === "payment" || entry.action === "tds"
            ? receiptOf(entry.paymentId)
            : undefined;
        if (receipt !== undefined)
          receipted.set(
            entry.row,
            `The payment on ${target.key} stays: receipt ${receipt.number ?? receipt.key} was issued for it. Void that receipt, then undo again to take it back.`,
          );
        else if (entry.action.startsWith("expense")) {
          const after =
            entry.after === null ? undefined : Option.getOrUndefined(decodeAfter(entry.after));
          if (!asLeft(target, after?.target)) changed.set(entry.row, target.key);
        }
      }
      const keptRows = new Set([...receipted.keys(), ...changed.keys()]);

      const tally = { payments: 0, expenses: 0, others: 0 };
      const reversed: Array<number> = [];
      for (const entry of entries) {
        if (keptRows.has(entry.row)) continue;
        reversed.push(entry.seq);
        const prior =
          entry.prior === null ? undefined : Option.getOrUndefined(decodePrior(entry.prior));
        const target = entry.target === null ? undefined : targets.get(entry.target);
        if ((entry.action === "payment" || entry.action === "tds") && entry.paymentId !== null) {
          if (target !== undefined)
            yield* records.voidPayment(input.orgId, writer, target.key, entry.paymentId);
          if (entry.action === "payment") tally.payments += 1;
        } else if (entry.action.startsWith("expense")) {
          if (target !== undefined) {
            if (entry.action === "expense_paid" && prior?.expense !== undefined)
              yield* records.update(input.orgId, writer, target.key, {
                state: prior.expense.state as KinRecordState,
                dateAt: prior.expense.dateAt,
                dateAllDay: prior.expense.dateAllDay,
                fields: { paidWith: prior.expense.paidWith },
              });
            else if (entry.action === "expense_linked" && prior?.expense?.paidWith === null)
              yield* records.update(input.orgId, writer, target.key, {
                fields: { paidWith: null },
              });
            else if (entry.action === "expense_new" && target.state !== "dropped")
              yield* records.update(input.orgId, writer, target.key, { state: "dropped" });
          }
          tally.expenses += 1;
        } else tally.others += 1;
        if (entry.target !== null)
          yield* sql`DELETE FROM kin_record_links WHERE org_id = ${input.orgId} AND kind = 'record'
            AND ((record_id = ${entry.target} AND target = ${entry.bankRecordId})
              OR (record_id = ${entry.bankRecordId} AND target = ${entry.target}))`;
      }
      // Each bank row back to its state before this statement, unless it was changed since.
      const left: Array<string> = [];
      const back = entries.filter((one) => !keptRows.has(one.row));
      for (const bankRecordId of new Set(back.map((one) => one.bankRecordId))) {
        const mine = back.filter((one) => one.bankRecordId === bankRecordId);
        const first = Option.getOrUndefined(decodePrior(mine.at(-1)?.prior ?? ""));
        const latest = Option.getOrUndefined(decodeAfter(mine[0]?.after ?? ""));
        const bank = yield* records.getById(input.orgId, bankRecordId);
        if (bank === undefined || first === undefined) continue;
        if (!asLeft(bank, latest?.bank)) {
          left.push(bank.key);
          continue;
        }
        yield* records.update(input.orgId, writer, bank.key, {
          state: first.bank.state as KinRecordState,
          category: first.bank.category,
        });
      }
      // Only what was taken back stops being recorded: a kept row's entries stay for a later undo.
      for (let at = 0; at < reversed.length; at += 500)
        yield* sql`DELETE FROM kin_bank_statement_entries WHERE org_id = ${input.orgId}
          AND statement_id = ${input.statementId} AND seq IN ${sql.in(reversed.slice(at, at + 500))}`;
      yield* sql`UPDATE kin_bank_statements SET applied_at = NULL, applied_by = NULL,
          undone_at = ${input.now}, generation = generation + 1
        WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}`;
      const review = stored.reviewJson === null ? undefined : reviewOf(stored.reviewJson);
      const categories = yield* expenseCategories(input.orgId);
      const held = yield* heldRows(input.orgId, input.statementId);
      const card =
        review === undefined
          ? yield* cardState(input.orgId, stored.reviewWidgetId)
          : reviewCard(input.statementId, review, categories, selectionOf(stored, review), held);
      if (card === undefined) return yield* invalid("This statement can no longer be read.");
      const { result: _result, unexplained: _unexplained, ...rest } = card;
      const rows = new Set(back.map((one) => one.row)).size;
      const plural = (count: number, one: string, many = `${one}s`) =>
        `${count} ${count === 1 ? one : many}`;
      const what = [
        ...(tally.payments === 0 ? [] : [plural(tally.payments, "payment")]),
        ...(tally.expenses === 0 ? [] : [plural(tally.expenses, "expense")]),
        ...(tally.others === 0
          ? []
          : [plural(tally.others, "transfer or ignored row", "transfers or ignored rows")]),
      ];
      const shown = [...new Set([...changed.values(), ...left])];
      const next = {
        ...rest,
        status: "undone" as const,
        result: [
          rows === 0 && keptRows.size === 0
            ? "Undone: it had made no changes. Confirm again to apply it."
            : rows === 0
              ? "Nothing was taken back."
              : `Undone: ${plural(rows, "row")} taken back (${what.join(", ")}).`,
          ...(keptRows.size === 0
            ? []
            : [
                `${plural(keptRows.size, "row")} stay${keptRows.size === 1 ? "s" : ""} recorded and show${keptRows.size === 1 ? "s" : ""} as Already recorded; Confirm won't record ${keptRows.size === 1 ? "it" : "them"} again.`,
              ]),
          ...(shown.length === 0
            ? []
            : [
                `${shown.length} left as you changed ${shown.length === 1 ? "it" : "them"}: ${shown.slice(0, 8).join(", ")}${shown.length > 8 ? ", …" : ""}.`,
              ]),
          ...[...receipted.values()].slice(0, 5),
          ...(rows === 0 ? [] : ["Confirm again to apply the rows taken back."]),
        ].map((line) => line.slice(0, 300)),
      } satisfies KinStatementReviewCard;
      if (stored.reviewWidgetId !== null)
        yield* updateCard(input.orgId, stored.reviewWidgetId, next, false, [input.personId]);
      return { card: next };
    }),
  );
});

/** One change to the owner's selection on a review card, kept on the server for that review. */
export const selectRows = Effect.fn("KinStatements.select")(function* (
  input: KinStatementSelectInput & { readonly personId: KinPersonId },
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const { stored, review } = yield* ownersReview(input, input.personId, "changes this card");
      if (stored.appliedAt !== null)
        return yield* new KinChatError({
          reason: "widget_changed",
          message: "This statement was already applied.",
        });
      const held = yield* heldRows(input.orgId, input.statementId);
      const next = changeSelection(review, selectionOf(stored, review), input.change, held);
      if (typeof next === "string") return yield* invalid(next);
      yield* sql`UPDATE kin_bank_statements SET selection_json = ${yield* encodeSelection(next)}
        WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}`;
      const fresh = reviewCard(
        input.statementId,
        review,
        yield* expenseCategories(input.orgId),
        next,
        held,
      );
      const shown = yield* cardState(input.orgId, stored.reviewWidgetId);
      // An undone card keeps what undo said until it is confirmed again.
      const card = {
        ...fresh,
        ...(shown?.status === "undone" ? { status: "undone" as const } : {}),
        ...(shown?.result === undefined || shown.status !== "undone"
          ? {}
          : { result: shown.result }),
      } satisfies KinStatementReviewCard;
      if (stored.reviewWidgetId !== null)
        yield* updateCard(input.orgId, stored.reviewWidgetId, card, false);
      return { card };
    }),
  );
});

/** More of one section's rows than its card carries, for the owner. */
export const statementRows = Effect.fn("KinStatements.rows")(function* (
  input: KinStatementRowsInput & { readonly personId: KinPersonId },
) {
  const { review } = yield* ownersReview(input, input.personId, "reads this card");
  return rowsOf(
    review,
    input.section,
    input.offset,
    input.limit,
    yield* heldRows(input.orgId, input.statementId),
  );
});

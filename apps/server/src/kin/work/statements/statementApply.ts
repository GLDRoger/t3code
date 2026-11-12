import {
  KinChatError,
  KinChatId,
  type KinOrgId,
  type KinPersonId,
  type KinRecordState,
  type KinStatementApplyInput,
  KinStatementReviewCard,
  KinWidgetId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatRepository } from "../../chat/KinChatRepository.ts";
import { KinRecords, type Writer } from "../KinRecords.ts";
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
import {
  reviewCard,
  reviewOf,
  statementRow,
  updateCard,
  expenseCategories,
} from "./statementReview.ts";
import type { StatementRow } from "./statementTable.ts";

/**
 * The owner's confirm on a review card, applied by Kin: exactly the set the card showed, once.
 * Payments go through the same path as Record payment, expenses through the entry writes every
 * change takes, each with its bank row linked. Undo takes back everything one statement applied.
 */

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
      const stored = yield* statementRow(input.orgId, input.statementId);
      if (stored === undefined)
        return yield* new KinChatError({ reason: "not_found", message: "No such statement." });
      if ((yield* ownerOf(input.orgId, stored.agentId)) !== input.personId)
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "Only the owner confirms a statement.",
        });
      if (stored.appliedAt !== null)
        return yield* new KinChatError({
          reason: "widget_changed",
          message: "This statement was already applied.",
        });
      const review = stored.reviewJson === null ? undefined : reviewOf(stored.reviewJson);
      if (stored.status !== "read" || review === undefined || stored.reviewHash !== input.hash)
        return yield* changed;
      const { statement } = review;
      const currency = statement.currency;
      const zone = yield* ownerZone(input.orgId);
      const categories = yield* expenseCategories(input.orgId);

      // The decisions, each checked against the card's own rows and candidates.
      const decisions = new Map<
        number,
        { readonly option?: number; readonly action?: (typeof input.actions)[number] }
      >();
      const decide = (
        row: number,
        decision: { readonly option?: number; readonly action?: (typeof input.actions)[number] },
      ) => {
        if (decisions.has(row)) return false;
        decisions.set(row, decision);
        return true;
      };
      for (const row of input.matched)
        if (review.matches.get(row)?.group !== "matched" || !decide(row, { option: 0 }))
          return yield* changed;
      for (const one of input.chosen) {
        const match = review.matches.get(one.row);
        if (
          match?.group !== "choose" ||
          match.candidates[one.option] === undefined ||
          !decide(one.row, { option: one.option })
        )
          return yield* changed;
      }
      for (const one of input.actions) {
        const match = review.matches.get(one.row);
        const row = statement.rows[one.row];
        if (
          match === undefined ||
          match.group === "matched" ||
          row === undefined ||
          !decide(one.row, { action: one })
        )
          return yield* changed;
        if (one.action === "expense" && row.direction !== "debit")
          return yield* invalid("Only money out can be recorded as an expense.");
        if (one.category !== undefined && !categories.includes(one.category))
          return yield* invalid(`Expenses' categories are ${categories.join(", ")}.`);
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
        input.actions.some((one) => one.action === "expense") &&
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
      // An undone confirm's payments stay as void lines, so a later confirm needs its own keys.
      const retryKey = (index: number, what: string) =>
        `statement:${input.statementId}:${stored.undoneAt ?? 0}:${index}:${what}`;

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
        const { row: made } = yield* records.create(input.orgId, writer, {
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
        });
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
        yield* sql`INSERT INTO kin_bank_statement_entries (org_id, statement_id, seq, row_index,
            bank_record_id, action, target_record_id, payment_id, prior_json)
          VALUES (${input.orgId}, ${input.statementId}, ${seq}, ${row.index},
            ${bankRows.get(row.index)!.recordId}, ${action}, ${target}, ${paymentId},
            ${yield* encodePrior(prior)})`;
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

      for (const [index, decision] of [...decisions.entries()].toSorted(
        ([left], [right]) => left - right,
      )) {
        const row = statement.rows[index]!;
        const match = review.matches.get(index)!;
        if (decision.option !== undefined) {
          const candidate = match.candidates[decision.option]!;
          const targetRow = yield* records.getById(input.orgId, candidate.recordId);
          if (targetRow === undefined) return yield* changed;
          if (candidate.kind === "invoice") {
            const received = yield* records.pay(input.orgId, writer, targetRow.key, {
              amount: { minor: row.amountMinor, currency },
              paidOn: row.date,
              note: note(row),
              originKey: retryKey(index, "received"),
            });
            const prior = yield* settleBank(row, states.explained, "payment received");
            yield* entry(row, "payment", candidate.recordId, received.paymentId, { bank: prior });
            tally.payments += 1;
            if (candidate.fit === "tds" && candidate.tdsMinor !== undefined) {
              const tds = yield* records.pay(input.orgId, writer, targetRow.key, {
                amount: { minor: candidate.tdsMinor, currency },
                paidOn: row.date,
                note: `TDS deducted by the client on ${row.date}`,
                originKey: retryKey(index, "tds"),
              });
              yield* entry(row, "tds", candidate.recordId, tds.paymentId, { bank: prior });
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
        const action = decision.action!;
        if (action.action === "expense") {
          const suggestion = match.suggestion;
          const vendor = action.vendor ?? suggestion.vendor;
          const category =
            action.category ??
            (suggestion.category !== undefined && categories.includes(suggestion.category)
              ? suggestion.category
              : undefined);
          const fields: Record<string, FieldValue> = {
            ...(vendor === undefined ? {} : { vendor }),
            ...(paidWithChoice === undefined ? {} : { paidWith: paidWithChoice }),
          };
          const { row: made } = yield* records.create(input.orgId, writer, {
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
          });
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
        unexplained === 0
          ? "Every row of this statement is explained."
          : `${unexplained} row${unexplained === 1 ? "" : "s"} left for later in Bank transactions, as Unexplained.`,
      ];
      const card = yield* cardState(input.orgId, stored.reviewWidgetId);
      const next = {
        ...(card ?? reviewCard(input.statementId, review, categories)),
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

const decodeCard = Schema.decodeUnknownOption(KinStatementReviewCard);
const cardState = Effect.fn("KinStatements.cardState")(function* (
  orgId: KinOrgId,
  widgetId: string | null,
) {
  if (widgetId === null) return undefined;
  const repo = yield* KinChatRepository;
  const found = yield* repo.getWidget({ orgId, widgetId: KinWidgetId.make(widgetId) });
  if (Option.isNone(found)) return undefined;
  return Option.getOrUndefined(decodeCard(found.value.state));
});

/** Takes back everything this statement applied, newest first; its rows stay, Unexplained again. */
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
      if (stored.appliedAt === null)
        return yield* invalid("Nothing from this statement is applied.");
      const writer: Writer = {
        actor: { _tag: "person", personId: input.personId },
        via: "owner",
        chatId: KinChatId.make(stored.chatId),
        askedBy: input.personId,
      };
      const entries = yield* sql<{
        seq: number;
        bankRecordId: string;
        action: Action;
        target: string | null;
        paymentId: string | null;
        prior: string | null;
      }>`SELECT seq, bank_record_id AS "bankRecordId", action, target_record_id AS target,
          payment_id AS "paymentId", prior_json AS prior
        FROM kin_bank_statement_entries WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}
        ORDER BY seq DESC`;
      const restored = new Set<string>();
      for (const entry of entries) {
        const prior =
          entry.prior === null ? undefined : Option.getOrUndefined(decodePrior(entry.prior));
        const target =
          entry.target === null ? undefined : yield* records.getById(input.orgId, entry.target);
        if (
          (entry.action === "payment" || entry.action === "tds") &&
          target !== undefined &&
          entry.paymentId !== null
        )
          yield* records.voidPayment(input.orgId, writer, target.key, entry.paymentId);
        if (entry.action === "expense_paid" && target !== undefined && prior?.expense !== undefined)
          yield* records.update(input.orgId, writer, target.key, {
            state: prior.expense.state as KinRecordState,
            dateAt: prior.expense.dateAt,
            dateAllDay: prior.expense.dateAllDay,
            fields: { paidWith: prior.expense.paidWith },
          });
        if (
          entry.action === "expense_linked" &&
          target !== undefined &&
          prior?.expense?.paidWith === null
        )
          yield* records.update(input.orgId, writer, target.key, { fields: { paidWith: null } });
        if (entry.action === "expense_new" && target !== undefined && target.state !== "dropped")
          yield* records.update(input.orgId, writer, target.key, { state: "dropped" });
        if (entry.target !== null)
          yield* sql`DELETE FROM kin_record_links WHERE org_id = ${input.orgId} AND kind = 'record'
            AND ((record_id = ${entry.target} AND target = ${entry.bankRecordId})
              OR (record_id = ${entry.bankRecordId} AND target = ${entry.target}))`;
        // The oldest entry for a row holds the row's state from before this statement.
        if (prior !== undefined && !restored.has(entry.bankRecordId)) {
          const earliest = entries.findLast((one) => one.bankRecordId === entry.bankRecordId)!;
          const first = Option.getOrUndefined(decodePrior(earliest.prior ?? ""));
          const bank = yield* records.getById(input.orgId, entry.bankRecordId);
          if (bank !== undefined && first !== undefined)
            yield* records.update(input.orgId, writer, bank.key, {
              state: first.bank.state as KinRecordState,
              category: first.bank.category,
            });
          restored.add(entry.bankRecordId);
        }
      }
      yield* sql`DELETE FROM kin_bank_statement_entries WHERE org_id = ${input.orgId}
        AND statement_id = ${input.statementId}`;
      yield* sql`UPDATE kin_bank_statements SET applied_at = NULL, applied_by = NULL, undone_at = ${input.now}
        WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}`;
      const review = stored.reviewJson === null ? undefined : reviewOf(stored.reviewJson);
      const card =
        (yield* cardState(input.orgId, stored.reviewWidgetId)) ??
        (review === undefined
          ? undefined
          : reviewCard(input.statementId, review, yield* expenseCategories(input.orgId)));
      if (card === undefined) return yield* invalid("This statement can no longer be read.");
      const { result: _result, unexplained: _unexplained, ...rest } = card;
      const next = {
        ...rest,
        status: "undone" as const,
        result: [
          `Undone: nothing from this statement is applied now (${entries.length === 0 ? "it had made no changes" : `${entries.length} change${entries.length === 1 ? "" : "s"} taken back`}). Confirm again to apply it.`,
        ],
      } satisfies KinStatementReviewCard;
      if (stored.reviewWidgetId !== null)
        yield* updateCard(input.orgId, stored.reviewWidgetId, next, false);
      return { card: next };
    }),
  );
});

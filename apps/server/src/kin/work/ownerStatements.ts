import {
  KinChatError,
  KinStatementPasswordCard,
  type KinStatementApplyInput,
  type KinStatementForgetAccountInput,
  type KinStatementForgetPasswordInput,
  type KinStatementPasswordsInput,
  type KinStatementRowsInput,
  type KinStatementSelectInput,
  type KinStatementRereadInput,
  type KinStatementUndoInput,
  type KinStatementUnlockInput,
  KinWidgetId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatRepository } from "../chat/KinChatRepository.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { theOwner } from "./ownerWork.ts";
import { workFailure } from "./recordRows.ts";
import {
  applyStatement,
  selectRows,
  statementRows,
  undoStatement,
} from "./statements/statementApply.ts";
import { isReading, readingOf, readStored, settleOutcome } from "./statements/statementReading.ts";
import {
  askPassword,
  attachmentBytes,
  forgetAccount as forgetKeptAccount,
  forgetPassword as forgetKept,
  keepPassword,
  keptAccounts,
  readWith,
  reviewOf,
  statementRow,
  updateCard,
} from "./statements/statementReview.ts";
import { settledLine, tellLead } from "./statements/statementWake.ts";

/**
 * What only the owner does with a statement, from its cards: open a locked one with its
 * password, confirm the review, undo it, and forget a kept password.
 */

const notFound = new KinChatError({ reason: "not_found", message: "No such statement." });
/** Wrong passwords one card takes before Kin stops trying the file. */
const PASSWORD_TRIES = 5;
const decodePasswordCard = Schema.decodeUnknownOption(KinStatementPasswordCard);

const passwordCard = Effect.fn("KinStatements.passwordCard")(function* (
  orgId: KinStatementUnlockInput["orgId"],
  widgetId: string | null,
) {
  if (widgetId === null) return undefined;
  const repo = yield* KinChatRepository;
  const found = yield* repo.getWidget({ orgId, widgetId: KinWidgetId.make(widgetId) });
  return Option.isNone(found)
    ? undefined
    : Option.getOrUndefined(decodePasswordCard(found.value.state));
});

/**
 * Opens a locked statement with the owner's password: used for this read, then forgotten unless
 * they asked Kin to keep it for the account. Its review card follows, or its pages wait for the
 * lead, which hears the outcome as the owner's tap.
 */
export const unlock = Effect.fn("KinStatements.unlock")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinStatementUnlockInput,
) {
  yield* theOwner(people, input.orgId);
  const stored = yield* statementRow(input.orgId, input.statementId);
  if (stored === undefined) return yield* notFound;
  if (stored.status === "read" || isReading(stored)) return { status: "opened" as const };
  if (stored.status !== "needs_password")
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "This statement isn't locked.",
    });
  const card = yield* passwordCard(input.orgId, stored.passwordWidgetId);
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const setCard = (state: KinStatementPasswordCard, closed: boolean) =>
    stored.passwordWidgetId === null
      ? Effect.void
      : updateCard(input.orgId, stored.passwordWidgetId, state, closed);
  const base: KinStatementPasswordCard = card ?? {
    text: "",
    statementId: input.statementId,
    fileName: stored.fileName,
    status: "locked",
  };
  if (stored.passwordAttempts >= PASSWORD_TRIES) return { status: "limit" as const };
  const outcome = yield* readWith(yield* attachmentBytes(stored.attachmentId), input.password);
  if (outcome._tag === "wrong_password" || outcome._tag === "needs_password") {
    const tries = stored.passwordAttempts + 1;
    const status = tries >= PASSWORD_TRIES ? ("limit" as const) : ("wrong" as const);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE kin_bank_statements SET password_attempts = ${tries}
          WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}`;
        yield* setCard({ ...base, status }, status === "limit");
      }),
    );
    return { status };
  }
  if (outcome._tag === "unreadable") {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE kin_bank_statements SET status = 'unreadable', reason = ${outcome.reason}
          WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}`;
        yield* setCard({ ...base, status: "unreadable", detail: outcome.reason }, true);
      }),
    );
    return { status: "unreadable" as const };
  }
  const facts =
    outcome._tag === "read"
      ? outcome.statement
      : outcome._tag === "pages"
        ? outcome.facts
        : { bank: null, account: null, kind: "account" as const };
  const remembered = input.remember
    ? yield* keepPassword(input.orgId, facts, input.password, now)
    : undefined;
  const settled = yield* settleOutcome({
    orgId: input.orgId,
    statementId: input.statementId,
    agentId: stored.agentId,
    chatId: stored.chatId,
    now,
    outcome,
  });
  yield* sql.withTransaction(
    setCard(
      { ...base, status: "opened", ...(remembered === undefined ? {} : { remembered }) },
      true,
    ),
  );
  if (stored.passwordWidgetId !== null)
    yield* tell({
      orgId: input.orgId,
      statementId: input.statementId,
      widgetId: stored.passwordWidgetId,
      tap: "unlock",
      outcome: settledLine(settled),
    });
  return { status: "opened" as const };
}, workFailure);

/** The lead hears of a card action; the action itself already stands, whatever happens here. */
const tell = Effect.fn("KinStatements.tell")(
  function* (input: Parameters<typeof tellLead>[0]) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(tellLead(input));
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin couldn't tell the lead about a statement card action", { cause }),
  ),
);

/**
 * Reads a statement's stored file again, after a reader fix or to take in rows a read missed:
 * with the password kept for its account, else a fresh password card. Rows it already recorded
 * show as recorded; the rest are offered on a fresh card, or wait for the lead to read the pages.
 */
export const rereadStatement = Effect.fn("KinStatements.reread")(function* (input: {
  readonly orgId: KinStatementRereadInput["orgId"];
  readonly statementId: string;
}) {
  const stored = yield* statementRow(input.orgId, input.statementId);
  if (stored === undefined) return yield* notFound;
  const outcome = yield* readStored(input.orgId, stored.attachmentId);
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  if (outcome._tag === "needs_password" || outcome._tag === "wrong_password") {
    // Read again starts the file's tries over, on the card and from the chat alike.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE kin_bank_statements SET password_attempts = 0, chat_password_attempts = 0
          WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}`;
        const widgetId = yield* askPassword({
          orgId: input.orgId,
          statementId: input.statementId,
          agentId: stored.agentId,
          chatId: stored.chatId,
          fileName: stored.fileName,
        });
        const card = yield* passwordCard(input.orgId, widgetId);
        if (card?.detail !== undefined && card.status === "locked") {
          const { detail: _detail, ...rest } = card;
          yield* updateCard(input.orgId, widgetId, rest, false);
        }
      }),
    );
    return { status: "needs_password" as const, stored, settled: undefined };
  }
  if (outcome._tag === "unreadable")
    return { status: "unreadable" as const, reason: outcome.reason, stored, settled: undefined };
  const settled = yield* settleOutcome({
    orgId: input.orgId,
    statementId: input.statementId,
    agentId: stored.agentId,
    chatId: stored.chatId,
    now,
    ...(stored.account === null ? {} : { account: stored.account }),
    outcome,
  });
  return {
    status: settled._tag === "card" ? ("read" as const) : ("reading" as const),
    stored,
    settled,
  };
});

/** The card the owner read a statement again from, which the lead hears the outcome on. */
export const rereadTap = (
  done: Effect.Success<ReturnType<typeof rereadStatement>>,
  orgId: KinStatementRereadInput["orgId"],
) => {
  const widgetId = done.stored.reviewWidgetId ?? done.stored.passwordWidgetId;
  return done.settled === undefined || widgetId === null
    ? undefined
    : {
        orgId,
        statementId: done.stored.statementId,
        widgetId,
        tap: "read_again" as const,
        outcome: settledLine(done.settled),
      };
};

/** Where a statement stands, in counts only: never its rows, file name or account. */
export const standingOf = Effect.fn("KinStatements.standing")(function* (
  orgId: KinStatementRereadInput["orgId"],
  statementId: string,
) {
  const stored = yield* statementRow(orgId, statementId);
  if (stored === undefined) return yield* notFound;
  const sql = yield* SqlClient.SqlClient;
  const [held] = yield* sql<{ n: number }>`SELECT COUNT(DISTINCT row_index) AS n
    FROM kin_bank_statement_entries WHERE org_id = ${orgId} AND statement_id = ${statementId}`;
  const review = stored.reviewJson === null ? undefined : reviewOf(stored.reviewJson);
  const reading = readingOf(stored);
  const groups = review === undefined ? [] : [...review.matches.values()];
  const count = (name: string) => groups.filter((one) => one.group === name).length;
  return reading !== undefined && isReading(stored)
    ? `Waiting on its lead to read ${reading.total} pages (${reading.read} given so far).`
    : stored.status === "needs_password"
      ? "Locked: its password card waits in the chat."
      : review === undefined
        ? `Not read (${stored.status}).`
        : [
            `${review.statement.rows.length} rows, ${review.statement.check.status === "adds_up" ? "adds up" : review.statement.check.status === "off" ? "doesn't check out" : "unchecked"}.`,
            `On its card: ${count("matched")} matched, ${count("choose")} to choose, ${count("unmatched")} unmatched, ${review.statement.rows.length - groups.length} already recorded.`,
            `${stored.appliedAt === null ? "Not confirmed" : "Confirmed"}; ${held?.n ?? 0} rows recorded from it.`,
          ].join(" ");
});

export const reread = Effect.fn("KinStatements.rereadRpc")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinStatementRereadInput,
) {
  yield* theOwner(people, input.orgId);
  const done = yield* rereadStatement(input);
  const tap = rereadTap(done, input.orgId);
  if (tap !== undefined) yield* tell(tap);
  return { status: done.status };
}, workFailure);

/** Forgets the password kept for this statement's account; the next locked one asks again. */
export const forgetPassword = Effect.fn("KinStatements.forget")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinStatementForgetPasswordInput,
) {
  yield* theOwner(people, input.orgId);
  const stored = yield* statementRow(input.orgId, input.statementId);
  const review =
    stored?.reviewJson === null || stored === undefined ? undefined : reviewOf(stored.reviewJson);
  if (stored === undefined || review === undefined) return yield* notFound;
  yield* forgetKept(input.orgId, review.statement);
  const card = yield* passwordCard(input.orgId, stored.passwordWidgetId);
  if (card !== undefined && stored.passwordWidgetId !== null) {
    const { remembered: _remembered, ...rest } = card;
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(updateCard(input.orgId, stored.passwordWidgetId, rest, true));
  }
  return { status: "opened" as const };
}, workFailure);

export const select = Effect.fn("KinStatements.selectRpc")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinStatementSelectInput,
) {
  const person = yield* theOwner(people, input.orgId);
  return yield* selectRows({ ...input, personId: person.personId });
}, workFailure);

export const rows = Effect.fn("KinStatements.rowsRpc")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinStatementRowsInput,
) {
  const person = yield* theOwner(people, input.orgId);
  return yield* statementRows({ ...input, personId: person.personId });
}, workFailure);

export const passwords = Effect.fn("KinStatements.passwordsRpc")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinStatementPasswordsInput,
) {
  yield* theOwner(people, input.orgId);
  return yield* keptAccounts(input.orgId);
}, workFailure);

/** Forgets one kept account's password from the list, outside any statement's card. */
export const forgetAccount = Effect.fn("KinStatements.forgetAccountRpc")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinStatementForgetAccountInput,
) {
  yield* theOwner(people, input.orgId);
  yield* forgetKeptAccount(input.orgId, input.account);
  return yield* keptAccounts(input.orgId);
}, workFailure);

export const apply = Effect.fn("KinStatements.applyRpc")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinStatementApplyInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const result = yield* applyStatement({
    ...input,
    personId: person.personId,
    now: yield* Clock.currentTimeMillis,
  });
  yield* tellOutcome(input, "confirm", result.card.result ?? []);
  return result;
}, workFailure);

const tellOutcome = Effect.fn("KinStatements.tellOutcome")(function* (
  input: { readonly orgId: KinStatementUndoInput["orgId"]; readonly statementId: string },
  tap: "confirm" | "undo",
  result: ReadonlyArray<string>,
) {
  const stored = yield* statementRow(input.orgId, input.statementId);
  if (stored?.reviewWidgetId == null) return;
  yield* tell({
    orgId: input.orgId,
    statementId: input.statementId,
    widgetId: stored.reviewWidgetId,
    tap,
    outcome: result.join(" "),
  });
});

export const undo = Effect.fn("KinStatements.undoRpc")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinStatementUndoInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const result = yield* undoStatement({
    ...input,
    personId: person.personId,
    now: yield* Clock.currentTimeMillis,
  });
  yield* tellOutcome(input, "undo", result.card.result ?? []);
  return result;
}, workFailure);

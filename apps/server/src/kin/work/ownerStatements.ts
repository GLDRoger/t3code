import {
  KinChatError,
  KinStatementPasswordCard,
  type KinStatementApplyInput,
  type KinStatementForgetPasswordInput,
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
import { applyStatement, undoStatement } from "./statements/statementApply.ts";
import {
  attachmentBytes,
  buildReview,
  forgetPassword as forgetKept,
  keepPassword,
  readWith,
  reviewOf,
  saveRead,
  statementRow,
  updateCard,
} from "./statements/statementReview.ts";

/**
 * What only the owner does with a statement, from its cards: open a locked one with its
 * password, confirm the review, undo it, and forget a kept password.
 */

const notFound = new KinChatError({ reason: "not_found", message: "No such statement." });
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
 * they asked Kin to keep it for the account. Its review card follows, as a lead's read posts one.
 */
export const unlock = Effect.fn("KinStatements.unlock")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinStatementUnlockInput,
) {
  yield* theOwner(people, input.orgId);
  const stored = yield* statementRow(input.orgId, input.statementId);
  if (stored === undefined) return yield* notFound;
  if (stored.status === "read") return { status: "opened" as const };
  if (stored.status !== "needs_password")
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "This statement isn't locked.",
    });
  const card = yield* passwordCard(input.orgId, stored.passwordWidgetId);
  const outcome = yield* readWith(yield* attachmentBytes(stored.attachmentId), input.password);
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
  if (outcome._tag === "wrong_password" || outcome._tag === "needs_password") {
    yield* sql.withTransaction(setCard({ ...base, status: "wrong" }, false));
    return { status: "wrong" as const };
  }
  if (outcome._tag !== "read") {
    const detail =
      outcome._tag === "scanned"
        ? "It opened, but it is a scan with no text. Ask Kin to read it from its pages."
        : outcome.reason;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE kin_bank_statements SET status = ${outcome._tag === "scanned" ? "scanned" : "unreadable"},
            reason = ${outcome._tag === "scanned" ? null : outcome.reason}
          WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}`;
        yield* setCard({ ...base, status: "unreadable", detail }, true);
      }),
    );
    return { status: "unreadable" as const };
  }
  const remembered = input.remember
    ? yield* keepPassword(input.orgId, outcome.statement, input.password, now)
    : undefined;
  const review = yield* buildReview(input.orgId, outcome.statement, outcome.format, "file");
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* saveRead({
        orgId: input.orgId,
        statementId: input.statementId,
        agentId: stored.agentId,
        chatId: stored.chatId,
        review,
        now,
      });
      yield* setCard(
        { ...base, status: "opened", ...(remembered === undefined ? {} : { remembered }) },
        true,
      );
    }),
  );
  return { status: "opened" as const };
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

export const apply = Effect.fn("KinStatements.applyRpc")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinStatementApplyInput,
) {
  const person = yield* theOwner(people, input.orgId);
  return yield* applyStatement({
    ...input,
    personId: person.personId,
    now: yield* Clock.currentTimeMillis,
  });
}, workFailure);

export const undo = Effect.fn("KinStatements.undoRpc")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinStatementUndoInput,
) {
  const person = yield* theOwner(people, input.orgId);
  return yield* undoStatement({
    ...input,
    personId: person.personId,
    now: yield* Clock.currentTimeMillis,
  });
}, workFailure);

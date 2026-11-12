import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthOrchestrationOperateScope, EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChatError, KinOrgId } from "./kinChat.ts";
import { KinDay } from "./kinMoney.ts";

/**
 * Bank and card statements sent in chat: the owner's two cards and the three things only the
 * owner does with them. Kin reads the file and matches its rows itself; nothing applies until
 * the owner confirms the exact set the review card shows, and a statement's password crosses
 * the wire once, redacted, never into a message.
 */

export const KIN_STATEMENT_REVIEW_CARD = "statement_review";
export const KIN_STATEMENT_PASSWORD_CARD = "statement_password";

const Text = Schema.String.check(Schema.isMaxLength(300));
const Label = Schema.String.check(Schema.isMaxLength(200));
export const KinStatementDirection = Schema.Literals(["debit", "credit"]);
export type KinStatementDirection = typeof KinStatementDirection.Type;

/** One statement row as a card shows it; `row` is its place in the statement, from 0. */
const RowFields = {
  row: NonNegativeInt,
  date: KinDay,
  text: Text,
  /** Formatted by the server, exact. */
  amount: Label,
  direction: KinStatementDirection,
};
export const KinStatementTarget = Schema.Struct({
  /** Which of the row's candidates, by index, a choice names. */
  option: NonNegativeInt,
  kind: Schema.Literals(["invoice", "expense"]),
  key: Label,
  label: Label,
  /** "Paid with ₹10,000.00 TDS deducted", "Part payment": how the money fits the entry. */
  note: Schema.optional(Label),
});
export type KinStatementTarget = typeof KinStatementTarget.Type;
export const KinStatementAction = Schema.Literals(["expense", "transfer", "ignore"]);
export type KinStatementAction = typeof KinStatementAction.Type;

export const KinStatementReviewCard = Schema.Struct({
  /** The card's fixed words: what older clients show, and all its push carries. */
  text: Text,
  statementId: TrimmedNonEmptyString,
  /** The exact set shown; an apply naming another is refused. */
  hash: TrimmedNonEmptyString,
  title: Label,
  /** Rows read, totals and whether the balances add up, as lines. */
  summary: Schema.Array(Text),
  balance: Schema.Literals(["adds_up", "off", "unchecked"]),
  /** Rows Kin read itself from images of a scan, rather than from the file's text. */
  readByAgent: Schema.optional(Schema.Literal(true)),
  matched: Schema.Array(Schema.Struct({ ...RowFields, target: KinStatementTarget })),
  choose: Schema.Array(Schema.Struct({ ...RowFields, options: Schema.Array(KinStatementTarget) })),
  unmatched: Schema.Array(
    Schema.Struct({
      ...RowFields,
      suggestion: Schema.Literals(["expense", "transfer", "ignore", "later"]),
      why: Schema.optional(Label),
      vendor: Schema.optional(Label),
      category: Schema.optional(Label),
    }),
  ),
  /** Rows already in Bank transactions from an earlier statement: counted, not shown again. */
  recorded: NonNegativeInt,
  /** The Expenses categories a new expense may take. */
  categories: Schema.Array(Label),
  status: Schema.Literals(["open", "applied", "undone"]),
  result: Schema.optional(Schema.Array(Text)),
  /** After it is applied: this statement's rows still unexplained in Bank transactions. */
  unexplained: Schema.optional(NonNegativeInt),
});
export type KinStatementReviewCard = typeof KinStatementReviewCard.Type;

export const KinStatementPasswordCard = Schema.Struct({
  text: Text,
  statementId: TrimmedNonEmptyString,
  fileName: Label,
  status: Schema.Literals(["locked", "wrong", "opened", "unreadable"]),
  /** Why an opened file still couldn't be read, in plain words. */
  detail: Schema.optional(Text),
  /** The account the password is now kept for, when the owner asked Kin to remember it. */
  remembered: Schema.optional(Label),
});
export type KinStatementPasswordCard = typeof KinStatementPasswordCard.Type;

/** A statement password: at most 128 characters, redacted from the moment it is decoded. */
export const KinStatementPassword = Schema.RedactedFromValue(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
);
export const KinStatementUnlockInput = Schema.Struct({
  orgId: KinOrgId,
  statementId: TrimmedNonEmptyString,
  password: KinStatementPassword,
  /** Keep it for this statement's account, so the next one opens on its own. */
  remember: Schema.Boolean,
});
export type KinStatementUnlockInput = typeof KinStatementUnlockInput.Type;
export const KinStatementUnlockResult = Schema.Struct({
  status: KinStatementPasswordCard.fields.status,
});
export type KinStatementUnlockResult = typeof KinStatementUnlockResult.Type;

export const KinStatementApplyInput = Schema.Struct({
  orgId: KinOrgId,
  statementId: TrimmedNonEmptyString,
  hash: TrimmedNonEmptyString,
  /** Matched rows the owner kept ticked; an unticked one stays for later. */
  matched: Schema.Array(NonNegativeInt).check(Schema.isMaxLength(20_000)),
  chosen: Schema.Array(Schema.Struct({ row: NonNegativeInt, option: NonNegativeInt })).check(
    Schema.isMaxLength(20_000),
  ),
  actions: Schema.Array(
    Schema.Struct({
      row: NonNegativeInt,
      action: KinStatementAction,
      vendor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
      category: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(60))),
    }),
  ).check(Schema.isMaxLength(20_000)),
});
export type KinStatementApplyInput = typeof KinStatementApplyInput.Type;
export const KinStatementUndoInput = Schema.Struct({
  orgId: KinOrgId,
  statementId: TrimmedNonEmptyString,
});
export type KinStatementUndoInput = typeof KinStatementUndoInput.Type;
export const KinStatementForgetPasswordInput = Schema.Struct({
  orgId: KinOrgId,
  statementId: TrimmedNonEmptyString,
});
export type KinStatementForgetPasswordInput = typeof KinStatementForgetPasswordInput.Type;
export const KinStatementResult = Schema.Struct({ card: KinStatementReviewCard });
export type KinStatementResult = typeof KinStatementResult.Type;

const KIN_STATEMENT_WS_METHODS = {
  unlock: "kin.work.statementUnlock",
  forgetPassword: "kin.work.statementForgetPassword",
  apply: "kin.work.statementApply",
  undo: "kin.work.statementUndo",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
// Owner only, on the server, as payments are.
export const KinStatementRpcs = [
  Rpc.make(KIN_STATEMENT_WS_METHODS.unlock, {
    payload: KinStatementUnlockInput,
    success: KinStatementUnlockResult,
    error,
  }),
  Rpc.make(KIN_STATEMENT_WS_METHODS.forgetPassword, {
    payload: KinStatementForgetPasswordInput,
    success: KinStatementUnlockResult,
    error,
  }),
  Rpc.make(KIN_STATEMENT_WS_METHODS.apply, {
    payload: KinStatementApplyInput,
    success: KinStatementResult,
    error,
  }),
  Rpc.make(KIN_STATEMENT_WS_METHODS.undo, {
    payload: KinStatementUndoInput,
    success: KinStatementResult,
    error,
  }),
] as const;

export const KIN_STATEMENT_RPC_SCOPES = {
  // Recording payments and expenses is an entry change, like Record payment.
  [KIN_STATEMENT_WS_METHODS.unlock]: AuthOrchestrationOperateScope,
  [KIN_STATEMENT_WS_METHODS.forgetPassword]: AuthOrchestrationOperateScope,
  [KIN_STATEMENT_WS_METHODS.apply]: AuthOrchestrationOperateScope,
  [KIN_STATEMENT_WS_METHODS.undo]: AuthOrchestrationOperateScope,
} as const;

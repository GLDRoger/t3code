import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
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
  /**
   * "Already recorded · receipt RCT/26-27/001": this statement recorded the row and an undo kept
   * it. Shown, never selectable; Confirm leaves it as it is.
   */
  recorded: Schema.optional(Label),
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
export const KinStatementRowChoice = Schema.Literals(["expense", "transfer", "ignore", "later"]);
export type KinStatementRowChoice = typeof KinStatementRowChoice.Type;

/** Rows of each section a review card carries; the rest are read a page at a time. */
export const KIN_STATEMENT_CARD_ROWS = 50;
const Rows = Schema.Array(NonNegativeInt).check(Schema.isMaxLength(20_000));

/**
 * What the owner chose on a review card, kept on the server for the review it was made on, so
 * Confirm applies it whole, including rows the device never loaded. Matched rows start all
 * ticked or none; `except` are the ones toggled from that.
 */
export const KinStatementSelection = Schema.Struct({
  revision: NonNegativeInt,
  ticked: Schema.Literals(["all", "none"]),
  except: Rows,
  picks: Schema.Array(Schema.Struct({ row: NonNegativeInt, option: NonNegativeInt })).check(
    Schema.isMaxLength(20_000),
  ),
  /** Unmatched rows with no choice of their own take Kin's suggestion. */
  suggestions: Schema.Boolean,
  actions: Schema.Array(
    Schema.Struct({ row: NonNegativeInt, action: KinStatementRowChoice }),
  ).check(Schema.isMaxLength(20_000)),
});
export type KinStatementSelection = typeof KinStatementSelection.Type;
const SectionCounts = Schema.Struct({
  matched: NonNegativeInt,
  choose: NonNegativeInt,
  unmatched: NonNegativeInt,
});

const MatchedRow = Schema.Struct({ ...RowFields, target: KinStatementTarget });
const ChooseRow = Schema.Struct({ ...RowFields, options: Schema.Array(KinStatementTarget) });
const UnmatchedRow = Schema.Struct({
  ...RowFields,
  suggestion: KinStatementRowChoice,
  why: Schema.optional(Label),
  vendor: Schema.optional(Label),
  category: Schema.optional(Label),
});

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
  /** Rows the statement's lead read, from a PDF's pages or a scan's images, that Kin then checked. */
  readByAgent: Schema.optional(Schema.Literal(true)),
  /** The first rows of each section; `counts` says how many there are in all. */
  matched: Schema.Array(MatchedRow),
  choose: Schema.Array(ChooseRow),
  unmatched: Schema.Array(UnmatchedRow),
  /** Absent on cards made before rows were paged: then the lists above are whole. */
  counts: Schema.optional(SectionCounts),
  /** Absent on older cards, which start from Kin's proposal. */
  selection: Schema.optional(KinStatementSelection),
  /** What Confirm records now, by section. */
  chosen: Schema.optional(SectionCounts),
  /** Why no match starts ticked: rows Kin read from a scan, or balances that don't check out. */
  heldBack: Schema.optional(Text),
  /** Rows already in Bank transactions from an earlier statement: counted, not shown again. */
  recorded: NonNegativeInt,
  /** Rows this statement itself recorded, which Undo takes back even before the next Confirm. */
  recordedHere: Schema.optional(NonNegativeInt),
  /** The Expenses categories a new expense may take. */
  categories: Schema.Array(Label),
  /** `replaced`: a fresh read of the statement posted a newer card. */
  status: Schema.Literals(["open", "applied", "undone", "replaced"]),
  result: Schema.optional(Schema.Array(Text)),
  /** After it is applied: this statement's rows still unexplained in Bank transactions. */
  unexplained: Schema.optional(NonNegativeInt),
});
export type KinStatementReviewCard = typeof KinStatementReviewCard.Type;

export const KinStatementPasswordCard = Schema.Struct({
  text: Text,
  statementId: TrimmedNonEmptyString,
  fileName: Label,
  /** `limit`: too many wrong passwords on this card; sending the file again starts over. */
  status: Schema.Literals(["locked", "wrong", "opened", "unreadable", "limit"]),
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

/** Applies the selection kept for this review, as the owner last saw it. */
export const KinStatementApplyInput = Schema.Struct({
  orgId: KinOrgId,
  statementId: TrimmedNonEmptyString,
  hash: TrimmedNonEmptyString,
  /** Optional on the wire only so builds from before it get a reason to update, not a decode error. */
  revision: Schema.optional(NonNegativeInt),
});
export type KinStatementApplyInput = typeof KinStatementApplyInput.Type;

export const KinStatementSelectChange = Schema.Union([
  Schema.TaggedStruct("tick", { row: NonNegativeInt, ticked: Schema.Boolean }),
  Schema.TaggedStruct("tickAll", { ticked: Schema.Boolean }),
  /** `option` null takes the pick back. */
  Schema.TaggedStruct("pick", { row: NonNegativeInt, option: Schema.NullOr(NonNegativeInt) }),
  Schema.TaggedStruct("action", { row: NonNegativeInt, action: KinStatementRowChoice }),
  Schema.TaggedStruct("suggestions", {}),
]);
export type KinStatementSelectChange = typeof KinStatementSelectChange.Type;
export const KinStatementSelectInput = Schema.Struct({
  orgId: KinOrgId,
  statementId: TrimmedNonEmptyString,
  hash: TrimmedNonEmptyString,
  change: KinStatementSelectChange,
});
export type KinStatementSelectInput = typeof KinStatementSelectInput.Type;

export const KinStatementSection = Schema.Literals(["matched", "choose", "unmatched"]);
export type KinStatementSection = typeof KinStatementSection.Type;
/** More of one section's rows than the card carries, in statement order. */
export const KinStatementRowsInput = Schema.Struct({
  orgId: KinOrgId,
  statementId: TrimmedNonEmptyString,
  hash: TrimmedNonEmptyString,
  section: KinStatementSection,
  offset: NonNegativeInt,
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
});
export type KinStatementRowsInput = typeof KinStatementRowsInput.Type;
export const KinStatementRowsResult = Schema.Struct({
  total: NonNegativeInt,
  matched: Schema.Array(MatchedRow),
  choose: Schema.Array(ChooseRow),
  unmatched: Schema.Array(UnmatchedRow),
});
export type KinStatementRowsResult = typeof KinStatementRowsResult.Type;

/** Accounts whose statement password Kin keeps; never the password itself. */
export const KinStatementPasswordsInput = Schema.Struct({ orgId: KinOrgId });
export type KinStatementPasswordsInput = typeof KinStatementPasswordsInput.Type;
export const KinStatementPasswordsResult = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({ account: TrimmedNonEmptyString, label: Label, rememberedAt: IsoDateTime }),
  ),
});
export type KinStatementPasswordsResult = typeof KinStatementPasswordsResult.Type;
export const KinStatementForgetAccountInput = Schema.Struct({
  orgId: KinOrgId,
  account: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
});
export type KinStatementForgetAccountInput = typeof KinStatementForgetAccountInput.Type;
export const KinStatementUndoInput = Schema.Struct({
  orgId: KinOrgId,
  statementId: TrimmedNonEmptyString,
});
export type KinStatementUndoInput = typeof KinStatementUndoInput.Type;
/** Reads a statement's file again: rows it recorded show as recorded, the rest are offered. */
export const KinStatementRereadInput = Schema.Struct({
  orgId: KinOrgId,
  statementId: TrimmedNonEmptyString,
});
export type KinStatementRereadInput = typeof KinStatementRereadInput.Type;
export const KinStatementRereadResult = Schema.Struct({
  /** `reading`: its lead reads the pages and posts the card; `needs_password`: a card asks. */
  status: Schema.Literals(["read", "reading", "needs_password", "unreadable"]),
});
export type KinStatementRereadResult = typeof KinStatementRereadResult.Type;
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
  reread: "kin.work.statementReread",
  select: "kin.work.statementSelect",
  rows: "kin.work.statementRows",
  passwords: "kin.work.statementPasswords",
  forgetAccount: "kin.work.statementForgetAccount",
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
  Rpc.make(KIN_STATEMENT_WS_METHODS.reread, {
    payload: KinStatementRereadInput,
    success: KinStatementRereadResult,
    error,
  }),
  Rpc.make(KIN_STATEMENT_WS_METHODS.select, {
    payload: KinStatementSelectInput,
    success: KinStatementResult,
    error,
  }),
  Rpc.make(KIN_STATEMENT_WS_METHODS.rows, {
    payload: KinStatementRowsInput,
    success: KinStatementRowsResult,
    error,
  }),
  Rpc.make(KIN_STATEMENT_WS_METHODS.passwords, {
    payload: KinStatementPasswordsInput,
    success: KinStatementPasswordsResult,
    error,
  }),
  Rpc.make(KIN_STATEMENT_WS_METHODS.forgetAccount, {
    payload: KinStatementForgetAccountInput,
    success: KinStatementPasswordsResult,
    error,
  }),
] as const;

export const KIN_STATEMENT_RPC_SCOPES = {
  // Recording payments and expenses is an entry change, like Record payment.
  [KIN_STATEMENT_WS_METHODS.unlock]: AuthOrchestrationOperateScope,
  [KIN_STATEMENT_WS_METHODS.forgetPassword]: AuthOrchestrationOperateScope,
  [KIN_STATEMENT_WS_METHODS.apply]: AuthOrchestrationOperateScope,
  [KIN_STATEMENT_WS_METHODS.undo]: AuthOrchestrationOperateScope,
  [KIN_STATEMENT_WS_METHODS.reread]: AuthOrchestrationOperateScope,
  [KIN_STATEMENT_WS_METHODS.select]: AuthOrchestrationOperateScope,
  [KIN_STATEMENT_WS_METHODS.forgetAccount]: AuthOrchestrationOperateScope,
  // Statement rows and kept accounts are the owner's money: read as Money is.
  [KIN_STATEMENT_WS_METHODS.rows]: AuthOrchestrationReadScope,
  [KIN_STATEMENT_WS_METHODS.passwords]: AuthOrchestrationReadScope,
} as const;

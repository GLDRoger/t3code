import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  KinAttachment,
  KinChatError,
  KinChatId,
  KinOrgId,
  KinPersonId,
  KinWidgetId,
} from "./kinChat.ts";
import { KinDay, KinFileRef } from "./kinMoney.ts";
import { KinRecordKey } from "./kinWork.ts";

/**
 * Bills in bulk: an owner-level person's bill photos and PDFs, each read once in a quiet turn and
 * made one suggested expense with its file. Nothing counts in Money until kept; keeping, editing
 * and dropping one is `kin.work.confirm`, `update` and `decline` on its expense.
 */

export const KIN_BILL_BATCH_CARD = "bill_batch";
/** Files one add takes, as one chat message does. */
const KIN_BILLS_MAX_FILES = 100;

const Text = Schema.String.check(Schema.isMaxLength(300));
const Label = Schema.String.check(Schema.isMaxLength(200));
const RequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(120));

/** A bill's file, by the sha256 of its bytes as Kin stored them. */
export const KinBillSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export type KinBillSha256 = typeof KinBillSha256.Type;
export const KinBillBatchId = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
export type KinBillBatchId = typeof KinBillBatchId.Type;

/**
 * A bill as the owner sees it: still being read, read with its suggested expense waiting, that
 * expense kept or dropped, looking like an expense already recorded, or not read cleanly.
 */
export const KinBillState = Schema.Literals([
  "reading",
  "read",
  "kept",
  "dropped",
  "duplicate",
  "unreadable",
]);
export type KinBillState = typeof KinBillState.Type;

/** What the reading agent read off the bill, as printed: a blank it left blank stays absent. */
export const KinBillRead = Schema.Struct({
  /** Who was paid. */
  vendor: Schema.optional(Label),
  date: Schema.optional(KinDay),
  /** The printed figures, never converted, in `currency`. */
  amount: Schema.optional(Label),
  currency: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))),
  tax: Schema.optional(Label),
  category: Schema.optional(Label),
  /** The bill's own printed number. */
  number: Schema.optional(Label),
});
export type KinBillRead = typeof KinBillRead.Type;

const BatchCounts = Schema.Struct({
  read: NonNegativeInt,
  duplicate: NonNegativeInt,
  unreadable: NonNegativeInt,
  /** Files whose bytes were already added before, in this company. */
  already: NonNegativeInt,
});

/**
 * The batch's one card, in the adding person's direct chat with the reading agent, updated in
 * place while Kin reads and once at the end. `text` always says the whole of it in words.
 */
export const KinBillBatchCard = Schema.Struct({
  /** The card's fixed words: what older clients show, and all its push carries. */
  text: Text,
  batchId: KinBillBatchId,
  status: Schema.Literals(["reading", "done"]),
  /** Every image or PDF the add took, the already-added ones included. */
  total: NonNegativeInt,
  /** Of `total`: read, duplicates, unreadable and already added so far. */
  done: NonNegativeInt,
  counts: BatchCounts,
  /** Files refused as neither an image nor a PDF; not in `total`. */
  refused: Schema.optional(NonNegativeInt),
  addedBy: KinPersonId,
  /**
   * While reading waits on the reading agent's daily limit: when it resumes. `text` says so too;
   * absent once reading goes on.
   */
  pausedUntil: Schema.optional(IsoDateTime),
});
export type KinBillBatchCard = typeof KinBillBatchCard.Type;

export const KinBillsAddInput = Schema.Struct({
  orgId: KinOrgId,
  /** New uploads made with `attachments.createUploadUrl`, as a chat message's are. */
  attachments: Schema.Array(KinAttachment).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(KIN_BILLS_MAX_FILES),
  ),
  clientRequestId: RequestId,
});
export type KinBillsAddInput = typeof KinBillsAddInput.Type;

const AddedFile = Schema.Struct({ name: Label, sha256: KinBillSha256 });
export const KinBillsAddResult = Schema.Struct({
  batchId: KinBillBatchId,
  /** Where the batch's card is; absent when nothing new was added, which posts no card. */
  chatId: Schema.optional(KinChatId),
  widgetId: Schema.optional(KinWidgetId),
  /** The bills this add put in to be read. */
  added: Schema.Array(AddedFile),
  /**
   * Files already added before: nothing new for them, with the expense made for one, if any. A
   * bill dismissed, or whose file a cleared chat took, is added again instead.
   */
  already: Schema.Array(
    Schema.Struct({
      name: Label,
      sha256: KinBillSha256,
      expense: Schema.optional(KinRecordKey),
      /** That expense was dropped: restoring it brings it back; this file makes no other. */
      dropped: Schema.optional(Schema.Boolean),
    }),
  ),
  /** Files that are neither an image nor a PDF, each with why. */
  refused: Schema.Array(Schema.Struct({ name: Label, reason: Text })),
});
export type KinBillsAddResult = typeof KinBillsAddResult.Type;

export const KinBillsListInput = Schema.Struct({
  orgId: KinOrgId,
  /** One batch's bills; left out, the batches, newest first. */
  batchId: Schema.optional(KinBillBatchId),
  /** The `next` of the page before. */
  cursor: Schema.optional(NonNegativeInt),
});
export type KinBillsListInput = typeof KinBillsListInput.Type;

export const KinBillBatchSummary = Schema.Struct({
  batchId: KinBillBatchId,
  addedBy: KinPersonId,
  addedAt: IsoDateTime,
  chatId: KinChatId,
  widgetId: KinWidgetId,
  /** Bills in the batch, dismissed ones left out, by how the owner sees each. */
  bills: NonNegativeInt,
  states: Schema.Struct({
    reading: NonNegativeInt,
    read: NonNegativeInt,
    kept: NonNegativeInt,
    dropped: NonNegativeInt,
    duplicate: NonNegativeInt,
    unreadable: NonNegativeInt,
  }),
});
export type KinBillBatchSummary = typeof KinBillBatchSummary.Type;

export const KinBillRow = Schema.Struct({
  sha256: KinBillSha256,
  batchId: KinBillBatchId,
  /** Opened with `assets.createUrl`, as any file on an entry. */
  file: KinFileRef,
  state: KinBillState,
  read: KinBillRead,
  /** In plain words, what could not be read. */
  problem: Schema.optional(Text),
  /** The suggested expense made for it, as it stands now. */
  expense: Schema.optional(
    Schema.Struct({ key: KinRecordKey, rev: NonNegativeInt, title: Schema.String }),
  ),
  /** The expense it looks like, for a duplicate. */
  duplicateOf: Schema.optional(Schema.Struct({ key: KinRecordKey, title: Schema.String })),
  addedAt: IsoDateTime,
});
export type KinBillRow = typeof KinBillRow.Type;

export const KinBillsListResult = Schema.Struct({
  batches: Schema.Array(KinBillBatchSummary),
  bills: Schema.Array(KinBillRow),
  next: Schema.optional(NonNegativeInt),
});
export type KinBillsListResult = typeof KinBillsListResult.Type;

export const KinBillsKeepReadInput = Schema.Struct({
  orgId: KinOrgId,
  batchId: KinBillBatchId,
  clientRequestId: RequestId,
});
export type KinBillsKeepReadInput = typeof KinBillsKeepReadInput.Type;
export const KinBillsKeepReadResult = Schema.Struct({
  kept: Schema.Array(KinRecordKey),
  skipped: Schema.Array(
    Schema.Struct({ sha256: KinBillSha256, key: Schema.optional(KinRecordKey), why: Text }),
  ),
});
export type KinBillsKeepReadResult = typeof KinBillsKeepReadResult.Type;

export const KinBillsAddAnywayInput = Schema.Struct({
  orgId: KinOrgId,
  sha256: KinBillSha256,
  clientRequestId: RequestId,
});
export type KinBillsAddAnywayInput = typeof KinBillsAddAnywayInput.Type;
export const KinBillsAddAnywayResult = Schema.Struct({ expense: KinRecordKey });
export type KinBillsAddAnywayResult = typeof KinBillsAddAnywayResult.Type;

export const KinBillsDismissInput = Schema.Struct({ orgId: KinOrgId, sha256: KinBillSha256 });
export type KinBillsDismissInput = typeof KinBillsDismissInput.Type;
export const KinBillsDismissResult = Schema.Struct({ dismissed: Schema.Boolean });
export type KinBillsDismissResult = typeof KinBillsDismissResult.Type;

/** One bill, or every unreadable one of a batch. */
export const KinBillsReadAgainInput = Schema.Struct({
  orgId: KinOrgId,
  sha256: Schema.optional(KinBillSha256),
  batchId: Schema.optional(KinBillBatchId),
});
export type KinBillsReadAgainInput = typeof KinBillsReadAgainInput.Type;
export const KinBillsReadAgainResult = Schema.Struct({ queued: NonNegativeInt });
export type KinBillsReadAgainResult = typeof KinBillsReadAgainResult.Type;

const KIN_BILL_WS_METHODS = {
  add: "kin.bills.add",
  list: "kin.bills.list",
  keepRead: "kin.bills.keepRead",
  addAnyway: "kin.bills.addAnyway",
  dismiss: "kin.bills.dismiss",
  readAgain: "kin.bills.readAgain",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
// Owner and co-owner only, on the server, as expenses typed by hand are.
export const KinBillRpcs = [
  Rpc.make(KIN_BILL_WS_METHODS.add, {
    payload: KinBillsAddInput,
    success: KinBillsAddResult,
    error,
  }),
  Rpc.make(KIN_BILL_WS_METHODS.list, {
    payload: KinBillsListInput,
    success: KinBillsListResult,
    error,
  }),
  Rpc.make(KIN_BILL_WS_METHODS.keepRead, {
    payload: KinBillsKeepReadInput,
    success: KinBillsKeepReadResult,
    error,
  }),
  Rpc.make(KIN_BILL_WS_METHODS.addAnyway, {
    payload: KinBillsAddAnywayInput,
    success: KinBillsAddAnywayResult,
    error,
  }),
  Rpc.make(KIN_BILL_WS_METHODS.dismiss, {
    payload: KinBillsDismissInput,
    success: KinBillsDismissResult,
    error,
  }),
  Rpc.make(KIN_BILL_WS_METHODS.readAgain, {
    payload: KinBillsReadAgainInput,
    success: KinBillsReadAgainResult,
    error,
  }),
] as const;

export const KIN_BILL_RPC_SCOPES = {
  [KIN_BILL_WS_METHODS.add]: AuthKinChatScope,
  [KIN_BILL_WS_METHODS.list]: AuthKinChatScope,
  [KIN_BILL_WS_METHODS.keepRead]: AuthKinChatScope,
  [KIN_BILL_WS_METHODS.addAnyway]: AuthKinChatScope,
  [KIN_BILL_WS_METHODS.dismiss]: AuthKinChatScope,
  [KIN_BILL_WS_METHODS.readAgain]: AuthKinChatScope,
} as const;

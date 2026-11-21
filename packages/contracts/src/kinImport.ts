import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";
import { KinChatError, KinOrgId, KinPersonId } from "./kinChat.ts";
import { KinDealStage } from "./kinDeals.ts";
import { KinCurrency } from "./kinMoney.ts";
import { KinRecordKey } from "./kinWork.ts";

/**
 * Bringing clients, contacts and deals in from a spreadsheet saved as CSV: the owner level checks
 * a file with its columns, decides what Kin can't, imports it, and can take a batch away again.
 * The file travels as base64 in the request; the host keeps nothing of it but what it imports.
 */

export const KIN_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const KIN_IMPORT_MAX_ROWS = 50_000;
export const KIN_IMPORT_MAX_COLUMNS = 200;

/** Where a column of the file goes; `skip` leaves it out. */
const KIN_IMPORT_TARGETS = [
  "skip",
  "client.name",
  "client.kind",
  "client.address",
  "client.notes",
  "client.source",
  "client.tags",
  "contact.name",
  "contact.role",
  "contact.email",
  "contact.phone",
  "deal.title",
  "deal.stage",
  "deal.value",
  "deal.currency",
  "deal.expected",
  "owner",
] as const;
export const KinImportTarget = Schema.Literals(KIN_IMPORT_TARGETS);
export type KinImportTarget = typeof KinImportTarget.Type;

/** How the file writes its days: 2026-04-03, 03/04/2026 as day first, or 04/03/2026 month first. */
export const KinImportDateFormat = Schema.Literals(["ymd", "dmy", "mdy"]);
export type KinImportDateFormat = typeof KinImportDateFormat.Type;

const Text = Schema.String.check(Schema.isMaxLength(200));
const Batch = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,39}$/));
const Source = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/));

export const KinImportFile = Schema.Struct({
  name: Text,
  /** The file's bytes in base64. */
  data: Schema.String.check(Schema.isMaxLength(Math.ceil(KIN_IMPORT_MAX_FILE_BYTES / 3) * 4 + 4)),
});
export type KinImportFile = typeof KinImportFile.Type;

export const KinImportMapping = Schema.Struct({
  /** One per column of the file, in its order. */
  columns: Schema.Array(KinImportTarget).check(Schema.isMaxLength(KIN_IMPORT_MAX_COLUMNS)),
  /** For deal values written without a currency; never assumed. */
  currency: Schema.optional(KinCurrency),
  dateFormat: Schema.optional(KinImportDateFormat),
});
export type KinImportMapping = typeof KinImportMapping.Type;

/** `same` the client Kin found, `new` a client of its own, `skip` leave its rows out, or a client's key. */
export const KinImportClientDecision = Schema.Union([
  Schema.Literals(["same", "new", "skip"]),
  KinRecordKey,
]);
export type KinImportClientDecision = typeof KinImportClientDecision.Type;

export const KinImportDecisions = Schema.Struct({
  /** By the file's client (`source`). */
  clients: Schema.optional(
    Schema.Record(Source, KinImportClientDecision).check(Schema.isMaxProperties(5_000)),
  ),
  /** By a stage as the file writes it: one of the company's stage ids, or `skip`. */
  stages: Schema.optional(Schema.Record(Text, Text).check(Schema.isMaxProperties(200))),
});
export type KinImportDecisions = typeof KinImportDecisions.Type;

export const KinImportCheckInput = Schema.Struct({
  orgId: KinOrgId,
  file: KinImportFile,
  /** Absent: Kin proposes one from the header row and checks nothing yet. */
  mapping: Schema.optional(KinImportMapping),
  decisions: Schema.optional(KinImportDecisions),
});
export type KinImportCheckInput = typeof KinImportCheckInput.Type;

export const KinImportLeftOut = Schema.Struct({
  /** The file's line, from 1; null for the file as a whole. */
  line: Schema.NullOr(NonNegativeInt),
  reason: Schema.String,
});
export type KinImportLeftOut = typeof KinImportLeftOut.Type;

export const KinImportCounts = Schema.Struct({
  prospects: NonNegativeInt,
  clients: NonNegativeInt,
  contacts: NonNegativeInt,
  deals: NonNegativeInt,
});
export type KinImportCounts = typeof KinImportCounts.Type;

export const KinImportCheck = Schema.Struct({
  /** Named after the file's contents, so the same file imports as the same batch. */
  batch: Batch,
  rows: NonNegativeInt,
  columns: Schema.Array(
    Schema.Struct({
      header: Schema.String,
      sample: Schema.String,
      target: KinImportTarget,
      /** Why Kin leaves it out although it knows the header. */
      note: Schema.optional(Schema.String),
    }),
  ),
  mapping: KinImportMapping,
  /** What Kin asks before it checks: a currency for values without one, and how days are written. */
  asks: Schema.Struct({
    currency: Schema.Boolean,
    dateFormat: Schema.Boolean,
    dateExamples: Schema.Array(Schema.String),
  }),
  /** False until a mapping is given: the counts and lists below are empty. */
  checked: Schema.Boolean,
  will: KinImportCounts,
  matched: NonNegativeInt,
  /** Clients of the file that are ones Kin has: how it knows, and what it already had. */
  matches: Schema.Array(
    Schema.Struct({
      source: Source,
      name: Schema.String,
      key: KinRecordKey,
      existing: Schema.String,
      by: Schema.Literals(["email", "domain", "name"]),
      detail: Schema.String,
      decision: KinImportClientDecision,
      /** What Kin had already, so it keeps its own. */
      kept: Schema.Array(Schema.String),
    }),
  ),
  /** Close to a client Kin has, never merged by itself. */
  decide: Schema.Array(
    Schema.Struct({
      source: Source,
      name: Schema.String,
      rows: NonNegativeInt,
      candidates: Schema.Array(Schema.Struct({ key: KinRecordKey, name: Schema.String })),
      decision: Schema.NullOr(KinImportClientDecision),
    }),
  ),
  /** Stages the file names that aren't the company's. */
  stages: Schema.Array(
    Schema.Struct({ value: Schema.String, rows: NonNegativeInt, decision: Schema.NullOr(Text) }),
  ),
  companyStages: Schema.Array(KinDealStage),
  /** Offered first when Kin asks the currency of amounts written without one. */
  homeCurrency: KinCurrency,
  /** Rows naming someone who isn't on the team: whoever imports looks after them. */
  ownersUnknown: NonNegativeInt,
  leftOut: Schema.Array(KinImportLeftOut),
  more: NonNegativeInt,
  notImported: Schema.Array(Schema.Struct({ header: Schema.String, reason: Schema.String })),
  /** Every decision is made: Import may run. */
  ready: Schema.Boolean,
});
export type KinImportCheck = typeof KinImportCheck.Type;

export const KinImportApplyInput = Schema.Struct({
  orgId: KinOrgId,
  file: KinImportFile,
  mapping: KinImportMapping,
  decisions: Schema.optional(KinImportDecisions),
  /** The batch the check named: a different file is refused. */
  batch: Batch,
});
export type KinImportApplyInput = typeof KinImportApplyInput.Type;

export const KinImportApplied = Schema.Struct({
  batch: Batch,
  added: KinImportCounts,
  matched: NonNegativeInt,
  /** Fields filled in on clients and contacts Kin had, which had none. */
  filled: NonNegativeInt,
  leftOut: Schema.Array(KinImportLeftOut),
  more: NonNegativeInt,
  noticed: Schema.Struct({ noNextStep: NonNegativeInt, datesPassed: NonNegativeInt }),
});
export type KinImportApplied = typeof KinImportApplied.Type;

export const KinImportUndoInput = Schema.Struct({ orgId: KinOrgId, batch: Batch });
export type KinImportUndoInput = typeof KinImportUndoInput.Type;
export const KinImportUndone = Schema.Struct({
  batch: Batch,
  removed: Schema.Struct({
    clients: NonNegativeInt,
    contacts: NonNegativeInt,
    deals: NonNegativeInt,
    other: NonNegativeInt,
  }),
  /** Filled fields emptied again. */
  restored: NonNegativeInt,
  /** What stays, and why: changed since, or in use. */
  kept: Schema.Array(Schema.Struct({ key: Schema.String, reason: Schema.String })),
});
export type KinImportUndone = typeof KinImportUndone.Type;

export const KinImportRunsInput = Schema.Struct({ orgId: KinOrgId });
export type KinImportRunsInput = typeof KinImportRunsInput.Type;
export const KinImportRun = Schema.Struct({
  batch: Batch,
  file: Schema.NullOr(Schema.String),
  by: KinPersonId,
  at: IsoDateTime,
  added: Schema.Struct({
    clients: NonNegativeInt,
    contacts: NonNegativeInt,
    deals: NonNegativeInt,
    other: NonNegativeInt,
  }),
  undone: Schema.NullOr(Schema.Struct({ at: IsoDateTime, by: KinPersonId })),
  /**
   * The import stopped part way, when the host stopped: its first `done` of `of` rows are in, and
   * importing the file again brings the rest. Absent from older hosts.
   */
  stopped: Schema.optional(Schema.Struct({ done: NonNegativeInt, of: NonNegativeInt })),
  /** An undo of it stopped part way, as above: `done` of `of` records taken away. */
  undoStopped: Schema.optional(Schema.Struct({ done: NonNegativeInt, of: NonNegativeInt })),
});
export type KinImportRun = typeof KinImportRun.Type;
/** A check, import or undo going on now, and how far it is: rows for the first two, records for an undo. */
export const KinImportRunning = Schema.Struct({
  action: Schema.Literals(["check", "apply", "undo"]),
  batch: Batch,
  file: Schema.NullOr(Schema.String),
  by: KinPersonId,
  at: IsoDateTime,
  done: NonNegativeInt,
  of: NonNegativeInt,
});
export type KinImportRunning = typeof KinImportRunning.Type;
export const KinImportRuns = Schema.Struct({
  runs: Schema.Array(KinImportRun),
  /** Absent from older hosts. */
  running: Schema.optional(Schema.Array(KinImportRunning)),
});
export type KinImportRuns = typeof KinImportRuns.Type;

const KIN_IMPORT_WS_METHODS = {
  check: "kin.import.check",
  apply: "kin.import.apply",
  undo: "kin.import.undo",
  runs: "kin.import.runs",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
export const KinImportRpcs = [
  Rpc.make(KIN_IMPORT_WS_METHODS.check, {
    payload: KinImportCheckInput,
    success: KinImportCheck,
    error,
  }),
  Rpc.make(KIN_IMPORT_WS_METHODS.apply, {
    payload: KinImportApplyInput,
    success: KinImportApplied,
    error,
  }),
  Rpc.make(KIN_IMPORT_WS_METHODS.undo, {
    payload: KinImportUndoInput,
    success: KinImportUndone,
    error,
  }),
  Rpc.make(KIN_IMPORT_WS_METHODS.runs, {
    payload: KinImportRunsInput,
    success: KinImportRuns,
    error,
  }),
] as const;

export const KIN_IMPORT_RPC_SCOPES = {
  // The owner level only; the service decides from the session (`importFile.ts`).
  [KIN_IMPORT_WS_METHODS.check]: AuthKinChatScope,
  [KIN_IMPORT_WS_METHODS.apply]: AuthKinChatScope,
  [KIN_IMPORT_WS_METHODS.undo]: AuthKinChatScope,
  [KIN_IMPORT_WS_METHODS.runs]: AuthKinChatScope,
} as const;

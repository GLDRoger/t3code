import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthSettingsWriteScope, EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChatError, KinLabelText, KinOrgId, KinTrimmedText } from "./kinChat.ts";
import { KinCompanyProfileSetInput, KinListFieldType, KinNumberingRule } from "./kinFinance.ts";
import { KinCurrency, KinDay, KinListId, KinMoney } from "./kinMoney.ts";
import { KinRecordKey, KinRecordState } from "./kinWork.ts";

/**
 * Moving a company's records into Kin: one versioned JSON file, `import.json`, with the files it
 * names under `files/` beside it, uploaded as one ZIP or read from a folder on the host. Every
 * row has a `source` id unique in its section; Kin keys what it makes by batch and source id, so
 * running the same file again adds only what is new and never changes what someone edited since.
 */

const Label = KinLabelText.check(Schema.isMaxLength(60));
const Line = KinTrimmedText.check(Schema.isMaxLength(500));
const Notes = Schema.String.check(Schema.isMaxLength(4_000));
const Title = KinTrimmedText.check(Schema.isMaxLength(280));
/** What the old system called a row; unique within its section. */
export const KinImportSourceId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/),
);
/** A day, `2026-04-01`, or a time with its offset, `2026-04-01T09:30:00Z`. */
const When = Schema.String.check(
  Schema.isPattern(
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/,
  ),
);
/** A plain decimal in major units, `1234.50`: never a float, never with grouping. */
const Amount = Schema.String.check(Schema.isPattern(/^\d{1,15}(?:\.\d{1,6})?$/));
const MoneyValue = Schema.Struct({ amount: Amount, currency: KinCurrency });
/**
 * A list field's value: text, a choice or a day as a string, `owner` for a person field, a
 * client's or project's `source` id for a link field, or an amount. Files come by `files`.
 */
const FieldValue = Schema.Union([Line, MoneyValue]);
const MAX_ROWS = 100_000;
const rows = <S extends Schema.Top>(row: S) =>
  Schema.optional(Schema.Array(row).check(Schema.isMaxLength(MAX_ROWS)));

const StateNames = Schema.Struct({
  open: Schema.optional(Label),
  doing: Schema.optional(Label),
  waiting: Schema.optional(Label),
  done: Schema.optional(Label),
  dropped: Schema.optional(Label),
});

/**
 * A list the entries need, in `list_define`'s terms: made when the org has no list `list`, and
 * otherwise only added to (fields, choices, categories). Never renamed, narrowed or removed.
 */
export const KinImportList = Schema.Struct({
  list: KinListId,
  template: Schema.optional(Schema.Literals(["expenses", "invoices", "dates"])),
  name: Schema.optional(Label),
  noun: Schema.optional(Label),
  prefix: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9]{0,5}$/))),
  fields: Schema.optional(
    Schema.Array(
      Schema.Struct({
        label: Label,
        type: KinListFieldType,
        choices: Schema.optional(Schema.Array(Label).check(Schema.isMaxLength(30))),
        link: Schema.optional(Schema.Literals(["clients", "projects"])),
        sensitive: Schema.optional(Schema.Boolean),
      }),
    ).check(Schema.isMaxLength(20)),
  ),
  categories: Schema.optional(Schema.Array(Label).check(Schema.isMaxLength(30))),
  categoryLabels: Schema.optional(
    Schema.Record(Schema.String, Label).check(Schema.isMaxProperties(30)),
  ),
  states: Schema.optional(Schema.Array(KinRecordState).check(Schema.isMinLength(1))),
  stateNames: Schema.optional(StateNames),
  amount: Schema.optional(Schema.Boolean),
  currency: Schema.optional(KinCurrency),
  sensitive: Schema.optional(Schema.Boolean),
  /** Entries are paid over time, as invoices are. */
  payments: Schema.optional(Schema.Boolean),
  dueLabel: Schema.optional(Label),
  dateLabel: Schema.optional(Label),
  numbering: Schema.optional(KinNumberingRule),
});
export type KinImportList = typeof KinImportList.Type;

export const KinImportClient = Schema.Struct({
  source: KinImportSourceId,
  name: Title,
  kind: Schema.optional(Schema.Literals(["client", "vendor"])),
  state: Schema.optional(Schema.Literals(["open", "dropped"])),
  gstin: Schema.optional(Line),
  address: Schema.optional(Line),
  terms: Schema.optional(Line),
  placeOfSupply: Schema.optional(Line),
  notes: Schema.optional(Notes),
  sensitive: Schema.optional(Schema.Boolean),
  createdAt: Schema.optional(When),
});
export type KinImportClient = typeof KinImportClient.Type;

export const KinImportProject = Schema.Struct({
  source: KinImportSourceId,
  name: Title,
  client: Schema.optional(KinImportSourceId),
  state: Schema.optional(Schema.Literals(["open", "done", "dropped"])),
  target: Schema.optional(When),
  notes: Schema.optional(Notes),
  sensitive: Schema.optional(Schema.Boolean),
  createdAt: Schema.optional(When),
  closedAt: Schema.optional(When),
});
export type KinImportProject = typeof KinImportProject.Type;

/** One entry of Work or of a defined list. Entries belong to the owner who imports them. */
export const KinImportEntry = Schema.Struct({
  source: KinImportSourceId,
  list: KinListId,
  title: Title,
  state: Schema.optional(KinRecordState),
  category: Schema.optional(Label),
  client: Schema.optional(KinImportSourceId),
  project: Schema.optional(KinImportSourceId),
  due: Schema.optional(When),
  /** When it happened or was issued; a defined list's own date. */
  date: Schema.optional(When),
  amount: Schema.optional(Amount),
  /** Default: the list's currency. */
  currency: Schema.optional(KinCurrency),
  notes: Schema.optional(Notes),
  fields: Schema.optional(
    Schema.Record(Schema.String, FieldValue).check(Schema.isMaxProperties(20)),
  ),
  sensitive: Schema.optional(Schema.Boolean),
  /** A number it was already issued, kept as it is; Kin's own numbering continues past it. */
  number: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9/-]{1,16}$/))),
  createdAt: Schema.optional(When),
  closedAt: Schema.optional(When),
});
export type KinImportEntry = typeof KinImportEntry.Type;

/** Money received against an entry paid over time, recorded as the owner's Record payment does. */
export const KinImportPayment = Schema.Struct({
  source: KinImportSourceId,
  entry: KinImportSourceId,
  amount: Amount,
  currency: Schema.optional(KinCurrency),
  paidOn: KinDay,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type KinImportPayment = typeof KinImportPayment.Type;

/** A file kept on an entry, from `files/<path>`, checked against its SHA-256. */
export const KinImportFile = Schema.Struct({
  source: KinImportSourceId,
  entry: KinImportSourceId,
  /** The entry's file field; default its list's first one. */
  field: Schema.optional(Schema.String.check(Schema.isMaxLength(40))),
  name: KinTrimmedText.check(Schema.isMaxLength(200)),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type KinImportFile = typeof KinImportFile.Type;

const { orgId: _orgId, rev: _rev, ...companyFields } = KinCompanyProfileSetInput.fields;

export const KinImportDocument = Schema.Struct({
  format: Schema.Literal("kin-import"),
  version: Schema.Literal(1),
  /** Names this import; every row is keyed `import:<batch>:<source>`. */
  batch: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,39}$/)),
  /** Where it came from, as the owner would say it. */
  source: Schema.optional(Label),
  /** The last day the old system was kept up; open entries older than it are flagged. */
  asOf: Schema.optional(KinDay),
  /** Fills company details Kin has none of; bank details are never imported. */
  company: Schema.optional(Schema.Struct(companyFields)),
  lists: Schema.optional(Schema.Array(KinImportList).check(Schema.isMaxLength(50))),
  clients: rows(KinImportClient),
  projects: rows(KinImportProject),
  entries: rows(KinImportEntry),
  payments: rows(KinImportPayment),
  files: rows(KinImportFile),
});
export type KinImportDocument = typeof KinImportDocument.Type;

export const KinImportSection = Schema.Literals([
  "file",
  "company",
  "lists",
  "clients",
  "projects",
  "entries",
  "payments",
  "files",
]);
export type KinImportSection = typeof KinImportSection.Type;

export const KinImportProblem = Schema.Struct({
  section: KinImportSection,
  source: Schema.NullOr(Schema.String),
  reason: Schema.String,
});
export type KinImportProblem = typeof KinImportProblem.Type;

/** Per section: new, imported before and untouched, or imported before and changed in Kin since. */
export const KinImportCounts = Schema.Struct({
  create: NonNegativeInt,
  unchanged: NonNegativeInt,
  /** Already in Kin under the same name, made there: used, not made again. */
  matched: NonNegativeInt,
  changed: NonNegativeInt,
  problems: NonNegativeInt,
});
export type KinImportCounts = typeof KinImportCounts.Type;

export const KinImportReport = Schema.Struct({
  batch: Schema.String,
  asOf: Schema.NullOr(KinDay),
  /** False for a plan, which writes nothing. */
  applied: Schema.Boolean,
  lists: Schema.Array(
    Schema.Struct({
      list: KinListId,
      name: Schema.String,
      action: Schema.Literals(["create", "extend", "exists"]),
      /** Fields, choices and categories it adds. */
      adds: Schema.Array(Schema.String),
    }),
  ),
  company: Schema.Array(
    Schema.Struct({
      field: Schema.String,
      action: Schema.Literals(["fill", "same", "differs", "not_imported"]),
    }),
  ),
  clients: KinImportCounts,
  projects: KinImportCounts,
  entries: KinImportCounts,
  payments: KinImportCounts,
  files: KinImportCounts,
  /** Imported entries someone changed in Kin since: left as they are, with their payments and files. */
  changed: Schema.Array(Schema.Struct({ source: Schema.String, key: KinRecordKey })),
  /** The file's entries and payments by list and currency, to check against the old system. */
  money: Schema.Array(
    Schema.Struct({
      list: KinListId,
      entries: NonNegativeInt,
      total: KinMoney,
      paid: KinMoney,
    }),
  ),
  /** Open entries dated before `asOf`, by list, with the oldest one's day. */
  stale: Schema.Array(
    Schema.Struct({ list: KinListId, open: NonNegativeInt, oldest: Schema.NullOr(KinDay) }),
  ),
  problems: Schema.Array(KinImportProblem),
  /** Problems past the ones listed. */
  moreProblems: NonNegativeInt,
});
export type KinImportReport = typeof KinImportReport.Type;

/** A ZIP of `import.json` and `files/`, uploaded with the attachment upload this session asked for. */
export const KinImportInput = Schema.Struct({
  orgId: KinOrgId,
  upload: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type KinImportInput = typeof KinImportInput.Type;

const KIN_IMPORT_WS_METHODS = {
  plan: "kin.import.plan",
  apply: "kin.import.apply",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
// Owner only. No agent tool reaches these: a model never bulk-writes the books.
export const KinImportRpcs = [
  Rpc.make(KIN_IMPORT_WS_METHODS.plan, {
    payload: KinImportInput,
    success: KinImportReport,
    error,
  }),
  Rpc.make(KIN_IMPORT_WS_METHODS.apply, {
    payload: KinImportInput,
    success: KinImportReport,
    error,
  }),
] as const;

export const KIN_IMPORT_RPC_SCOPES = {
  [KIN_IMPORT_WS_METHODS.plan]: AuthSettingsWriteScope,
  [KIN_IMPORT_WS_METHODS.apply]: AuthSettingsWriteScope,
} as const;

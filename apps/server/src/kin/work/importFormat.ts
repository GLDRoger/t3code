import {
  calendarTimeMillis,
  KinCurrency,
  KinDay,
  KinLabelText,
  KinWritableListFieldType,
  KinListId,
  KinNumberingRule,
  KinRecordState,
  KinTrimmedText,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * The file `kin import` reads: JSON Lines, so a company's whole history streams through in
 * bounded memory. The first line names the batch and the lists; every line after it is one
 * client, project, entry, contact or deal, and a row may point only at rows above it or imported
 * before.
 */

const Label = KinLabelText.check(Schema.isMaxLength(60));
const Line = KinTrimmedText.check(Schema.isMaxLength(500));
const Notes = Schema.String.check(Schema.isMaxLength(4_000));
const Title = KinTrimmedText.check(Schema.isMaxLength(280));
const SourceId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/));
/** A day, `2026-04-01`, or a time with its offset, `2026-04-01T09:30:00Z`. */
const When = Schema.String.check(
  Schema.isPattern(
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/,
  ),
  Schema.makeFilter((value) => Number.isFinite(calendarTimeMillis(value)), {
    expected: "a real calendar day or time with its offset",
  }),
);
/** A plain decimal in major units, `1234.50`: never a float, never with grouping. */
const Amount = Schema.String.check(Schema.isPattern(/^\d{1,15}(?:\.\d{1,6})?$/));
const EntryAmount = Schema.String.check(Schema.isPattern(/^-?\d{1,15}(?:\.\d{1,6})?$/));
/** Text, a choice or a day; `owner` for a person field; a client's or project's source id for a link. */
const FieldValue = Schema.Union([Line, Schema.Struct({ amount: Amount, currency: KinCurrency })]);

export const ImportList = Schema.Struct({
  list: KinListId,
  template: Schema.optional(Schema.Literals(["expenses", "invoices", "dates"])),
  name: Schema.optional(Label),
  noun: Schema.optional(Label),
  prefix: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9]{0,5}$/))),
  fields: Schema.optional(
    Schema.Array(
      Schema.Struct({
        label: Label,
        type: KinWritableListFieldType,
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
  stateNames: Schema.optional(
    Schema.Struct({
      open: Schema.optional(Label),
      doing: Schema.optional(Label),
      waiting: Schema.optional(Label),
      done: Schema.optional(Label),
      dropped: Schema.optional(Label),
    }),
  ),
  amount: Schema.optional(Schema.Boolean),
  currency: Schema.optional(KinCurrency),
  sensitive: Schema.optional(Schema.Boolean),
  payments: Schema.optional(Schema.Boolean),
  dueLabel: Schema.optional(Label),
  dateLabel: Schema.optional(Label),
  numbering: Schema.optional(KinNumberingRule),
});
export type ImportList = typeof ImportList.Type;

export const ImportHeader = Schema.Struct({
  format: Schema.Literal("kin-import"),
  version: Schema.Literal(1),
  /** Every row is keyed `import:<batch>:<kind>:<source>`; undo takes a batch away whole. */
  batch: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,39}$/)),
  source: Schema.optional(Label),
  /** The last day the old system was kept up; open entries from before it get a note. */
  asOf: Schema.optional(KinDay),
  lists: Schema.optional(Schema.Array(ImportList).check(Schema.isMaxLength(50))),
});
export type ImportHeader = typeof ImportHeader.Type;

const Key = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9]{0,7}-[1-9]\d{0,8}$/));
const Person = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

export const ImportClient = Schema.Struct({
  source: SourceId,
  name: Title,
  kind: Schema.optional(Schema.Literals(["client", "vendor", "prospect"])),
  /** A client Kin has, by key: it gains only the fields it lacks, and nothing is made. */
  match: Schema.optional(Key),
  /** Who looks after it, a person on the team by id; else whoever imports. */
  owner: Schema.optional(Person),
  /** Where it came from, in the company's own words. */
  cameFrom: Schema.optional(Line),
  tags: Schema.optional(Schema.Array(Label).check(Schema.isMaxLength(20))),
  state: Schema.optional(Schema.Literals(["open", "dropped"])),
  gstin: Schema.optional(Line),
  address: Schema.optional(Line),
  terms: Schema.optional(Line),
  placeOfSupply: Schema.optional(Line),
  notes: Schema.optional(Notes),
  sensitive: Schema.optional(Schema.Boolean),
  createdAt: Schema.optional(When),
});
export type ImportClient = typeof ImportClient.Type;

export const ImportProject = Schema.Struct({
  source: SourceId,
  name: Title,
  client: Schema.optional(SourceId),
  state: Schema.optional(Schema.Literals(["open", "done", "dropped"])),
  target: Schema.optional(When),
  notes: Schema.optional(Notes),
  sensitive: Schema.optional(Schema.Boolean),
  createdAt: Schema.optional(When),
  closedAt: Schema.optional(When),
});
export type ImportProject = typeof ImportProject.Type;

export const ImportPayment = Schema.Struct({
  source: SourceId,
  amount: Amount,
  currency: Schema.optional(KinCurrency),
  paidOn: KinDay,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type ImportPayment = typeof ImportPayment.Type;

export const ImportEntry = Schema.Struct({
  source: SourceId,
  list: KinListId,
  title: Title,
  state: Schema.optional(KinRecordState),
  category: Schema.optional(Label),
  client: Schema.optional(SourceId),
  project: Schema.optional(SourceId),
  due: Schema.optional(When),
  date: Schema.optional(When),
  amount: Schema.optional(EntryAmount),
  currency: Schema.optional(KinCurrency),
  notes: Schema.optional(Notes),
  fields: Schema.optional(
    Schema.Record(Schema.String, FieldValue).check(Schema.isMaxProperties(20)),
  ),
  sensitive: Schema.optional(Schema.Boolean),
  steps: Schema.optional(
    Schema.Array(Schema.Struct({ title: Schema.String, done: Schema.Boolean })),
  ),
  urgent: Schema.optional(Schema.Boolean),
  /** The number it was issued; Kin's own numbering continues past it. */
  number: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9/-]{1,32}$/))),
  createdAt: Schema.optional(When),
  closedAt: Schema.optional(When),
  /** Money received against it, recorded as Record payment does. */
  payments: Schema.optional(Schema.Array(ImportPayment).check(Schema.isMaxLength(500))),
  /** An amount far above the rest of its list, or an invoice issued after its due day, is right. */
  confirmed: Schema.optional(Schema.Boolean),
  /** An agent's suggestion nobody has kept: restored as one, in no figure until it is kept. */
  suggested: Schema.optional(Schema.Boolean),
});
export type ImportEntry = typeof ImportEntry.Type;

/** A person at a client above it or imported before; `match` fills one Kin has. */
export const ImportContact = Schema.Struct({
  source: SourceId,
  client: SourceId,
  name: Title,
  role: Schema.optional(Line),
  /** Main first, as `contactDetails.ts` keeps them. */
  emails: Schema.optional(Schema.Array(Line).check(Schema.isMaxLength(20))),
  phones: Schema.optional(Schema.Array(Line).check(Schema.isMaxLength(20))),
  notes: Schema.optional(Notes),
  match: Schema.optional(Key),
});
export type ImportContact = typeof ImportContact.Type;

/** An open deal, made through Deals as any other: a stage the company has, never a new one. */
export const ImportDeal = Schema.Struct({
  source: SourceId,
  client: SourceId,
  title: Title,
  stage: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/)),
  value: Schema.optional(Schema.Struct({ amount: Amount, currency: KinCurrency })),
  /** Its expected day, a day in the company's zone. */
  expected: Schema.optional(KinDay),
  owner: Schema.optional(Person),
  cameFrom: Schema.optional(Line),
  notes: Schema.optional(Notes),
});
export type ImportDeal = typeof ImportDeal.Type;

export const ImportRow = Schema.Union([
  Schema.Struct({ client: ImportClient }),
  Schema.Struct({ project: ImportProject }),
  Schema.Struct({ entry: ImportEntry }),
  Schema.Struct({ contact: ImportContact }),
  Schema.Struct({ deal: ImportDeal }),
]);
export type ImportRow = typeof ImportRow.Type;

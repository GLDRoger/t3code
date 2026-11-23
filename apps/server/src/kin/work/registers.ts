import * as KinShell from "../shell/KinShell.ts";
import { sectionOfList, sectionOfRegister } from "../shell/sections.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KinChatError,
  KinCurrency,
  KinListDefinition,
  KinListField,
  KinListFieldKey,
  KinNumberingRule,
  type KinOrgId,
  type KinRecord,
  type KinRecordDetail,
  KinRecordState,
  isCalendarDay,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { ownerLevelSql } from "../people/KinAccess.ts";
import {
  fieldText,
  type FieldValue,
  isMoney,
  LISTS,
  WATCHED_NUMBER_FIELDS,
  TEAM_LIST_RESERVED,
  type ListName,
  parseFields,
  sensitiveFields,
} from "./lists.ts";
import {
  type CompanyMoney,
  companyMoneyState,
  countryBefore,
  homeCurrency,
} from "./companyProfile.ts";
import { regionOf } from "./region.ts";
import {
  FUNDED_BY,
  fundedByRefusal,
  fundingKeyRefusal,
  REIMBURSEMENT_FIELDS,
} from "./reimbursement.ts";
import { companyRegion, NEUTRAL_PAID_WITH } from "./statements/statementRegion.ts";
import { dayIn, isCurrency } from "./money.ts";
import { cardAnswer } from "./ownerCards.ts";
import { countedEntry } from "./recordRows.ts";
import { seenBy, type KinViewer } from "./teamView.ts";
import { keySentSql } from "../chat/keySent.ts";

/**
 * KinRegisters: what a list is. Work and the light CRM are fixed in code; every other list,
 * the three presets included, is a definition stored with its register and changed only by
 * adding: a field is retired, never removed, so no entry loses a value.
 */

export type FieldDef = KinListField;
export type FieldType = FieldDef["type"];
export const PRESET_IDS = ["expenses", "invoices", "dates", "receipts", "quotes"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60));
const StateLabels = Schema.Struct({
  open: Schema.optional(Label),
  doing: Schema.optional(Label),
  waiting: Schema.optional(Label),
  done: Schema.optional(Label),
  dropped: Schema.optional(Label),
});
/** A list's definition as stored; its name and key prefix are the register's own columns. */
export const StoredDefinition = Schema.Struct({
  noun: Label,
  states: Schema.Array(KinRecordState).check(Schema.isMinLength(1)),
  stateLabels: StateLabels,
  defaultState: KinRecordState,
  categories: Schema.Array(Label).check(Schema.isMaxLength(30)),
  fields: Schema.Array(KinListField).check(Schema.isMaxLength(20)),
  remindOn: KinListDefinition.fields.remindOn,
  check: KinListDefinition.fields.check,
  sensitive: Schema.Boolean,
  team: KinListDefinition.fields.team,
  teamSince: KinListDefinition.fields.teamSince,
  amount: Schema.Boolean,
  currency: KinCurrency,
  /** Made while the company's country wasn't chosen: takes the company's currency once it is. */
  currencyPending: Schema.optional(Schema.Literal(true)),
  dueLabel: Schema.optional(Label),
  dateLabel: Schema.optional(Label),
  categoryLabels: Schema.optional(Schema.Record(Schema.String, Label)),
  /** Entries are paid over time; Invoices are whether or not this says so. */
  payments: Schema.optional(Schema.Literal(true)),
  numbering: Schema.optional(KinNumberingRule),
});
export type StoredDefinition = typeof StoredDefinition.Type;
const DefinitionJson = Schema.fromJsonString(StoredDefinition);
const decodeStored = Schema.decodeUnknownOption(StoredDefinition);
/** A label as one line; ones stored before control characters were refused read so too. */
const plain = (text: string) => text.replace(/\p{Cc}/gu, " ").trim();
const decodeDefinition = (json: string) =>
  Option.flatMap(
    Option.liftThrowable(() =>
      JSON.parse(json, (_key, value: unknown) =>
        typeof value === "string" ? plain(value) : value,
      ),
    )(),
    decodeStored,
  );
export const encodeDefinition = Schema.encodeEffect(DefinitionJson);

export type ListDef = StoredDefinition & {
  readonly id: string;
  readonly builtIn: ListName | null;
  readonly name: string;
  readonly prefix: string;
  readonly archivedAt: number | null;
  readonly rev: number;
};

const field = (
  key: string,
  label: string,
  type: FieldType,
  more: Partial<Omit<FieldDef, "key" | "label" | "type">> = {},
): FieldDef => ({ key, label, type, sensitive: type === "money", ...more });

/** The three lists money and the calendar read, by these ids; each is created in chat by a yes. */
export const PRESETS: Record<
  PresetId,
  Omit<StoredDefinition, "currency"> & { name: string; prefix: string }
> = {
  expenses: {
    name: "Expenses",
    prefix: "EXP",
    noun: "expense",
    states: ["open", "done", "dropped"],
    stateLabels: { open: "To pay", done: "Paid", dropped: "Void" },
    defaultState: "done",
    categories: [
      "travel",
      "software",
      "hardware",
      "office",
      "meals",
      "contractors",
      "rent",
      "fees",
      "taxes",
      "salaries",
      "other",
    ],
    fields: [
      field("vendor", "Vendor", "text"),
      field("tax", "Tax paid", "money"),
      // The company's region replaces these with its own ways (`presetFor`).
      field("paidWith", "Paid with", "choice", { choices: NEUTRAL_PAID_WITH }),
      field("paidBy", "Paid by", "person"),
      field("receipt", "Receipt", "file", { sensitive: true }),
      // Who funded it, and whether the company owes a partner back (`reimbursement.ts`).
      ...REIMBURSEMENT_FIELDS,
    ],
    sensitive: true,
    amount: true,
    dueLabel: "Due",
    dateLabel: "Paid on",
  },
  invoices: {
    name: "Invoices",
    prefix: "INV",
    noun: "invoice",
    states: ["open", "waiting", "done", "dropped"],
    stateLabels: { open: "Draft", waiting: "Issued", done: "Paid", dropped: "Void" },
    defaultState: "waiting",
    categories: [],
    fields: [
      field("number", "Invoice number", "text"),
      field("tax", "Tax", "money"),
      field("file", "Invoice file", "file", { sensitive: true }),
    ],
    sensitive: true,
    amount: true,
    dueLabel: "Due",
    dateLabel: "Issued",
    payments: true,
    numbering: { prefix: "INV", series: "financial_year", width: 3 },
  },
  // Money received: against an invoice's payment, or an advance before any invoice exists.
  receipts: {
    name: "Receipts",
    prefix: "RCT",
    noun: "receipt",
    states: ["open", "waiting", "dropped"],
    stateLabels: { open: "Draft", waiting: "Issued", dropped: "Void" },
    defaultState: "open",
    categories: [],
    fields: [
      field("number", "Receipt number", "text"),
      field("towards", "Towards", "text"),
      field("mode", "Mode", "choice", {
        choices: ["bank transfer", "upi", "cheque", "cash", "card", "other"],
      }),
      field("reference", "Reference", "text"),
      field("invoice", "Invoice", "text"),
      field("payment", "Payment", "text"),
      field("file", "Receipt file", "file", { sensitive: true }),
    ],
    sensitive: true,
    amount: true,
    dueLabel: "Due",
    dateLabel: "Received on",
    numbering: { prefix: "RCT", series: "financial_year", width: 3 },
  },
  // What was offered before an invoice: numbered in its own series, valid until its due day.
  quotes: {
    name: "Quotes",
    prefix: "QT",
    noun: "quote",
    states: ["open", "waiting", "done", "dropped"],
    stateLabels: { open: "Draft", waiting: "Sent", done: "Accepted", dropped: "Void" },
    defaultState: "open",
    categories: [],
    fields: [
      field("number", "Quote number", "text"),
      field("tax", "Tax", "money"),
      field("file", "Quote file", "file", { sensitive: true }),
    ],
    sensitive: true,
    amount: true,
    dueLabel: "Valid until",
    dateLabel: "Dated",
    numbering: { prefix: "QT", series: "financial_year", width: 3 },
  },
  dates: {
    name: "Dates",
    prefix: "DT",
    noun: "date",
    states: ["open", "doing", "waiting", "done", "dropped"],
    stateLabels: {
      open: "Upcoming",
      doing: "In progress",
      waiting: "With accountant",
      done: "Filed",
      dropped: "Not applicable",
    },
    defaultState: "open",
    // India's; `presetFor` puts each company's own country's filings in their place.
    categories: ["gst", "tds", "income tax", "company", "payroll", "renewal", "other"],
    categoryLabels: { gst: "GST", tds: "TDS" },
    fields: [field("form", "Form", "text"), field("period", "Period", "text")],
    sensitive: false,
    // A renewal's fee or a filing's tax due; most dates have none.
    amount: true,
    dueLabel: "Due",
  },
};

const STATE_NAMES: Record<string, string> = {
  open: "Open",
  doing: "Doing",
  waiting: "Waiting",
  done: "Done",
  dropped: "Dropped",
};
export const stateLabel = (def: ListDef, state: string) =>
  def.stateLabels[state as keyof ListDef["stateLabels"]] ?? STATE_NAMES[state] ?? state;

/** The Dates template's categories in every country; its own filings come first. */
const DATE_CATEGORIES = ["income tax", "company", "payroll", "renewal", "other"];

/**
 * A template as a company gets it: an expense is paid the ways its country pays (`paidWith` of
 * its currency's region), and its Dates start with its country's filings. Lists already made
 * keep their choices.
 */
const presetFor = (
  id: PresetId,
  money: Pick<CompanyMoney, "homeCurrency" | "country">,
  countryPending = false,
) => {
  const preset = PRESETS[id];
  // A company still waiting on its country has only the placeholder's, so it gets no country's ways.
  const paidWith =
    (countryPending ? undefined : companyRegion(money.homeCurrency)?.paidWith) ?? NEUTRAL_PAID_WITH;
  const filings = regionOf(money.country)?.filings ?? [];
  return {
    ...preset,
    ...(id === "dates"
      ? {
          categories: [
            ...filings.map(([key]) => key),
            ...DATE_CATEGORIES.filter((key) => filings.every(([own]) => own !== key)),
          ],
          categoryLabels: Object.fromEntries(filings),
        }
      : {}),
    fields: preset.fields.map((field) =>
      field.key === "paidWith" ? { ...field, choices: paidWith } : field,
    ),
  };
};

/** A template's definition, its amounts in `currency` (the company's home currency). */
export const presetDefinition = (
  id: PresetId,
  currency: string,
  country: string | null = countryBefore(currency),
) => ({
  ...presetFor(id, { homeCurrency: currency, country }),
  currency,
});

/** Work and the light CRM as definitions, so every list reads the same way. */
const builtInDef = (name: ListName, currency: string): ListDef => {
  const list = LISTS[name];
  const sensitive = sensitiveFields(name);
  return {
    id: name,
    builtIn: name,
    name: list.name,
    prefix: list.prefix,
    noun: list.noun,
    states: list.states,
    stateLabels: {},
    defaultState: "open",
    categories: list.categories,
    fields: list.fields.map((key) =>
      field(key, key, "text", { sensitive: sensitive.includes(key) }),
    ),
    sensitive: false,
    amount: false,
    currency,
    ...(name === "work"
      ? { dueLabel: "Due" }
      : name === "projects"
        ? { dueLabel: "Target" }
        : name === "deals"
          ? { dueLabel: "Expected" }
          : {}),
    archivedAt: null,
    rev: 1,
  };
};
export const isBuiltIn = (id: string): id is ListName => Object.hasOwn(LISTS, id);
const isPreset = (id: string): id is PresetId => (PRESET_IDS as ReadonlyArray<string>).includes(id);
/** An Invoices draft: not issued yet, so nobody owes it. */
export const isInvoiceDraft = (list: string, state: KinRecordState) =>
  list === "invoices" && state === "open";
/** Whether an entry in `state` owes its balance: not closed, and not an Invoices draft. */
export const owesIn = (def: ListDef, state: KinRecordState) =>
  state !== "done" && state !== "dropped" && !isInvoiceDraft(def.id, state);
/**
 * Where a new entry with no state asked for starts: an invoice is Issued once it has a number or
 * an issue day on or before today, else Draft; an expense is Paid only on or before today, else To pay.
 */
export const startState = (
  def: ListDef,
  entry: {
    readonly dateAt: number | null;
    readonly numbered: boolean;
    readonly now: number;
    readonly zone: string;
  },
): KinRecordState => {
  const fallback = def.states.includes("open") ? "open" : def.defaultState;
  if (def.id === "invoices" && def.defaultState === "waiting")
    return entry.numbered ||
      (entry.dateAt !== null && dayIn(entry.dateAt, entry.zone) <= dayIn(entry.now, entry.zone))
      ? "waiting"
      : fallback;
  if (def.id === "expenses" && def.defaultState === "done" && entry.dateAt !== null)
    return dayIn(entry.dateAt, entry.zone) > dayIn(entry.now, entry.zone) ? fallback : "done";
  return def.defaultState;
};
/** The state an entry paid over time returns to while something is still unpaid on it. */
export const owedState = (def: ListDef) =>
  (["waiting", "open", "doing"] as const).find((state) => def.states.includes(state));

type RegisterRow = {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly definitionJson: string;
  readonly archivedAt: number | null;
  readonly rev: number;
};
const fromRow = (row: RegisterRow): ListDef | undefined =>
  Option.match(decodeDefinition(row.definitionJson), {
    onNone: () => undefined,
    onSome: (definition) => ({
      ...definition,
      // A preset list made before these existed reads as the preset does now.
      ...presetExtras(row.id, definition),
      id: row.id,
      builtIn: null,
      name: plain(row.name),
      prefix: row.prefix,
      archivedAt: row.archivedAt,
      rev: row.rev,
    }),
  });
/**
 * The labels to store from `labels`, where `null` or the category itself shows it as stored. A
 * preset's label is kept cleared as the category itself, so the preset's doesn't come back.
 */
export const storedCategoryLabels = (
  id: string,
  labels: Readonly<Record<string, string | null | undefined>>,
) =>
  Object.fromEntries(
    Object.entries(labels).flatMap(([category, label]): ReadonlyArray<[string, string]> =>
      label !== null && label !== undefined && label !== category
        ? [[category, label]]
        : isPreset(id) && PRESETS[id].categoryLabels?.[category] !== undefined
          ? [[category, category]]
          : [],
    ),
  );
/** A company's own labels for its template's categories, such as VAT, that India's template lacks. */
const ownLabels = (id: string, labels: Readonly<Record<string, string>> | undefined) => {
  const own = Object.entries(labels ?? {}).filter(
    ([category]) => !isPreset(id) || PRESETS[id].categoryLabels?.[category] === undefined,
  );
  return own.length === 0 ? {} : { categoryLabels: Object.fromEntries(own) };
};
const presetExtras = (id: string, definition: StoredDefinition) => {
  const preset = isPreset(id) ? PRESETS[id] : undefined;
  const categoryLabels = { ...preset?.categoryLabels, ...definition.categoryLabels };
  return {
    ...(Object.keys(categoryLabels).length === 0 ? {} : { categoryLabels }),
    ...(preset?.payments === true ? { payments: true as const } : {}),
  };
};
const registerColumns = (sql: SqlClient.SqlClient) => sql`register_id AS id, name,
  key_prefix AS prefix, definition_json AS "definitionJson", archived_at AS "archivedAt", rev`;

/** A list in this org: built in, or defined here. Another org's list reads as unknown. */
export const listDef = Effect.fn("KinRegisters.def")(function* (orgId: KinOrgId, id: string) {
  if (isBuiltIn(id)) return builtInDef(id, yield* homeCurrency(orgId));
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<RegisterRow>`SELECT ${registerColumns(sql)} FROM kin_registers
    WHERE org_id = ${orgId} AND register_id = ${id} AND built_in = 0 ORDER BY register_id`;
  return row === undefined ? undefined : fromRow(row);
});

/** Every list this org has defined, archived ones included, by name. */
const definedLists = Effect.fn("KinRegisters.defined")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<RegisterRow>`SELECT ${registerColumns(sql)} FROM kin_registers
    WHERE org_id = ${orgId} AND built_in = 0 ORDER BY lower(name), register_id`;
  return rows.flatMap((row) => {
    const def = fromRow(row);
    return def === undefined ? [] : [def];
  });
});

/** Built-in and defined lists by id: what a read needs to show any entry in its list's terms. */
export const allLists = Effect.fn("KinRegisters.all")(function* (orgId: KinOrgId) {
  const defined = yield* definedLists(orgId);
  const home = yield* homeCurrency(orgId);
  return new Map<string, ListDef>([
    ...(Object.keys(LISTS) as Array<ListName>).map(
      (name) => [name, builtInDef(name, home)] as const,
    ),
    ...defined.map((def) => [def.id, def] as const),
  ]);
});

export const unknownList = (id: string) =>
  new KinChatError({
    reason: "not_found",
    message: `There is no list ${id.slice(0, 40)}. A new list is proposed with list_define first.`,
  });
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
export const teamListRefusal = (id: string, name: string, sensitive?: boolean) =>
  TEAM_LIST_RESERVED.includes(id) || name.trim().toLowerCase() === "bank transactions"
    ? invalid("A built-in list can't be opened to the team.")
    : sensitive === true
      ? invalid("A sensitive list can't be opened to the team. Unmark it as sensitive first.")
      : undefined;

export const teamListChange = (
  def: Pick<StoredDefinition, "team" | "teamSince">,
  team: boolean | undefined,
  now: number,
) => {
  if (team === undefined || team === (def.team === true)) return {};
  return { team, teamSince: team ? now : (def.teamSince ?? null) };
};

const isChatError = Schema.is(KinChatError);

/** The entry's own fields that are confidential: money, files and any marked so, plus `amount`. */
export const sensitiveKeys = (def: ListDef): ReadonlyArray<string> => [
  ...(def.amount ? ["amount"] : []),
  ...def.fields.filter((one) => one.sensitive || one.type === "money").map((one) => one.key),
];

/** The same field and history projection for the host's list, sheet and agent tools. */
export const listEntryFor = <
  T extends KinRecord & Partial<Pick<KinRecordDetail, "changes" | "payments" | "files">>,
>(
  entry: T,
  list: string,
  def: ListDef | undefined,
  money: boolean,
) => {
  if (money || TEAM_LIST_RESERVED.includes(list)) return entry;
  const secrets = new Set([
    ...(def === undefined ? Object.keys(entry.fields ?? {}) : sensitiveKeys(def)),
    "amount",
    "payment",
    "payments",
  ]);
  const {
    amount: _amount,
    balance: _balance,
    received: _received,
    tdsDeducted: _tds,
    payments: _payments,
    files: _files,
    fields,
    changes,
    ...rest
  } = entry;
  const shown =
    fields === undefined
      ? undefined
      : Object.fromEntries(Object.entries(fields).filter(([key]) => !secrets.has(key)));
  return {
    ...rest,
    ...(shown === undefined || Object.keys(shown).length === 0 ? {} : { fields: shown }),
    ...(changes === undefined
      ? {}
      : {
          changes: changes.flatMap((change) => {
            const fields = change.fields.filter((field) => !secrets.has(field.field));
            return change.kind === "updated" && fields.length === 0 ? [] : [{ ...change, fields }];
          }),
        }),
  };
};

/**
 * Whether stored values fit a defined list's fields: known, not retired unless cleared, and of
 * the field's type. Ids in them are checked against this org by `verifyRefs`.
 */
export const checkFields = (
  def: ListDef,
  fields: Readonly<Record<string, FieldValue | null>>,
): KinChatError | undefined => {
  for (const [key, value] of Object.entries(fields)) {
    const spec = def.fields.find((one) => one.key === key);
    if (spec === undefined)
      return invalid(
        `${def.name} has no field ${key.slice(0, 40)}; it has ${def.fields
          .filter((one) => one.retired !== true)
          .map((one) => one.key)
          .join(", ")}.`,
      );
    if (value === null) continue;
    if (spec.retired === true) return invalid(`${spec.label} is retired from ${def.name}.`);
    const wrong = invalid(`${spec.label} takes ${describe(spec)}.`);
    switch (spec.type) {
      case "text":
        if (typeof value !== "string" || value.length > 500) return wrong;
        break;
      case "choice":
        if (typeof value !== "string" || !(spec.choices ?? []).includes(value)) return wrong;
        break;
      case "date":
        if (typeof value !== "string" || !isFieldDate(value)) return wrong;
        break;
      case "person":
        if (typeof value !== "string" || !/^(?:person|agent):.{1,120}$/.test(value)) return wrong;
        if (def.id === "expenses" && key === FUNDED_BY) {
          const refusal = fundedByRefusal(value);
          if (refusal !== undefined) return invalid(refusal);
        }
        break;
      case "link":
        if (spec.link === "list" || typeof value !== "string" || value.length > 120) return wrong;
        break;
      case "money":
        if (!isMoney(value) || !isCurrency(value.currency)) return wrong;
        break;
      case "file":
        if (!Array.isArray(value) || value.length === 0 || value.length > 10) return wrong;
        break;
      default:
        return wrong;
    }
  }
  return undefined;
};
/** A date field's value: a day, or a day and a time of day in the owner's zone. */
export const isFieldDate = (value: string) =>
  isCalendarDay(value.slice(0, 10)) &&
  (value.length === 10 || /^.{10}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value));

export const describe = (spec: FieldDef) =>
  spec.type === "choice"
    ? `one of ${(spec.choices ?? []).join(", ")}`
    : spec.type === "date"
      ? "a day such as 2026-11-20, or a day and time such as 2026-11-18T15:00"
      : spec.type === "person"
        ? '"you", "me" for whoever asked, "owner" or an agentId'
        : spec.type === "link"
          ? `a ${spec.link === "projects" ? "project" : "client"}'s key or name`
          : spec.type === "money"
            ? "an amount such as 4,200.50 or 12k"
            : spec.type === "file"
              ? "the names of files attached to this turn's messages"
              : "a line of text";

/**
 * The ids a defined list's fields hold, against rows of this org, inside the caller's write:
 * a person or agent here, a client or project here, a file on a message here.
 */
export const verifyRefs = Effect.fn("KinRegisters.verifyRefs")(function* (
  orgId: KinOrgId,
  def: ListDef,
  fields: Readonly<Record<string, FieldValue | null>>,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const [key, value] of Object.entries(fields)) {
    const spec = def.fields.find((one) => one.key === key);
    if (spec === undefined || value === null) continue;
    const gone = new KinChatError({
      reason: "not_found",
      message: `${spec.label}: no such ${spec.type === "file" ? "file" : spec.type === "person" ? "person or agent" : spec.link === "projects" ? "project" : "client"} here.`,
    });
    if (spec.type === "person" && typeof value === "string") {
      const [kind, ...rest] = value.split(":");
      const id = rest.join(":");
      const rows =
        kind === "agent"
          ? yield* sql`SELECT 1 FROM kin_agents WHERE org_id = ${orgId} AND agent_id = ${id}`
          : yield* sql`SELECT 1 FROM kin_people WHERE org_id = ${orgId} AND person_id = ${id}`;
      if (rows.length === 0) return yield* gone;
    }
    if (spec.type === "link" && typeof value === "string") {
      const rows = yield* sql`SELECT 1 FROM kin_records WHERE org_id = ${orgId}
        AND record_id = ${value} AND register_id = ${spec.link ?? "clients"}`;
      if (rows.length === 0) return yield* gone;
    }
    if (spec.type === "file" && Array.isArray(value)) {
      const ids = value as ReadonlyArray<string>;
      const rows = yield* sql`SELECT a.attachment_id FROM kin_message_attachments a
        JOIN kin_messages m ON m.org_id = a.org_id AND m.message_id = a.message_id
        WHERE a.org_id = ${orgId} AND a.attachment_id IN ${sql.in(ids)} AND m.status <> 'deleted'`;
      if (rows.length !== new Set(ids).size) return yield* gone;
    }
  }
});

/** How a list numbers what it issues; invoices, receipts and quotes without one take the preset's. */
export const numberingOf = (def: ListDef): KinNumberingRule | undefined =>
  def.numbering ??
  (def.builtIn === null && (def.id === "invoices" || def.id === "receipts" || def.id === "quotes")
    ? PRESETS[def.id].numbering
    : undefined);

/** A draft invoice: open with no number yet, so nothing is owed and nothing can be paid on it. */
export const isUnissuedDraft = Effect.fn("KinRegisters.isUnissuedDraft")(function* (
  orgId: KinOrgId,
  entry: { readonly registerId: string; readonly state: string; readonly fieldsJson: string },
) {
  if (entry.registerId !== "invoices" || entry.state !== "open") return false;
  const def = yield* listDef(orgId, "invoices");
  return (
    def !== undefined &&
    numberingOf(def) !== undefined &&
    (fieldText(parseFields(entry.fieldsJson), "number") ?? "").trim() === ""
  );
});

const shownLabels = (labels: Readonly<Record<string, string>> | undefined) => {
  const shown = Object.entries(labels ?? {}).filter(([category, label]) => label !== category);
  return shown.length === 0 ? {} : { categoryLabels: Object.fromEntries(shown) };
};
export const legacyFieldType = ({ type, link }: FieldDef) =>
  type === "number" || type === "yesno" || (type === "link" && link === "list") ? "text" : type;

/** The contract shape, with how many of its entries are open. */
export const toDefinition = (
  def: ListDef,
  open: number,
  accept?: ReadonlyArray<string>,
): KinListDefinition => {
  const numbering = numberingOf(def);
  return {
    list: def.id,
    name: def.name,
    prefix: def.prefix,
    builtIn: def.builtIn !== null,
    states: def.states,
    stateLabels: def.stateLabels,
    defaultState: def.defaultState,
    categories: def.categories,
    fields: def.fields.flatMap((field): ReadonlyArray<FieldDef> => {
      if (def.id === "goals" && WATCHED_NUMBER_FIELDS.includes(field.key)) return [];
      if (field.type === "link" && field.link === "list")
        return accept?.includes("list") ? [field] : [];
      const type = accept?.includes(field.type) ? field.type : legacyFieldType(field);
      return [field.type === type ? field : { ...field, type }];
    }),
    ...(def.remindOn !== undefined && accept?.includes("remindOn")
      ? { remindOn: def.remindOn }
      : {}),
    ...(def.check !== undefined && accept?.includes("check") ? { check: def.check } : {}),
    sensitive: def.sensitive,
    ...(def.team === undefined ? {} : { team: def.team, teamSince: def.teamSince ?? null }),
    amount: def.amount,
    currency: def.currency,
    ...shownLabels(def.categoryLabels),
    ...(def.payments === true ? { payments: true as const } : {}),
    ...(def.dueLabel === undefined ? {} : { dueLabel: def.dueLabel }),
    ...(def.dateLabel === undefined ? {} : { dateLabel: def.dateLabel }),
    ...(numbering === undefined ? {} : { numbering }),
    archivedAt:
      def.archivedAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(def.archivedAt)),
    rev: def.rev,
    open,
  };
};

// Defining a list in conversation: proposed in one turn, created from a later one the owner's
// answer in that chat woke. Proposals are by the lead and chat; nothing else creates one.

/** What a lead may propose: a new list, a preset, or fields and choices added to one. */
export type Draft = {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly definition: StoredDefinition;
};
export type Additions = {
  readonly fields: ReadonlyArray<FieldDef>;
  readonly categories: ReadonlyArray<string>;
  readonly choices: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly stateLabels: StoredDefinition["stateLabels"];
};
const Proposal = Schema.Union([
  Schema.TaggedStruct("new", {
    id: Schema.String,
    name: Schema.String,
    prefix: Schema.String,
    definition: StoredDefinition,
  }),
  Schema.TaggedStruct("extend", {
    id: Schema.String,
    fields: Schema.Array(KinListField),
    categories: Schema.Array(Schema.String),
    choices: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    stateLabels: StateLabels,
    team: KinListDefinition.fields.team,
  }),
]);
export type Proposal = typeof Proposal.Type;
const ProposalJson = Schema.fromJsonString(Proposal);
const encodeProposal = Schema.encodeEffect(ProposalJson);
const decodeProposal = Schema.decodeUnknownOption(ProposalJson);

const RESERVED_KEYS = new Set([
  "title",
  "state",
  "owner",
  "due",
  "date",
  "amount",
  "currency",
  "notes",
  "category",
  "client",
  "project",
  "side",
  "repeat",
  "sensitive",
  "suggested",
  "list",
  "key",
  "fields",
  "files",
  "repo",
  "waitingOn",
]);
const isFieldKey = Schema.is(KinListFieldKey);
/** `Paid by` is `paidBy`. */
export const keyFor = (label: string) => {
  const words = label
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  const key = words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join("")
    .replace(/^\d+/, "")
    .slice(0, 40);
  return isFieldKey(key) ? key : undefined;
};
/** `Leave requests` is `leave_requests`. */
const idFor = (name: string) => {
  const id = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+|_+$/g, "")
    .slice(0, 40);
  return /^[a-z][a-z0-9_]{1,39}$/.test(id) ? id : undefined;
};
const prefixFor = (name: string) =>
  name
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3) || "L";

/** Fields valid as a set: unique keys, none reserved, choices where they belong, money sensitive. */
const checkFieldDefs = (fields: ReadonlyArray<FieldDef>): KinChatError | undefined => {
  const keys = new Set<string>();
  if (fields.length > 20) return invalid("A list has at most 20 fields.");
  for (const spec of fields) {
    if (RESERVED_KEYS.has(spec.key))
      return invalid(
        `${spec.label} is one of every entry's own columns (${spec.key}); use that instead of a field.`,
      );
    if (keys.has(spec.key)) return invalid(`Two fields are both ${spec.key}.`);
    keys.add(spec.key);
    if (spec.type === "choice" && (spec.choices === undefined || spec.choices.length === 0))
      return invalid(`${spec.label} is a choice: give its choices.`);
    if (spec.type !== "choice" && spec.choices !== undefined)
      return invalid(`Only a choice field has choices; ${spec.label} is ${spec.type}.`);
    if ((spec.type === "link") !== (spec.link !== undefined))
      return invalid(`${spec.label}: a link field says whether it links clients or projects.`);
  }
  return undefined;
};

/** Adds to a definition, never takes away: new fields, categories, choices and state names. */
const extended = (def: StoredDefinition, additions: Additions) => {
  const fields = [...def.fields];
  for (const spec of additions.fields) {
    const existing = fields.find((one) => one.key === spec.key);
    if (existing !== undefined)
      return invalid(`${def.noun} already has ${spec.key}; add it under another name.`);
    fields.push(spec);
  }
  for (const [key, choices] of Object.entries(additions.choices)) {
    const index = fields.findIndex((one) => one.key === key);
    const spec = fields[index];
    if (spec === undefined || spec.type !== "choice")
      return invalid(`There is no choice field ${key.slice(0, 40)} to add choices to.`);
    fields[index] = { ...spec, choices: [...new Set([...(spec.choices ?? []), ...choices])] };
  }
  const next: StoredDefinition = {
    ...def,
    fields,
    categories: [...new Set([...def.categories, ...additions.categories])],
    stateLabels: { ...def.stateLabels, ...additions.stateLabels },
  };
  return checkFieldDefs(next.fields) ?? next;
};

/** What a proposal would make, checked now, so a yes never meets a refusal. */
const checkDraft = (draft: Draft): KinChatError | undefined => {
  const def = draft.definition;
  if (!def.states.includes(def.defaultState))
    return invalid(`A new ${def.noun} starts ${def.defaultState}, which the list doesn't have.`);
  if (!/^[A-Z][A-Z0-9]{0,5}$/.test(draft.prefix))
    return invalid("A key prefix is one to six capital letters or digits, such as LV.");
  // Built-in registers are written on first use, so their prefixes are reserved before then.
  if (isBuiltIn(draft.id) || Object.values(LISTS).some((list) => list.prefix === draft.prefix))
    return invalid(`The key prefix ${draft.prefix} is Kin's own. Propose another.`);
  if (!isCurrency(def.currency)) return invalid(`${def.currency} is not a currency code.`);
  const taken = draft.id === "expenses" ? fundingKeyRefusal(def.fields) : undefined;
  if (taken !== undefined) return invalid(taken);
  return checkFieldDefs(def.fields);
};

/** What a list is asked to be: `list_define`'s input, or an import's list. */
export type ListInput = {
  /** The list's id, where the caller names it; otherwise the template's, or one from the name. */
  readonly id?: string | undefined;
  readonly template?: PresetId | undefined;
  readonly list?: string | undefined;
  readonly name?: string | undefined;
  readonly noun?: string | undefined;
  readonly prefix?: string | undefined;
  readonly fields?:
    | ReadonlyArray<{
        readonly label: string;
        readonly type: FieldType;
        readonly choices?: ReadonlyArray<string> | undefined;
        readonly link?: "clients" | "projects" | undefined;
        readonly sensitive?: boolean | undefined;
      }>
    | undefined;
  readonly categories?: ReadonlyArray<string> | undefined;
  readonly states?: ReadonlyArray<KinRecordState> | undefined;
  readonly stateNames?: StoredDefinition["stateLabels"] | undefined;
  readonly amount?: boolean | undefined;
  readonly currency?: string | undefined;
  readonly sensitive?: boolean | undefined;
  readonly team?: boolean | undefined;
  readonly dueLabel?: string | undefined;
  readonly dateLabel?: string | undefined;
};

const fieldDefs = (fields: NonNullable<ListInput["fields"]>) => {
  const defs: Array<FieldDef> = [];
  for (const one of fields) {
    const label = plain(one.label);
    const key = keyFor(label);
    if (key === undefined) return invalid(`${one.label} needs a name made of letters.`);
    defs.push({
      key,
      label,
      type: one.type,
      ...(one.choices === undefined ? {} : { choices: one.choices.map(plain) }),
      ...(one.link === undefined ? {} : { link: one.link }),
      sensitive: one.type === "money" || one.type === "file" || one.sensitive === true,
    });
  }
  return defs;
};

/** The proposal a call describes: a preset with any extras, a new list, or additions to one. */
export const proposalFor = Effect.fn("KinRegisters.proposalFor")(function* (
  orgId: KinOrgId,
  input: ListInput,
) {
  const fields = fieldDefs(input.fields ?? []);
  if (!Array.isArray(fields)) return yield* fields;
  if (input.list !== undefined) {
    if (input.team === true) {
      const reserved = teamListRefusal(input.list, input.list);
      if (reserved !== undefined) return yield* reserved;
    }
    const def = yield* listDef(orgId, input.list);
    if (def === undefined) return yield* unknownList(input.list);
    if (def.builtIn !== null)
      return yield* invalid(`${def.name} is built in; its fields are fixed.`);
    if (input.team === true) {
      const refused = teamListRefusal(def.id, def.name, def.sensitive);
      if (refused !== undefined) return yield* refused;
    }
    // A field named again with new choices adds those choices to it.
    const choices: Record<string, ReadonlyArray<string>> = {};
    const added = fields.filter((one) => {
      const existing = def.fields.find((field) => field.key === one.key);
      if (existing?.type === "choice" && one.type === "choice") {
        choices[one.key] = one.choices ?? [];
        return false;
      }
      return true;
    });
    return {
      _tag: "extend",
      id: def.id,
      fields: added,
      categories: input.categories ?? [],
      choices,
      stateLabels: input.stateNames ?? {},
      ...(input.team === true || (input.team === false && def.team === true)
        ? { team: input.team }
        : {}),
    } satisfies Proposal;
  }
  const named =
    input.id ?? input.template ?? (input.name === undefined ? undefined : idFor(input.name));
  if (named === undefined)
    return yield* invalid("Name the list, start from a template, or say which list to add to.");
  if (input.team === true) {
    const reserved = teamListRefusal(named, input.name ?? named);
    if (reserved !== undefined) return yield* reserved;
  }
  const { pending, ...money } = yield* companyMoneyState(orgId);
  const home = money.homeCurrency;
  const preset = (PRESET_IDS as ReadonlyArray<string>).includes(named)
    ? presetFor(named as PresetId, money, pending)
    : undefined;
  if (preset === undefined && (isBuiltIn(named) || named === "docs"))
    return yield* invalid(`${input.name ?? named} is one of Kin's own lists already.`);
  const name = preset?.name ?? input.name ?? named;
  const amount = input.amount ?? preset?.amount ?? false;
  if (!amount && preset?.numbering !== undefined)
    return yield* invalid(
      `${name} entries are numbered when issued, and an issued one always carries its amount, so this list keeps amounts.`,
    );
  const states = input.states ?? preset?.states ?? ["open", "done", "dropped"];
  const definition: StoredDefinition = {
    noun: input.noun ?? preset?.noun ?? name.toLowerCase().replace(/s$/, ""),
    states,
    stateLabels: { ...preset?.stateLabels, ...input.stateNames },
    defaultState:
      preset !== undefined && states.includes(preset.defaultState)
        ? preset.defaultState
        : states.includes("open")
          ? "open"
          : states[0]!,
    categories: [...new Set([...(preset?.categories ?? []), ...(input.categories ?? [])])],
    ...ownLabels(named, preset?.categoryLabels),
    fields: [
      // A template's choice field named again with more choices keeps them, as on a list made already.
      ...(preset?.fields ?? []).map((had) => {
        const asked = fields.find((one) => one.key === had.key);
        return had.type === "choice" && asked?.type === "choice"
          ? { ...had, choices: [...new Set([...(had.choices ?? []), ...(asked.choices ?? [])])] }
          : had;
      }),
      ...fields.filter((one) => !(preset?.fields ?? []).some((field) => field.key === one.key)),
    ],
    sensitive: input.sensitive ?? preset?.sensitive ?? amount,
    ...(input.team === undefined ? {} : { team: input.team }),
    amount,
    currency: input.currency ?? home,
    ...(pending && input.currency === undefined ? { currencyPending: true as const } : {}),
    ...((input.dueLabel ?? preset?.dueLabel)
      ? { dueLabel: (input.dueLabel ?? preset?.dueLabel)! }
      : {}),
    ...((input.dateLabel ?? preset?.dateLabel)
      ? { dateLabel: (input.dateLabel ?? preset?.dateLabel)! }
      : {}),
  };
  if (!isCurrency(definition.currency))
    return yield* invalid(`${definition.currency} is not a currency code.`);
  const draft = {
    id: named,
    name,
    prefix: input.prefix ?? preset?.prefix ?? prefixFor(name),
    definition,
  };
  const refused =
    (definition.team === true ? teamListRefusal(named, name, definition.sensitive) : undefined) ??
    checkDraft(draft);
  if (refused !== undefined) return yield* refused;
  if ((yield* listDef(orgId, draft.id)) !== undefined)
    return yield* invalid(
      `There is already a list ${draft.name}; propose fields to add to it with list instead.`,
    );
  return { _tag: "new", ...draft } satisfies Proposal;
});

const proposalIdFor = (orgId: string, agentId: string, wakeupId: string, json: string) =>
  `lp_${NodeCrypto.createHash("sha256").update(`${orgId.length}:${orgId}${agentId}:${wakeupId}:${json}`).digest("hex").slice(0, 16)}`;

/** Records a lead's proposal in the chat its turn answers. The same one twice is one proposal. */
export const propose = Effect.fn("KinRegisters.propose")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: string;
  readonly wakeupId: string;
  readonly chatId: string;
  readonly proposal: Proposal;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const json = yield* encodeProposal(input.proposal);
  const [chat] = yield* sql<{ seq: number }>`SELECT last_seq AS seq FROM kin_chats
    WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
  if (chat === undefined) return yield* invalid("This turn has no chat to propose a list in.");
  // The same list asked again in this chat, from a later turn such as the owner's tap on it, is
  // that question still: one card. So is that list proposed again in one turn, however worded.
  // Only a no an owner or co-owner gave closes it.
  const [open] = yield* sql<{ proposalId: string; widgetId: string | null }>`
    SELECT p.proposal_id AS "proposalId", p.widget_id AS "widgetId"
    FROM kin_list_proposals p
    WHERE p.org_id = ${input.orgId} AND p.agent_id = ${input.agentId}
      AND p.chat_id = ${input.chatId} AND p.defined_at IS NULL
      AND (p.definition_json = ${json} OR (p.wakeup_id = ${input.wakeupId}
        AND p.register_id = ${input.proposal.id}
        AND p.extends_existing = ${input.proposal._tag === "extend" ? 1 : 0}))
    ORDER BY p.proposed_at DESC, p.proposal_id LIMIT 1`;
  if (
    open !== undefined &&
    (open.widgetId === null || (yield* cardAnswer(input.orgId, open.widgetId)) !== "no")
  )
    return open.proposalId;
  const proposalId = proposalIdFor(input.orgId, input.agentId, input.wakeupId, json);
  yield* sql`INSERT INTO kin_list_proposals (org_id, proposal_id, agent_id, chat_id, wakeup_id,
      register_id, extends_existing, definition_json, chat_seq, proposed_at)
    VALUES (${input.orgId}, ${proposalId}, ${input.agentId}, ${input.chatId}, ${input.wakeupId},
      ${input.proposal.id}, ${input.proposal._tag === "extend" ? 1 : 0}, ${json}, ${chat.seq},
      ${input.now})
    ON CONFLICT DO NOTHING`;
  return proposalId;
});

/** A proposal as stored, for what its card and its tool result show. */
export const storedProposal = Effect.fn("KinRegisters.storedProposal")(function* (
  orgId: KinOrgId,
  proposalId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ json: string }>`SELECT definition_json AS json
    FROM kin_list_proposals WHERE org_id = ${orgId} AND proposal_id = ${proposalId}`;
  return row === undefined ? undefined : Option.getOrUndefined(decodeProposal(row.json));
});

/** The card Kin put the proposal to the owner with; a retry keeps the first. */
export const attachCard = Effect.fn("KinRegisters.attachCard")(function* (input: {
  readonly orgId: KinOrgId;
  readonly proposalId: string;
  readonly widgetId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_list_proposals SET widget_id = ${input.widgetId}
    WHERE org_id = ${input.orgId} AND proposal_id = ${input.proposalId} AND widget_id IS NULL`;
});

/** The currency a list made now keeps; while the country isn't chosen, the company's once it is. */
export const listCurrency = Effect.fn("KinRegisters.listCurrency")(function* (orgId: KinOrgId) {
  const { pending, homeCurrency: currency } = yield* companyMoneyState(orgId);
  return pending ? { currency, currencyPending: true as const } : { currency };
});

/** Creates or extends the list `proposal` describes, now, in the caller's transaction. */
export const defineList = Effect.fn("KinRegisters.defineList")(function* (
  orgId: KinOrgId,
  proposal: Proposal,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  if (proposal._tag === "new") {
    const { currencyPending, teamSince: _teamSince, ...made } = proposal.definition;
    // A proposal from before the country was chosen, said yes to after, takes today's currency.
    const today = currencyPending === true ? yield* listCurrency(orgId) : undefined;
    const draft = {
      ...proposal,
      definition: {
        ...made,
        ...(today === undefined ? (currencyPending === true ? { currencyPending } : {}) : today),
        ...(made.team === true ? { teamSince: now } : {}),
      },
    };
    const refused =
      (made.team === true ? teamListRefusal(draft.id, draft.name, made.sensitive) : undefined) ??
      checkDraft(draft);
    if (refused !== undefined) return yield* refused;
    const taken = yield* sql<{ id: string; prefix: string }>`SELECT register_id AS id,
        key_prefix AS prefix FROM kin_registers WHERE org_id = ${orgId}
        AND (register_id = ${draft.id} OR key_prefix = ${draft.prefix}) ORDER BY register_id`;
    if (taken.length > 0)
      return yield* new KinChatError({
        reason: "conflict",
        message:
          taken[0]!.id === draft.id
            ? `There is already a list ${draft.name}. Propose adding fields to it instead.`
            : `The key prefix ${draft.prefix} is taken. Propose the list with another prefix.`,
      });
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
        created_at, definition_json, rev)
      VALUES (${orgId}, ${draft.id}, ${draft.name}, ${draft.prefix}, 0, ${now},
        ${yield* encodeDefinition(draft.definition)}, 1)`;
  } else {
    const def = yield* listDef(orgId, proposal.id);
    if (def === undefined || def.builtIn !== null) return yield* unknownList(proposal.id);
    if (proposal.team === true) {
      const refused = teamListRefusal(def.id, def.name, def.sensitive);
      if (refused !== undefined) return yield* refused;
    }
    const next = extended({ ...def, ...teamListChange(def, proposal.team, now) }, proposal);
    if (isChatError(next)) return yield* next;
    const taken = def.id === "expenses" ? fundingKeyRefusal(next.fields) : undefined;
    if (taken !== undefined) return yield* invalid(taken);
    yield* sql`UPDATE kin_registers SET definition_json = ${yield* encodeDefinition(next)},
        rev = rev + 1
      WHERE org_id = ${orgId} AND register_id = ${proposal.id}`;
  }
  yield* (yield* KinRefreshObserver).touch(orgId, "workLists");
});

/**
 * Creates or extends the list a proposal names, once the owner has answered it in this turn: by
 * tapping yes on the proposal's own card, or in a message of theirs in its chat written after it
 * (which may answer several proposals at once). A no on the card ends the proposal. One already
 * carried out returns its list again.
 */
export const carryOut = Effect.fn("KinRegisters.carryOut")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: string;
  readonly wakeupId: string;
  readonly proposalId: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    chatId: string;
    json: string;
    chatSeq: number;
    definedAt: number | null;
    registerId: string;
    widgetId: string | null;
  }>`SELECT p.chat_id AS "chatId", p.definition_json AS json, p.chat_seq AS "chatSeq",
      p.defined_at AS "definedAt", p.register_id AS "registerId", p.widget_id AS "widgetId"
    FROM kin_list_proposals p
    WHERE p.org_id = ${input.orgId} AND p.proposal_id = ${input.proposalId}
      AND p.agent_id = ${input.agentId}`;
  if (row === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No proposal ${input.proposalId.slice(0, 40)} of yours. Propose the list first.`,
    });
  if (row.definedAt !== null) return { id: row.registerId, created: false };
  const tapped = row.widgetId === null ? undefined : yield* cardAnswer(input.orgId, row.widgetId);
  if (tapped === "no")
    return yield* new KinChatError({
      reason: "not_allowed",
      message:
        "The owner said no to this proposal on its card, so nothing was created. Propose it again only if they ask for it.",
    });
  // Every person here is read from the stored event and the stored message both: a tap is an
  // owner's or co-owner's own tap row on this proposal's card, a message their own text after it.
  const answered = yield* sql`SELECT 1 FROM kin_events e
    JOIN kin_messages m ON m.org_id = e.org_id AND m.message_id = json_extract(e.json, '$.messageId')
      AND m.chat_id = json_extract(e.json, '$.chatId')
    WHERE e.org_id = ${input.orgId} AND e.agent_id = ${input.agentId}
      AND e.wakeup_id = ${input.wakeupId} AND m.chat_id = ${row.chatId}
      AND json_extract(e.json, '$.origin.personId') IS NULL
      AND json_extract(e.json, '$.provenance._tag') = 'human'
      AND json_extract(e.json, '$.provenance.personId') = m.author_person_id
      AND m.author_kind = 'human' AND ${sql.literal(ownerLevelSql("m.org_id", "m.author_person_id"))}
      AND NOT ${sql.literal(keySentSql("m.client_message_id"))}
      AND ((e.tag = 'chat.message' AND m.kind = 'text' AND m.seq > ${row.chatSeq})
        OR (e.tag = 'widget.action' AND m.kind = 'widget_action'
          AND m.widget_id = ${row.widgetId ?? ""} AND ${tapped === "yes" ? 1 : 0} = 1))
    LIMIT 1`;
  if (answered.length === 0)
    return yield* new KinChatError({
      reason: "not_allowed",
      message:
        "The owner hasn't answered this proposal yet. Wait for their yes on its card or in a message; nothing was created.",
    });
  const proposal = Option.getOrUndefined(decodeProposal(row.json));
  if (proposal === undefined) return yield* invalid("That proposal can no longer be read.");
  const register = proposal._tag === "new" ? proposal : yield* listDef(input.orgId, proposal.id);
  const payments =
    register === undefined
      ? undefined
      : "definition" in register
        ? register.definition.payments
        : register.payments;
  const section =
    sectionOfRegister({
      id: proposal.id,
      name: register?.name ?? null,
      payments: payments === true ? 1 : null,
    }) ?? sectionOfList(proposal.id);
  if (section !== null) {
    const shell = yield* KinShell.get(input.orgId);
    if (!KinShell.sectionOn(shell, section))
      return yield* invalid(
        `${KinShell.sectionName(shell, section)} is turned off for this company.`,
      );
  }
  yield* defineList(input.orgId, proposal, input.now);
  yield* sql`UPDATE kin_list_proposals SET defined_at = ${input.now}
    WHERE org_id = ${input.orgId} AND proposal_id = ${input.proposalId}`;
  return { id: proposal.id, created: true };
});

/**
 * The new list a card may create from a stored proposal, or why it can't now: a card only ever
 * creates, so an extension, or an id, prefix or name (any case) already in use, makes nothing.
 */
export const proposalToCreate = Effect.fn("KinRegisters.proposalToCreate")(function* (
  orgId: KinOrgId,
  json: string,
) {
  const proposal = Option.getOrUndefined(decodeProposal(json));
  if (proposal === undefined) return "the proposal can no longer be read";
  if (proposal._tag !== "new") return "it would change a list that exists, and a card only creates";
  const refused = checkDraft(proposal);
  if (refused !== undefined) return refused.message;
  const sql = yield* SqlClient.SqlClient;
  const lists = yield* sql<{ id: string; name: string; prefix: string }>`SELECT
      register_id AS id, name, key_prefix AS prefix FROM kin_registers
    WHERE org_id = ${orgId} ORDER BY register_id`;
  const name = proposal.name.trim().toLowerCase();
  // Kin's own lists are stored on first use, so their names are taken before then.
  const builtIn = Object.values(LISTS).find((list) => list.name.toLowerCase() === name);
  if (builtIn !== undefined) return `there is already a list “${builtIn.name}”`;
  const taken = lists.find(
    (list) =>
      list.id === proposal.id ||
      list.prefix === proposal.prefix ||
      list.name.trim().toLowerCase() === name,
  );
  if (taken === undefined) return proposal;
  return taken.prefix === proposal.prefix && taken.id !== proposal.id
    ? `the key prefix ${proposal.prefix} is taken`
    : `there is already a list “${taken.name}”`;
});

/** The list a stored proposal makes, by id. */
export const proposedList = (json: string) => Option.getOrUndefined(decodeProposal(json))?.id;

/**
 * Creates the list a proposal names from the owner's tap on a card that offered exactly it, in
 * the tap's transaction. The reason nothing was created, or undefined once it is.
 */
export const defineProposed = Effect.fn("KinRegisters.defineProposed")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: string;
  readonly proposalId: string;
  readonly definition: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ json: string; definedAt: number | null }>`SELECT
      definition_json AS json, defined_at AS "definedAt" FROM kin_list_proposals
    WHERE org_id = ${input.orgId} AND proposal_id = ${input.proposalId}
      AND agent_id = ${input.agentId}`;
  if (row === undefined || row.json !== input.definition) return "the proposal changed";
  if (row.definedAt !== null) return "the list was already made";
  const proposal = yield* proposalToCreate(input.orgId, row.json);
  if (typeof proposal === "string") return proposal;
  yield* defineList(input.orgId, proposal, input.now);
  yield* sql`UPDATE kin_list_proposals SET defined_at = ${input.now}
    WHERE org_id = ${input.orgId} AND proposal_id = ${input.proposalId}`;
  return undefined;
});

/**
 * Where a list lives among the clients' places, as they place it (`kinPlaceLists`): the
 * company's Subscriptions list in Money's Subscriptions, Kin's money lists in Money, its client
 * lists in Clients, every other in Docs.
 */
export const listPlace = Effect.fn("KinRegisters.place")(function* (orgId: KinOrgId, id: string) {
  const live = (yield* definedLists(orgId)).filter((def) => def.archivedAt === null);
  const subscriptions =
    live.find((def) => def.id === "subscriptions") ??
    live.find((def) => /subscription/i.test(def.name));
  const name = (yield* listDef(orgId, id))?.name ?? id;
  if (subscriptions?.id === id)
    return {
      place: "money",
      list: id,
      subscriptions: true,
      words: "Money → Subscriptions",
    } as const;
  const place = ["invoices", "expenses", "quotes"].includes(id)
    ? ("money" as const)
    : ["clients", "deals"].includes(id)
      ? ("clients" as const)
      : ("docs" as const);
  const words = { money: "Money", clients: "Clients", docs: "Docs" }[place];
  return { place, list: id, words: id === "clients" ? words : `${words} → ${name}` };
});

/** Open entries per list, for the definitions the owner sees. */
export const openCounts = Effect.fn("KinRegisters.openCounts")(function* (
  orgId: KinOrgId,
  /** For a person, only entries they see, and lists with none left out. */
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ id: string; open: number }>`SELECT r.register_id AS id,
      SUM(r.state NOT IN ('done', 'dropped')) AS open FROM kin_records r
    WHERE r.org_id = ${orgId} AND ${
      viewer._tag === "ownerLevel" ? sql`r.state NOT IN ('done', 'dropped')` : seenBy(sql, viewer)
    }
    GROUP BY r.register_id ORDER BY r.register_id`;
  return new Map(rows.map((row) => [row.id, row.open]));
});

export const countListStates = Effect.fn("KinRegisters.countListStates")(function* (
  orgId: KinOrgId,
  list: string,
  states: ReadonlyArray<KinRecordState>,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = ${list} AND r.state IN ${sql.in(states)}
      AND ${countedEntry(sql, states)}`;
  return row?.count ?? 0;
});

/** Lists a built-in recipe needs: made from the preset on first use, with no card to approve. */
const RECIPE_LISTS: ReadonlyArray<PresetId> = ["quotes", "invoices"];
export const isRecipeList = (id: string) => (RECIPE_LISTS as ReadonlyArray<string>).includes(id);

/** The list by id, making a recipe's list from its preset when this org has none yet. */
export const listOrPreset = Effect.fn("KinRegisters.listOrPreset")(function* (
  orgId: KinOrgId,
  id: string,
  now: number,
) {
  return isRecipeList(id)
    ? yield* presetList(orgId, id as PresetId, now)
    : yield* listDef(orgId, id);
});

/** A preset's list, made from the preset when this org has none yet: an owner-level person's own write. */
export const presetList = Effect.fn("KinRegisters.presetList")(function* (
  orgId: KinOrgId,
  id: PresetId,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const existing = yield* listDef(orgId, id);
  if (existing !== undefined) return existing;
  // One transaction, so a country saved meanwhile either rewrites this list or comes after it.
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const proposal = yield* proposalFor(orgId, { template: id });
      yield* defineList(orgId, proposal, now).pipe(
        // Two first quotes at once: the other made it, which is the same list.
        Effect.catchIf(
          (error) => isChatError(error) && error.reason === "conflict",
          () => Effect.void,
        ),
      );
      return yield* listDef(orgId, id);
    }),
  );
});

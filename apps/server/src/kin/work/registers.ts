// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KinChatError,
  KinCurrency,
  type KinListDefinition,
  KinListField,
  KinListFieldKey,
  KinNumberingRule,
  type KinOrgId,
  KinRecordState,
  isCalendarDay,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type FieldValue, isMoney, LISTS, type ListName, sensitiveFields } from "./lists.ts";
import { DEFAULT_CURRENCY, isCurrency } from "./money.ts";
import { cardAnswer } from "./ownerCards.ts";

/**
 * KinRegisters: what a list is. Work and the light CRM are fixed in code; every other list,
 * the three presets included, is a definition stored with its register and changed only by
 * adding: a field is retired, never removed, so no entry loses a value.
 */

export type FieldDef = KinListField;
export type FieldType = FieldDef["type"];
export const PRESET_IDS = ["expenses", "invoices", "dates"] as const;
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
  sensitive: Schema.Boolean,
  amount: Schema.Boolean,
  currency: KinCurrency,
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
export const PRESETS: Record<PresetId, StoredDefinition & { name: string; prefix: string }> = {
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
      "other",
    ],
    fields: [
      field("vendor", "Vendor", "text"),
      field("tax", "Tax paid", "money"),
      field("paidWith", "Paid with", "choice", { choices: ["card", "upi", "bank", "cash"] }),
      field("paidBy", "Paid by", "person"),
      field("receipt", "Receipt", "file", { sensitive: true }),
    ],
    sensitive: true,
    amount: true,
    currency: DEFAULT_CURRENCY,
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
    currency: DEFAULT_CURRENCY,
    dueLabel: "Due",
    dateLabel: "Issued",
    payments: true,
    numbering: { prefix: "INV", series: "financial_year", width: 3 },
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
    categories: ["gst", "tds", "income tax", "company", "payroll", "renewal", "other"],
    categoryLabels: { gst: "GST", tds: "TDS" },
    fields: [field("form", "Form", "text"), field("period", "Period", "text")],
    sensitive: false,
    amount: false,
    currency: DEFAULT_CURRENCY,
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

/** Work and the light CRM as definitions, so every list reads the same way. */
const builtInDef = (name: ListName): ListDef => {
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
    currency: DEFAULT_CURRENCY,
    ...(name === "work" ? { dueLabel: "Due" } : name === "projects" ? { dueLabel: "Target" } : {}),
    archivedAt: null,
    rev: 1,
  };
};
export const isBuiltIn = (id: string): id is ListName => Object.hasOwn(LISTS, id);
const isPreset = (id: string): id is PresetId => (PRESET_IDS as ReadonlyArray<string>).includes(id);
/** Whether an entry in `state` owes its balance: not closed, and not an Invoices draft. */
export const owesIn = (def: ListDef, state: KinRecordState) =>
  state !== "done" && state !== "dropped" && !(def.id === "invoices" && state === "open");
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
  if (isBuiltIn(id)) return builtInDef(id);
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
  return new Map<string, ListDef>([
    ...(Object.keys(LISTS) as Array<ListName>).map((name) => [name, builtInDef(name)] as const),
    ...defined.map((def) => [def.id, def] as const),
  ]);
});

export const unknownList = (id: string) =>
  new KinChatError({
    reason: "not_found",
    message: `There is no list ${id.slice(0, 40)}. A new list is proposed with list_define first.`,
  });
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const isChatError = Schema.is(KinChatError);

/** The entry's own fields that are confidential: money, files and any marked so, plus `amount`. */
export const sensitiveKeys = (def: ListDef): ReadonlyArray<string> => [
  ...(def.amount ? ["amount"] : []),
  ...def.fields.filter((one) => one.sensitive || one.type === "money").map((one) => one.key),
];

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
        if (typeof value !== "string" || !isCalendarDay(value)) return wrong;
        break;
      case "person":
        if (typeof value !== "string" || !/^(?:person|agent):.{1,120}$/.test(value)) return wrong;
        break;
      case "link":
        if (typeof value !== "string" || value.length > 120) return wrong;
        break;
      case "money":
        if (!isMoney(value) || !isCurrency(value.currency)) return wrong;
        break;
      case "file":
        if (!Array.isArray(value) || value.length === 0 || value.length > 10) return wrong;
        break;
    }
  }
  return undefined;
};
export const describe = (spec: FieldDef) =>
  spec.type === "choice"
    ? `one of ${(spec.choices ?? []).join(", ")}`
    : spec.type === "date"
      ? "a day such as 2026-11-20"
      : spec.type === "person"
        ? '"me", "owner" or an agentId'
        : spec.type === "link"
          ? `a ${spec.link === "projects" ? "project" : "client"}'s key or name`
          : spec.type === "money"
            ? "an amount such as 4,200 or 4.2 lakh"
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

/** How a list numbers what it issues; invoices defined before numbering existed take the preset's. */
export const numberingOf = (def: ListDef): KinNumberingRule | undefined =>
  def.numbering ??
  (def.id === "invoices" && def.builtIn === null ? PRESETS.invoices.numbering : undefined);

const shownLabels = (labels: Readonly<Record<string, string>> | undefined) => {
  const shown = Object.entries(labels ?? {}).filter(([category, label]) => label !== category);
  return shown.length === 0 ? {} : { categoryLabels: Object.fromEntries(shown) };
};
/** The contract shape, with how many of its entries are open. */
export const toDefinition = (
  def: ListDef,
  open: number,
  numbering = numberingOf(def),
): KinListDefinition => ({
  list: def.id,
  name: def.name,
  prefix: def.prefix,
  builtIn: def.builtIn !== null,
  states: def.states,
  stateLabels: def.stateLabels,
  defaultState: def.defaultState,
  categories: def.categories,
  fields: def.fields,
  sensitive: def.sensitive,
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
});

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
  if (!isCurrency(def.currency)) return invalid(`${def.currency} is not a currency code.`);
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
    const def = yield* listDef(orgId, input.list);
    if (def === undefined) return yield* unknownList(input.list);
    if (def.builtIn !== null)
      return yield* invalid(`${def.name} is built in; its fields are fixed.`);
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
    } satisfies Proposal;
  }
  const named =
    input.id ?? input.template ?? (input.name === undefined ? undefined : idFor(input.name));
  if (named === undefined)
    return yield* invalid("Name the list, start from a template, or say which list to add to.");
  const preset = (PRESET_IDS as ReadonlyArray<string>).includes(named)
    ? PRESETS[named as (typeof PRESET_IDS)[number]]
    : undefined;
  if (preset === undefined && (isBuiltIn(named) || named === "docs"))
    return yield* invalid(`${input.name ?? named} is one of Kin's own lists already.`);
  const name = preset?.name ?? input.name ?? named;
  const amount = input.amount ?? preset?.amount ?? false;
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
    fields: [
      ...(preset?.fields ?? []),
      ...fields.filter((one) => !(preset?.fields ?? []).some((field) => field.key === one.key)),
    ],
    sensitive: input.sensitive ?? preset?.sensitive ?? amount,
    amount,
    currency: input.currency ?? preset?.currency ?? "INR",
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
  const refused = checkDraft(draft);
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
  const proposalId = proposalIdFor(input.orgId, input.agentId, input.wakeupId, json);
  const [chat] = yield* sql<{ seq: number }>`SELECT last_seq AS seq FROM kin_chats
    WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
  if (chat === undefined) return yield* invalid("This turn has no chat to propose a list in.");
  yield* sql`INSERT INTO kin_list_proposals (org_id, proposal_id, agent_id, chat_id, wakeup_id,
      register_id, extends_existing, definition_json, chat_seq, proposed_at)
    VALUES (${input.orgId}, ${proposalId}, ${input.agentId}, ${input.chatId}, ${input.wakeupId},
      ${input.proposal.id}, ${input.proposal._tag === "extend" ? 1 : 0}, ${json}, ${chat.seq},
      ${input.now})
    ON CONFLICT DO NOTHING`;
  return proposalId;
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

/** Creates or extends the list `proposal` describes, now, in the caller's transaction. */
export const defineList = Effect.fn("KinRegisters.defineList")(function* (
  orgId: KinOrgId,
  proposal: Proposal,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  if (proposal._tag === "new") {
    const draft = { ...proposal };
    const refused = checkDraft(draft);
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
    const next = extended(def, proposal);
    if (isChatError(next)) return yield* next;
    yield* sql`UPDATE kin_registers SET definition_json = ${yield* encodeDefinition(next)},
        rev = rev + 1
      WHERE org_id = ${orgId} AND register_id = ${proposal.id}`;
  }
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
    owner: string;
  }>`SELECT p.chat_id AS "chatId", p.definition_json AS json, p.chat_seq AS "chatSeq",
      p.defined_at AS "definedAt", p.register_id AS "registerId", p.widget_id AS "widgetId",
      a.owner_person_id AS owner
    FROM kin_list_proposals p
    JOIN kin_agents a ON a.org_id = p.org_id AND a.agent_id = p.agent_id
    WHERE p.org_id = ${input.orgId} AND p.proposal_id = ${input.proposalId}
      AND p.agent_id = ${input.agentId}`;
  if (row === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No proposal ${input.proposalId.slice(0, 40)} of yours. Propose the list first.`,
    });
  if (row.definedAt !== null) return { id: row.registerId, created: false };
  const tapped =
    row.widgetId === null ? undefined : yield* cardAnswer(input.orgId, row.widgetId, row.owner);
  if (tapped === "no")
    return yield* new KinChatError({
      reason: "not_allowed",
      message:
        "The owner said no to this proposal on its card, so nothing was created. Propose it again only if they ask for it.",
    });
  // Every person here is read from the stored event and the stored message both: a tap is the
  // owner's own tap row on this proposal's card, a message is the owner's own text after it.
  const answered = yield* sql`SELECT 1 FROM kin_events e
    JOIN kin_messages m ON m.org_id = e.org_id AND m.message_id = json_extract(e.json, '$.messageId')
      AND m.chat_id = json_extract(e.json, '$.chatId')
    WHERE e.org_id = ${input.orgId} AND e.agent_id = ${input.agentId}
      AND e.wakeup_id = ${input.wakeupId} AND m.chat_id = ${row.chatId}
      AND json_extract(e.json, '$.origin.personId') IS NULL
      AND json_extract(e.json, '$.provenance._tag') = 'human'
      AND json_extract(e.json, '$.provenance.personId') = ${row.owner}
      AND m.author_kind = 'human' AND m.author_person_id = ${row.owner}
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
  yield* defineList(input.orgId, proposal, input.now);
  yield* sql`UPDATE kin_list_proposals SET defined_at = ${input.now}
    WHERE org_id = ${input.orgId} AND proposal_id = ${input.proposalId}`;
  return { id: proposal.id, created: true };
});

/** Open entries per list, for the definitions the owner sees. */
export const openCounts = Effect.fn("KinRegisters.openCounts")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ id: string; open: number }>`SELECT register_id AS id,
      COUNT(*) AS open FROM kin_records
    WHERE org_id = ${orgId} AND state NOT IN ('done', 'dropped')
    GROUP BY register_id ORDER BY register_id`;
  return new Map(rows.map((row) => [row.id, row.open]));
});

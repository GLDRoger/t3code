import { KinChatError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parseDocument } from "yaml";

import { parseAmount } from "../work/money.ts";
import { FUNCTIONS } from "./compute.ts";

/**
 * A recipe is a folder in the workspace: `RECIPE.md`, whose front matter says what it makes, the
 * inputs it takes and the fields Kin computes from them, and a `template.typ` that lays them out
 * (or, for `kind: table`, the sheets and columns Kin writes). Each input is the agent's, or read
 * by Kin from a stored row named by `from`; the server renders exactly the declared inputs.
 */

const ScalarType = Schema.Literals(["text", "integer", "decimal", "money", "date", "boolean"]);
type ScalarType = typeof ScalarType.Type;
const InputType = Schema.Literals([...ScalarType.literals, "month", "table"]);
export type InputType = typeof InputType.Type;
const Name = Schema.String.check(Schema.isPattern(/^[a-z][a-zA-Z0-9_]{0,39}$/));
const Declared = Schema.Struct({
  type: InputType,
  from: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
  required: Schema.optional(Schema.Boolean),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  columns: Schema.optional(Schema.Record(Name, ScalarType)),
  /** For `rows.*` and `payments`: the month input whose rows these are. */
  period: Schema.optional(Name),
});
const FileName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9{][A-Za-z0-9 ._(){}-]{0,99}$/));
const SheetDecl = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(31)),
  input: Name,
  file: Schema.optional(FileName),
  columns: Schema.Array(
    Schema.Struct({
      header: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
      field: Schema.String.check(Schema.isPattern(/^[a-z][a-zA-Z0-9_]{0,39}(?:\.currency)?$/)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  leaveOutOfTotals: Schema.optional(
    Schema.Struct({
      field: Name,
      values: Schema.Array(Schema.String).check(Schema.isMaxLength(20)),
    }),
  ),
});
export type Sheet = typeof SheetDecl.Type;
const FrontMatter = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,39}$/)),
  kind: Schema.optional(Schema.Literals(["typst", "table"])),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  list: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{1,39}$/))),
  numbered: Schema.optional(Schema.Boolean),
  sensitive: Schema.optional(Schema.Boolean),
  inputs: Schema.optional(Schema.Record(Name, Declared)),
  computed: Schema.optional(Schema.Record(Name, Schema.Unknown)),
  workbook: Schema.optional(FileName),
  sheets: Schema.optional(Schema.Array(SheetDecl).check(Schema.isMaxLength(20))),
  outputs: Schema.Array(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9*{][A-Za-z0-9 ._()*{}-]{0,99}$/)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
});
const decodeFrontMatter = Schema.decodeUnknownExit(FrontMatter);

export type InputDecl = {
  readonly name: string;
  readonly type: InputType;
  readonly from: string;
  readonly required: boolean;
  readonly description: string | undefined;
  readonly columns: Readonly<Record<string, ScalarType>>;
  readonly period: string | undefined;
};
export type Recipe = {
  readonly name: string;
  /** `typst`: `template.typ` makes each PDF output; `table`: Kin writes the declared sheets. */
  readonly kind: "typst" | "table";
  readonly title: string;
  readonly description: string;
  readonly list: string | null;
  readonly numbered: boolean;
  readonly sensitive: boolean;
  readonly inputs: ReadonlyArray<InputDecl>;
  /** Fields Kin works out, in order, each `{ <function>: <arguments> }` (`compute.ts`). */
  readonly computed: ReadonlyArray<readonly [string, unknown]>;
  readonly sheets: ReadonlyArray<Sheet>;
  readonly workbook: string | null;
  readonly outputs: ReadonlyArray<string>;
  /** The body: notes for an agent on when and how to use it. */
  readonly instructions: string;
};

const ENTRY_KEYS = ["key", "title", "state", "amount", "tax", "date", "due", "notes", "number"];
const CLIENT_KEYS = ["name", "address", "gstin", "placeOfSupply", "terms"];
const COMPANY_KEYS = ["legalName", "tradeName", "address", "gstin", "pan", "placeOfSupply", "sac"];
const BANK_KEYS = ["accountName", "accountNumber", "ifsc", "bankName", "branch", "upi"];
const SYSTEM_KEYS = ["number", "draft", "today"];
/** What a `rows.<list>` table may hold per row; a recipe names the columns it wants. */
const ROW_COLUMNS = [
  "key",
  "title",
  "state",
  "amount",
  "tax",
  "date",
  "due",
  "client",
  "category",
  "number",
];
const PAYMENT_COLUMNS = ["invoice", "client", "amount", "paidOn"];

/** Where a value comes from, parsed; `undefined` for a `from` this server doesn't read. */
export type Source =
  | { readonly _tag: "agent" }
  | { readonly _tag: "entry"; readonly key: string }
  | { readonly _tag: "entryField"; readonly field: string }
  | { readonly _tag: "client"; readonly key: string }
  | { readonly _tag: "company"; readonly key: string }
  | { readonly _tag: "rows"; readonly list: string }
  | { readonly _tag: "payments" }
  | { readonly _tag: "system"; readonly key: string };
export const sourceOf = (from: string): Source | undefined => {
  if (from === "agent") return { _tag: "agent" };
  if (from === "payments") return { _tag: "payments" };
  const [head, ...rest] = from.split(".");
  const tail = rest.join(".");
  switch (head) {
    case "entry":
      if (rest[0] === "fields" && rest.length === 2 && /^[a-z][a-zA-Z0-9]{0,39}$/.test(rest[1]!))
        return { _tag: "entryField", field: rest[1]! };
      return ENTRY_KEYS.includes(tail) ? { _tag: "entry", key: tail } : undefined;
    case "client":
      return CLIENT_KEYS.includes(tail) ? { _tag: "client", key: tail } : undefined;
    case "company":
      return COMPANY_KEYS.includes(tail) ||
        (rest[0] === "bank" && rest.length === 2 && BANK_KEYS.includes(rest[1]!))
        ? { _tag: "company", key: tail }
        : undefined;
    case "rows":
      return /^[a-z][a-z0-9_]{1,39}$/.test(tail) ? { _tag: "rows", list: tail } : undefined;
    case "system":
      return SYSTEM_KEYS.includes(tail) ? { _tag: "system", key: tail } : undefined;
    default:
      return undefined;
  }
};

export type RecipeProblem = { readonly _tag: "RecipeProblem"; readonly reason: string };
const problem = (reason: string): RecipeProblem => ({ _tag: "RecipeProblem", reason });

/** `RECIPE.md` as text: its front matter checked, every `from` one this server reads. */
export const parseRecipe = (text: string): Recipe | RecipeProblem => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) return problem("RECIPE.md has no front matter between --- lines");
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length > 0) return problem("RECIPE.md's front matter isn't valid YAML");
  const raw: unknown = document.toJS({ maxAliasCount: 0 });
  const decoded = decodeFrontMatter(raw);
  if (decoded._tag === "Failure")
    return problem("RECIPE.md's front matter is missing or has a wrong field");
  const front = decoded.value;
  const inputs: Array<InputDecl> = [];
  for (const [name, declared] of Object.entries(front.inputs ?? {})) {
    const from = declared.from ?? "agent";
    const source = sourceOf(from);
    if (source === undefined)
      return problem(`input ${name} reads from ${from}, which Kin doesn't supply`);
    const isTable = source._tag === "rows" || source._tag === "payments";
    if (isTable !== (declared.type === "table") && source._tag !== "agent")
      return problem(`input ${name}: its type doesn't match what ${from} gives`);
    if (declared.type === "month" && source._tag !== "agent")
      return problem(`input ${name}: a month is the agent's to give`);
    if (declared.type === "table" && Object.keys(declared.columns ?? {}).length === 0)
      return problem(`input ${name} is a table with no columns`);
    if (isTable) {
      const allowed = source._tag === "payments" ? PAYMENT_COLUMNS : ROW_COLUMNS;
      const extra = Object.keys(declared.columns ?? {}).filter(
        (column) => !allowed.includes(column) && !column.startsWith("field_"),
      );
      if (extra.length > 0)
        return problem(`input ${name} asks for columns Kin doesn't have: ${extra.join(", ")}`);
      const period = declared.period === undefined ? undefined : front.inputs?.[declared.period];
      if (period?.type !== "month")
        return problem(`input ${name} needs period: a month input of the agent's`);
    }
    inputs.push({
      name,
      type: declared.type,
      from,
      required: declared.required ?? source._tag !== "agent",
      description: declared.description,
      columns: declared.columns ?? {},
      period: declared.period,
    });
  }
  const kind = front.kind ?? "typst";
  // In the order RECIPE.md writes them: a field may use any field before it.
  const rawComputed: unknown =
    typeof raw === "object" && raw !== null ? Reflect.get(raw, "computed") : undefined;
  const computed = Object.entries(
    typeof rawComputed === "object" && rawComputed !== null ? rawComputed : {},
  );
  for (const [name, spec] of computed) {
    if (front.inputs?.[name] !== undefined)
      return problem(`computed field ${name} has an input's name`);
    const fn = typeof spec === "object" && spec !== null ? Object.keys(spec)[0] : undefined;
    if (fn === undefined || !(FUNCTIONS as ReadonlyArray<string>).includes(fn))
      return problem(`computed field ${name} names none of ${FUNCTIONS.join(", ")}`);
  }
  const sheets = front.sheets ?? [];
  if (kind === "typst") {
    if (sheets.length > 0 || front.workbook !== undefined)
      return problem("sheets and workbook are for kind: table");
    const bad = front.outputs.find((output) => !/^[^*{}]+\.pdf$/.test(output));
    if (bad !== undefined)
      return problem(`output ${bad}: a typst recipe names each PDF it makes, such as invoice.pdf`);
  } else {
    if (sheets.length === 0) return problem("a table recipe declares its sheets");
    if (computed.length > 0) return problem("computed fields are for kind: typst");
    for (const sheet of sheets) {
      const input = inputs.find((one) => one.name === sheet.input);
      if (input?.type !== "table") return problem(`sheet ${sheet.name} reads no table input`);
      const missing = sheet.columns.find(
        (column) => !Object.hasOwn(input.columns, column.field.split(".")[0]!),
      );
      if (missing !== undefined)
        return problem(`sheet ${sheet.name}: ${sheet.input} has no column ${missing.field}`);
    }
  }
  return {
    name: front.name,
    kind,
    title: front.title,
    description: front.description,
    list: front.list ?? null,
    numbered: front.numbered ?? false,
    sensitive: front.sensitive ?? false,
    inputs,
    computed,
    sheets,
    workbook: front.workbook ?? null,
    outputs: front.outputs,
    instructions: match[2]!.trim(),
  };
};

/** Whether a recipe reads the entry the job is for, so the job must name one. */
export const needsEntry = (recipe: Recipe) =>
  recipe.list !== null ||
  recipe.inputs.some((input) => {
    const source = sourceOf(input.from);
    return source?._tag === "entry" || source?._tag === "entryField" || source?._tag === "client";
  });

export type Money = { readonly minor: number; readonly currency: string };
export type Value =
  | string
  | number
  | boolean
  | null
  | Money
  | ReadonlyArray<string>
  | ReadonlyArray<Readonly<Record<string, string | number | boolean | Money | null>>>;

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const MAX_TEXT = 60_000;
const MAX_ROWS = 500;

/** A real calendar day as YYYY-MM-DD from year 1000: `Date.parse` takes 31 February as 3 March. */
const isDay = (value: string) => {
  const match = /^([1-9]\d{3})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days;
};

/** An agent's value for one declared input, checked and made exact; a string error says why. */
const agentValue = (
  type: ScalarType | "month",
  value: unknown,
  currency: string,
): Exclude<Value, ReadonlyArray<unknown>> | { readonly error: string } => {
  switch (type) {
    case "text":
      return typeof value === "string" && value.length <= MAX_TEXT
        ? value
        : { error: `text up to ${MAX_TEXT} characters` };
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value)
        ? value
        : { error: "a whole number" };
    case "decimal": {
      const text = typeof value === "number" ? String(value) : value;
      return typeof text === "string" && /^-?\d{1,12}(?:\.\d{1,6})?$/.test(text)
        ? text
        : { error: "a number such as 2 or 1.5" };
    }
    case "money": {
      if (typeof value !== "string" && typeof value !== "number")
        return { error: 'an amount as said, such as "₹1,200"' };
      const parsed = parseAmount(String(value), currency);
      return "error" in parsed ? { error: 'an amount as said, such as "₹1,200"' } : parsed.money;
    }
    case "date":
      return typeof value === "string" && isDay(value)
        ? value
        : { error: "a day such as 2026-11-12" };
    case "month":
      return typeof value === "string" && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)
        ? value
        : { error: "a month such as 2026-11" };
    case "boolean":
      return typeof value === "boolean" ? value : { error: "true or false" };
  }
};

const agentTable = (
  input: InputDecl,
  raw: unknown,
  currency: string,
): Value | { readonly error: string } => {
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) return { error: `rows, at most ${MAX_ROWS}` };
  const rows: Array<Record<string, string | number | boolean | Money | null>> = [];
  for (const row of raw as ReadonlyArray<unknown>) {
    if (typeof row !== "object" || row === null || Array.isArray(row))
      return { error: "each row an object" };
    const extra = Object.keys(row).find((column) => !Object.hasOwn(input.columns, column));
    if (extra !== undefined) return { error: `no column ${extra.slice(0, 40)}` };
    const out: Record<string, string | number | boolean | Money | null> = {};
    for (const [column, type] of Object.entries(input.columns)) {
      const cell: unknown = Reflect.get(row, column);
      if (cell === undefined || cell === null) {
        out[column] = null;
        continue;
      }
      const checked = agentValue(type, cell, currency);
      if (typeof checked === "object" && checked !== null && "error" in checked)
        return { error: `${column}: ${checked.error}` };
      out[column] = checked;
    }
    rows.push(out);
  }
  return rows;
};

/** What Kin read from stored rows for one declared input; `agent` holds the agent's checked values. */
export type Facts = (
  source: Exclude<Source, { readonly _tag: "agent" }>,
  input: InputDecl,
  agent: Readonly<Record<string, Value>>,
) => Value | undefined;

/**
 * The exact inputs a job gets: each declared input, from the agent only when it is the agent's,
 * else from `facts`. Anything the recipe doesn't declare as the agent's is refused, so an agent
 * can't supply a figure Kin stores.
 */
export const assembleInputs = (
  recipe: Recipe,
  given: Readonly<Record<string, unknown>>,
  facts: Facts,
  currency: string,
): { readonly inputs: Readonly<Record<string, Value>> } | { readonly error: KinChatError } => {
  const own = new Set(
    recipe.inputs.filter((input) => input.from === "agent").map((input) => input.name),
  );
  const strangers = Object.keys(given).filter((name) => !own.has(name));
  if (strangers.length > 0)
    return {
      error: invalid(
        `${recipe.name} doesn't take ${strangers.slice(0, 5).join(", ")} from you; Kin reads what it stores itself. Nothing started.`,
      ),
    };
  const agent: Record<string, Value> = {};
  const wrong: Array<string> = [];
  for (const input of recipe.inputs) {
    if (input.from !== "agent") continue;
    const raw = given[input.name];
    if (raw === undefined || raw === null) continue;
    const checked =
      input.type === "table"
        ? agentTable(input, raw, currency)
        : agentValue(input.type, raw, currency);
    if (typeof checked === "object" && checked !== null && "error" in checked)
      wrong.push(`${input.name} (${checked.error})`);
    else agent[input.name] = checked;
  }
  const inputs: Record<string, Value> = {};
  const missing: Array<string> = [];
  for (const input of recipe.inputs) {
    const source = sourceOf(input.from);
    const value =
      source === undefined || source._tag === "agent"
        ? agent[input.name]
        : facts(source, input, agent);
    if (value === undefined || value === null) {
      if (input.required) missing.push(input.name);
      inputs[input.name] = null;
    } else inputs[input.name] = value;
  }
  if (wrong.length > 0)
    return {
      error: invalid(
        `These inputs aren't right: ${wrong.slice(0, 5).join("; ")}. Nothing started.`,
      ),
    };
  if (missing.length > 0)
    return {
      error: invalid(
        `${recipe.name} needs ${missing.slice(0, 8).join(", ")}, and Kin has no value for ${missing.length === 1 ? "it" : "them"}. Nothing started.`,
      ),
    };
  return { inputs };
};

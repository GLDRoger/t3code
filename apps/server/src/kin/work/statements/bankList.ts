// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous row hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import type { KinOrgId, KinRecordState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { mentionsMoney } from "../../memory/sensitivity.ts";
import { type FieldValue, parseFields } from "../lists.ts";
import { dayIn } from "../money.ts";
import { ownerZone } from "../recordRows.ts";
import {
  defineList,
  type FieldDef,
  type ListDef,
  listDef,
  type StoredDefinition,
} from "../registers.ts";
import type { Statement, StatementRow } from "./statementTable.ts";

/**
 * Bank transactions: every statement row Kin has saved, one entry each, in a list Kin makes
 * itself or adopts when the owner already keeps one by that name (an import's, say). A row is
 * the same row however often it is sent: by account, day, amount, reference or narration, and
 * its place among identical rows that day. Its amount is never spend or income in Money.
 */

const BANK_LIST_ID = "bank_transactions";
const field = (
  key: string,
  label: string,
  type: FieldDef["type"],
  more: Partial<FieldDef> = {},
): FieldDef => ({
  key,
  label,
  type,
  sensitive: type === "money",
  ...more,
});
const FIELDS: ReadonlyArray<FieldDef> = [
  field("direction", "Direction", "choice", { choices: ["debit", "credit"] }),
  field("reference", "Reference", "text"),
  field("account", "Account", "text"),
  field("balance", "Balance", "money"),
];
const CATEGORIES = [
  "payment received",
  "expense",
  "transfer",
  "salary",
  "tax",
  "charges",
  "interest",
  "other",
];
const STATE_LABELS = { open: "Unexplained", done: "Explained", dropped: "Ignored" } as const;
const DEFINITION: StoredDefinition = {
  noun: "bank transaction",
  states: ["open", "done", "dropped"],
  stateLabels: STATE_LABELS,
  defaultState: "open",
  categories: CATEGORIES,
  fields: FIELDS,
  sensitive: true,
  amount: true,
  currency: "INR",
  dateLabel: "Date",
};
const PREFIXES = ["BNK", "BTX", "BANK", "BKTX"];

/** The owner's own list called Bank transactions, or Kin's; read only, so it may be neither yet. */
export const findBankList = Effect.fn("KinBankList.find")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ id: string }>`SELECT register_id AS id FROM kin_registers
    WHERE org_id = ${orgId} AND built_in = 0
      AND (register_id = ${BANK_LIST_ID} OR lower(trim(name)) = 'bank transactions')
    ORDER BY archived_at IS NOT NULL, register_id = ${BANK_LIST_ID} DESC, register_id LIMIT 1`;
  return row === undefined ? undefined : yield* listDef(orgId, row.id);
});

const DEBIT = /^(debit|dr|out|withdrawal|paid|spent|money out)/i;
const CREDIT = /^(credit|cr|in|deposit|received|money in)/i;
/** Which way an entry's money went, from its direction field in the list's own words. */
export const directionOf = (fields: Record<string, FieldValue>) => {
  const said = typeof fields.direction === "string" ? fields.direction : "";
  return DEBIT.test(said) ? ("debit" as const) : CREDIT.test(said) ? ("credit" as const) : null;
};

/**
 * The list, made or adopted, holding every field and state a row needs. Adopting only adds:
 * fields, choices, categories and names for states that have none, never what the owner set.
 */
export const ensureBankList = Effect.fn("KinBankList.ensure")(function* (
  orgId: KinOrgId,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const found = yield* findBankList(orgId);
  if (found === undefined) {
    const taken = yield* sql<{ prefix: string }>`SELECT key_prefix AS prefix FROM kin_registers
      WHERE org_id = ${orgId} ORDER BY key_prefix`;
    const prefix = PREFIXES.find((one) => !taken.some((row) => row.prefix === one)) ?? "BK9";
    yield* defineList(
      orgId,
      { _tag: "new", id: BANK_LIST_ID, name: "Bank transactions", prefix, definition: DEFINITION },
      now,
    );
    return (yield* listDef(orgId, BANK_LIST_ID))!;
  }
  const fields = FIELDS.filter((one) => !found.fields.some((existing) => existing.key === one.key));
  const direction = found.fields.find((one) => one.key === "direction");
  const choices =
    direction?.type === "choice"
      ? [
          ...(direction.choices?.some((one) => DEBIT.test(one)) === true ? [] : ["debit"]),
          ...(direction.choices?.some((one) => CREDIT.test(one)) === true ? [] : ["credit"]),
        ]
      : [];
  const categories = CATEGORIES.filter((one) => !found.categories.includes(one));
  const stateLabels = Object.fromEntries(
    Object.entries(STATE_LABELS).filter(
      ([state]) =>
        found.states.includes(state as KinRecordState) &&
        found.stateLabels[state as keyof typeof STATE_LABELS] === undefined,
    ),
  );
  if (
    fields.length === 0 &&
    choices.length === 0 &&
    categories.length === 0 &&
    Object.keys(stateLabels).length === 0
  )
    return found;
  yield* defineList(
    orgId,
    {
      _tag: "extend",
      id: found.id,
      fields,
      categories,
      choices: choices.length === 0 ? {} : { direction: choices },
      stateLabels,
    },
    now,
  );
  return (yield* listDef(orgId, found.id))!;
});

/** The states a row moves between, in whatever states the adopted list has. */
export const bankStates = (def: ListDef) => {
  const explained: KinRecordState = def.states.includes("done") ? "done" : def.defaultState;
  return {
    open: def.states.includes("open") ? ("open" as const) : def.defaultState,
    explained,
    ignored: def.states.includes("dropped") ? ("dropped" as const) : explained,
  };
};

const last4 = (text: string | null) =>
  text === null ? null : (/(\d{4})\D*$/.exec(text)?.[1] ?? null);
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
/** A reference as one bank or reader prints it and another drops its leading zeros or spaces. */
const referenceKey = (text: string) => squash(text).replace(/^0+/, "");
/** How a statement names its account on each row: "HDFC Bank ••4821". */
export const accountLabel = (statement: Pick<Statement, "bank" | "account" | "kind">) =>
  statement.account === null
    ? (statement.bank ?? (statement.kind === "card" ? "Card" : "Bank account"))
    : `${statement.bank ?? (statement.kind === "card" ? "Card" : "Account")} ••${statement.account}`;

/**
 * A row's identity: the same row from any statement of the account has the same one, however a
 * reader spaced its narration or printed its reference. `legacy` is the key rows saved before
 * references dropped their leading zeros have.
 */
export const rowFingerprints = (statement: Statement, legacy = false): ReadonlyArray<string> => {
  const seen = new Map<string, number>();
  return statement.rows.map((row) => {
    const narration = `d:${squash(row.description).slice(0, 60)}`;
    const said = legacy
      ? row.reference === null || row.reference === ""
        ? narration
        : `r:${squash(row.reference)}`
      : referenceKey(row.reference ?? "") === ""
        ? narration
        : `r:${referenceKey(row.reference ?? "")}`;
    const base = [statement.account ?? "", row.date, row.amountMinor, row.direction, said].join(
      "|",
    );
    const position = seen.get(base) ?? 0;
    seen.set(base, position + 1);
    return NodeCrypto.createHash("sha256").update(`${base}|${position}`).digest("hex").slice(0, 32);
  });
};
export const originKeyOf = (fingerprint: string) => `bank:${fingerprint}`;

/** What a row's entry holds: its direction in the list's own words, reference, account, balance. */
export const rowFields = (def: ListDef, statement: Statement, row: StatementRow) => {
  const fields: Record<string, FieldValue> = {};
  const has = (key: string) => def.fields.find((one) => one.key === key && one.retired !== true);
  const direction = has("direction");
  if (direction !== undefined) {
    const value =
      direction.type === "choice"
        ? direction.choices?.find((one) => (row.direction === "debit" ? DEBIT : CREDIT).test(one))
        : row.direction;
    if (value !== undefined) fields.direction = value;
  }
  if (has("reference")?.type === "text" && row.reference !== null)
    fields.reference = row.reference.slice(0, 500);
  if (has("account")?.type === "text") fields.account = accountLabel(statement);
  if (has("balance")?.type === "money" && row.balanceMinor !== null && row.balanceMinor >= 0)
    fields.balance = { minor: row.balanceMinor, currency: statement.currency };
  return fields;
};

/** A row's title: its narration without amounts, which titles never hold. */
export const rowTitle = (row: StatementRow) => {
  const cleaned = row.description
    .replace(/\b(USD|EUR|GBP|SGD|AED|AUD|CAD|JPY|CHF|INR|Rs\.?)\s?[\d,.]+/gi, "")
    .replace(/[₹$€£]\s?[\d,.]+/g, "")
    .replace(/\b\d[\d,]*\.\d{2}\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
  return cleaned === "" || mentionsMoney(cleaned)
    ? `${row.direction === "credit" ? "Money in" : "Money out"} on ${row.date}`
    : cleaned;
};

export type KnownRow = {
  readonly recordId: string;
  readonly key: string;
  readonly state: KinRecordState;
};

/**
 * Rows of this statement already in the list: by their own key when Kin saved them, else by what
 * an entry says (day, amount, direction, account, reference or narration), one entry per row.
 */
export const knownRows = Effect.fn("KinBankList.known")(function* (
  orgId: KinOrgId,
  def: ListDef | undefined,
  statement: Statement,
) {
  const known = new Map<number, KnownRow>();
  if (def === undefined || statement.rows.length === 0) return known;
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const keyed = new Map(
    [...rowFingerprints(statement, true), ...rowFingerprints(statement)].map((one, at) => [
      originKeyOf(one),
      at % statement.rows.length,
    ]),
  );
  const origins = [...keyed.keys()];
  for (let at = 0; at < origins.length; at += 500) {
    const rows = yield* sql<{
      recordId: string;
      key: string;
      state: KinRecordState;
      originKey: string;
    }>`
      SELECT record_id AS "recordId", key, state, origin_key AS "originKey" FROM kin_records
      WHERE org_id = ${orgId} AND register_id = ${def.id} AND origin_key IN ${sql.in(origins.slice(at, at + 500))}
      ORDER BY record_id`;
    for (const row of rows) known.set(keyed.get(row.originKey)!, row);
  }
  const days = statement.rows.map((row) => row.date).toSorted();
  // A day either side, since an import may have stored a day in another zone.
  const from = Date.parse(`${days[0]}T00:00:00Z`) - 2 * 86_400_000;
  const to = Date.parse(`${days.at(-1)}T00:00:00Z`) + 2 * 86_400_000;
  const others = yield* sql<{
    recordId: string;
    key: string;
    state: KinRecordState;
    title: string;
    notes: string;
    amountMinor: number | null;
    dateAt: number | null;
    fieldsJson: string;
    originKey: string;
  }>`SELECT record_id AS "recordId", key, state, title, notes, amount_minor AS "amountMinor",
      date_at AS "dateAt", fields_json AS "fieldsJson", origin_key AS "originKey"
    FROM kin_records WHERE org_id = ${orgId} AND register_id = ${def.id}
      AND date_at >= ${from} AND date_at <= ${to}
    ORDER BY date_at, key`;
  const claimed = new Set([...known.values()].map((one) => one.recordId));
  for (const [index, row] of statement.rows.entries()) {
    if (known.has(index)) continue;
    const match = others.find((other) => {
      if (
        claimed.has(other.recordId) ||
        other.amountMinor !== row.amountMinor ||
        other.dateAt === null
      )
        return false;
      if (dayIn(other.dateAt, zone) !== row.date) return false;
      const fields = parseFields(other.fieldsJson);
      const direction = typeof fields.direction === "string" ? fields.direction : null;
      if (direction !== null && !(row.direction === "debit" ? DEBIT : CREDIT).test(direction))
        return false;
      const account = last4(typeof fields.account === "string" ? fields.account : null);
      if (account !== null && statement.account !== null && account !== statement.account)
        return false;
      const reference = typeof fields.reference === "string" ? referenceKey(fields.reference) : "";
      if (reference !== "" && row.reference !== null && referenceKey(row.reference) !== "")
        return reference === referenceKey(row.reference);
      const said = squash(`${other.title} ${other.notes}`);
      const narration = squash(row.description);
      return (
        said.includes(narration.slice(0, 24)) ||
        narration.includes(squash(other.title).slice(0, 24))
      );
    });
    if (match === undefined) continue;
    claimed.add(match.recordId);
    known.set(index, { recordId: match.recordId, key: match.key, state: match.state });
  }
  return known;
});

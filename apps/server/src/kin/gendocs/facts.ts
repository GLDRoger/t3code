import type { KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { readProfile } from "../work/companyProfile.ts";
import { logoFile, logoPath } from "./brand.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { type FieldValues, parseFields } from "../work/lists.ts";
import { dayIn } from "../work/money.ts";
import {
  fromImport,
  notedReceiptNumbers,
  ownerZone,
  type RecordRow,
  sensitiveNow,
} from "../work/recordRows.ts";
import { type ListDef, listDef, sensitiveKeys, stateLabel } from "../work/registers.ts";
import { issuedNumber } from "./numbering.ts";
import {
  type Facts,
  type InputDecl,
  MAX_ROWS,
  type Money,
  type Recipe,
  type Source,
  sourceOf,
  type Value,
} from "./recipe.ts";

/**
 * What a recipe's inputs read from stored rows, gathered before the job starts. Every value is
 * one Kin keeps; only the columns a recipe declares reach the worker (`assembleInputs`).
 */

type Cell = string | number | boolean | Money | null;
const DAY_MS = 86_400_000;

const isMoney = (value: unknown): value is Money =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "minor") === "number" &&
  typeof Reflect.get(value, "currency") === "string";
/** A field's value as one cell: text, a number, a boolean or an amount; lists and files aren't. */
const cellOf = (fields: FieldValues, key: string): Cell => {
  const value: unknown = fields[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  return isMoney(value) ? { minor: value.minor, currency: value.currency } : null;
};
const amountOf = (minor: number | null, currency: string | null): Money | null =>
  minor === null || currency === null ? null : { minor, currency };

export type Gathered = {
  readonly facts: Facts;
  readonly currency: string;
  /** Whether what this input reads is confidential, by where it comes from (`jobSensitive`). */
  readonly sensitive: (input: InputDecl) => boolean;
  readonly number: string | null;
  /** The logo's file, for a recipe that reads `company.logo`; `null` when there is none. */
  readonly logo: {
    readonly bytes: Uint8Array;
    readonly extension: string;
    readonly sha256: string;
  } | null;
};

// Bank details and tax ids; a company's name, address and place of supply print on every invoice.
const SENSITIVE_COMPANY = /^(?:bank\.|gstin$|pan$)/;
const SENSITIVE_CLIENT = new Set(["gstin", "terms"]);
const AMOUNT_COLUMNS = new Set(["amount", "tax"]);

/** An entry's own label, one it inherits, or its list's. */
export const entrySensitive = (entry: RecordRow, def: ListDef | undefined) =>
  entry.sensitive === 1 || entry.inheritedSensitive === 1 || def?.sensitive === true;

export const gatherFacts = Effect.fn("KinDocFacts.gather")(function* (
  orgId: KinOrgId,
  recipe: Recipe,
  entry: RecordRow | undefined,
  given: Readonly<Record<string, unknown>>,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const zone = yield* ownerZone(orgId);
  const now = yield* Clock.currentTimeMillis;
  const profile = yield* readProfile(orgId);
  const wantsLogo = recipe.inputs.some((input) => sourceOf(input.from)?._tag === "logo");
  const logoBytes = wantsLogo && profile.logo !== null ? yield* logoFile(profile.logo) : null;
  const logo =
    logoBytes === null || profile.logo === null
      ? null
      : { ...logoBytes, sha256: profile.logo.sha256 };
  const def = entry === undefined ? undefined : yield* listDef(orgId, entry.registerId);
  const fields = entry === undefined ? {} : parseFields(entry.fieldsJson);
  // A receipt for a payment prints what was paid, whatever its own row says.
  const [paid] =
    entry?.registerId === "receipts" && typeof fields.payment === "string"
      ? yield* sql<Money>`SELECT amount_minor AS minor, currency FROM kin_record_payments
          WHERE org_id = ${orgId} AND payment_id = ${fields.payment}`
      : [];
  const client = entry?.partyId == null ? undefined : yield* records.getById(orgId, entry.partyId);
  const clientFields = client === undefined ? {} : parseFields(client.fieldsJson);
  const number =
    entry === undefined
      ? null
      : ((yield* issuedNumber(orgId, entry.recordId)) ??
        (recipe.numbered ? null : (cellOf(fields, "number") as string | null)));
  const currency = entry?.currency ?? def?.currency ?? "INR";
  const day = (ms: number | null) => (ms === null ? null : dayIn(ms, zone));
  const clientDef = client === undefined ? undefined : yield* listDef(orgId, client.registerId);
  const entryLabelled = entry !== undefined && entrySensitive(entry, def);
  const entryKeys = new Set(def === undefined ? [] : sensitiveKeys(def));
  const clientKeys = new Set(clientDef === undefined ? [] : sensitiveKeys(clientDef));

  const tables = new Map<string, Value>();
  /** Tables whose rows are confidential: a sensitive list, row, field or amount. */
  const sensitiveTables = new Set<string>();
  for (const input of recipe.inputs) {
    const source = sourceOf(input.from);
    if (source?._tag === "entryPayments") {
      if (entry === undefined) continue;
      sensitiveTables.add(input.name);
      const paid = yield* entryPayments(orgId, entry, dayIn(entry.dateAt ?? now, zone));
      tables.set(
        input.name,
        paid
          .filter((row) => !source.advancesOnly || row.kind === "advance")
          .map((row) => pick(input, row)),
      );
      continue;
    }
    if (source?._tag !== "rows" && source?._tag !== "payments") continue;
    const month = input.period === undefined ? undefined : given[input.period];
    if (typeof month !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) continue;
    const start = Date.parse(`${month}-01T00:00:00Z`) - 2 * DAY_MS;
    const end = start + 35 * DAY_MS;
    if (source._tag === "payments") {
      sensitiveTables.add(input.name);
      const rows = yield* sql<{
        invoice: string;
        client: string | null;
        minor: number;
        currency: string;
        paidOn: string;
      }>`SELECT COALESCE(n.number, r.key) AS invoice, p2.title AS client, p.amount_minor AS minor,
          p.currency, p.paid_on AS "paidOn"
        FROM kin_record_payments p
        JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
        LEFT JOIN kin_records p2 ON p2.org_id = r.org_id AND p2.record_id = r.party_id
        LEFT JOIN kin_issued_numbers n ON n.org_id = r.org_id AND n.record_id = r.record_id
        WHERE p.org_id = ${orgId} AND p.voided_at IS NULL AND r.register_id = 'invoices'
          AND substr(p.paid_on, 1, 7) = ${month}
        ORDER BY p.paid_on, p.payment_id LIMIT ${MAX_ROWS}`;
      tables.set(
        input.name,
        rows.map((row) =>
          pick(input, {
            invoice: row.invoice,
            client: row.client,
            amount: { minor: row.minor, currency: row.currency },
            paidOn: row.paidOn,
          }),
        ),
      );
      continue;
    }
    const list = yield* listDef(orgId, source.list);
    // A list the org doesn't keep has no entries that month: an empty table, not a missing one.
    if (list === undefined) {
      tables.set(input.name, []);
      continue;
    }
    const listKeys = new Set(sensitiveKeys(list));
    if (
      list.sensitive ||
      Object.keys(input.columns).some(
        (column) =>
          AMOUNT_COLUMNS.has(column) ||
          (column.startsWith("field_") && listKeys.has(column.slice("field_".length))),
      )
    )
      sensitiveTables.add(input.name);
    const rows = yield* sql<{
      key: string;
      title: string;
      state: string;
      minor: number | null;
      currency: string | null;
      dateAt: number;
      dueAt: number | null;
      category: string | null;
      fieldsJson: string;
      client: string | null;
      number: string | null;
      sensitive: number;
    }>`SELECT r.key, r.title, r.state, r.amount_minor AS minor, r.currency, r.date_at AS "dateAt",
        r.due_at AS "dueAt", r.category, r.fields_json AS "fieldsJson", p.title AS client,
        n.number, ${sensitiveNow(sql)} AS sensitive
      FROM kin_records r
      LEFT JOIN kin_records p ON p.org_id = r.org_id AND p.record_id = r.party_id
      LEFT JOIN kin_issued_numbers n ON n.org_id = r.org_id AND n.record_id = r.record_id
      WHERE r.org_id = ${orgId} AND r.register_id = ${list.id} AND r.date_at IS NOT NULL
        AND r.date_at >= ${start} AND r.date_at < ${end}
      ORDER BY r.date_at, r.key LIMIT ${MAX_ROWS * 2}`;
    const inMonth = rows
      .filter((row) => dayIn(row.dateAt, zone).startsWith(month))
      .slice(0, MAX_ROWS);
    if (inMonth.some((row) => row.sensitive === 1)) sensitiveTables.add(input.name);
    tables.set(
      input.name,
      inMonth.map((row) => {
        const own = parseFields(row.fieldsJson);
        return pick(input, {
          key: row.key,
          title: row.title,
          state: stateLabel(list, row.state),
          amount: amountOf(row.minor, row.currency),
          tax: cellOf(own, "tax"),
          date: dayIn(row.dateAt, zone),
          due: day(row.dueAt),
          client: row.client,
          category: row.category,
          number: row.number ?? (cellOf(own, "number") as string | null),
          ...Object.fromEntries(
            Object.keys(input.columns)
              .filter((column) => column.startsWith("field_"))
              .map((column) => [column, cellOf(own, column.slice("field_".length))]),
          ),
        });
      }),
    );
  }

  const facts: Facts = (source, input) => {
    switch (source._tag) {
      case "entry": {
        if (entry === undefined) return undefined;
        switch (source.key) {
          case "key":
            return entry.key;
          case "title":
            return withoutOwnNumber(entry.title, [number, cellOf(fields, "number")]);
          case "state":
            return def === undefined ? entry.state : stateLabel(def, entry.state);
          case "amount":
            return paid ?? amountOf(entry.amountMinor, entry.currency);
          case "tax":
            return cellOf(fields, "tax");
          case "date":
            return day(entry.dateAt);
          case "due":
            return day(entry.dueAt);
          case "notes":
            return entry.notes === "" ? null : entry.notes;
          case "number":
            return number;
          default:
            return undefined;
        }
      }
      case "entryField":
        return entry === undefined ? undefined : cellOf(fields, source.field);
      case "client":
        if (client === undefined) return undefined;
        return source.key === "name" ? client.title : cellOf(clientFields, source.key);
      case "company": {
        const [head, tail] = source.key.split(".");
        const value: unknown =
          head === "bank" && tail !== undefined
            ? Reflect.get(profile.bank ?? {}, tail)
            : head === "brand" && tail !== undefined
              ? Reflect.get(profile.brand, tail)
              : Reflect.get(profile, head!);
        return typeof value === "string" && value.length > 0 ? value : null;
      }
      case "logo":
        return logo === null ? null : logoPath(logo.extension);
      case "system":
        return source.key === "today"
          ? dayIn(now, zone)
          : source.key === "number"
            ? number
            : recipe.numbered && number === null;
      case "rows":
      case "payments":
      case "entryPayments":
        return tables.get(input.name);
    }
  };
  const fromSource = (source: Source | undefined, input: InputDecl): boolean => {
    switch (source?._tag) {
      case undefined:
      case "agent":
      case "system":
      case "logo":
        return false;
      case "entry":
        return entryLabelled || AMOUNT_COLUMNS.has(source.key);
      case "entryField":
        return entryLabelled || entryKeys.has(source.field);
      case "client":
        return (
          (client !== undefined && entrySensitive(client, clientDef)) ||
          SENSITIVE_CLIENT.has(source.key) ||
          clientKeys.has(source.key)
        );
      case "company":
        return SENSITIVE_COMPANY.test(source.key);
      case "rows":
      case "payments":
      case "entryPayments":
        return sensitiveTables.has(input.name);
    }
  };
  const sensitive = (input: InputDecl) =>
    input.type === "money" ||
    Object.values(input.columns).includes("money") ||
    fromSource(sourceOf(input.from), input);
  return { facts, currency, sensitive, number, logo } satisfies Gathered;
});

/**
 * A title without the entry's own number at its start, as an import writes "QST/2026-27/008
 * Website build": the document shows the number on its own. The stored title stays as it is.
 */
const withoutOwnNumber = (title: string, numbers: ReadonlyArray<unknown>) => {
  for (const number of numbers) {
    if (typeof number !== "string" || number === "" || !title.startsWith(number)) continue;
    const rest = /^(?:\s*[·•|:–—-]\s*|\s+)(.*)$/s.exec(title.slice(number.length))?.[1]?.trim();
    if (rest !== undefined && rest !== "") return rest;
  }
  return title;
};

/**
 * An entry's live payments, oldest first, each with its receipt's number and how it settles the
 * entry: TDS the client deducted, an advance (received before `before`, its issue day, or set
 * against it from an advance's receipt), or money received.
 */
const entryPayments = Effect.fn("KinDocFacts.entryPayments")(function* (
  orgId: KinOrgId,
  entry: RecordRow,
  before: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    minor: number;
    currency: string;
    paidOn: string;
    note: string;
    originKey: string;
    withheld: number;
    receipt: string | null;
  }>`SELECT p.amount_minor AS minor, p.currency, p.paid_on AS "paidOn", p.note,
      p.origin_key AS "originKey", p.withheld,
      (SELECT n.number FROM kin_records r
        JOIN kin_issued_numbers n ON n.org_id = r.org_id AND n.record_id = r.record_id
        WHERE r.org_id = p.org_id AND r.register_id = 'receipts' AND r.state <> 'dropped'
          AND r.origin_key LIKE 'receipt:%'
          AND json_extract(r.fields_json, '$.payment') = p.payment_id
        ORDER BY r.created_at DESC, r.record_id DESC LIMIT 1) AS receipt
    FROM kin_record_payments p
    WHERE p.org_id = ${orgId} AND p.record_id = ${entry.recordId} AND p.voided_at IS NULL
    ORDER BY p.paid_on, p.payment_id LIMIT 200`;
  const noted = yield* notedReceiptNumbers(
    orgId,
    rows.filter(fromImport).map((row) => row.note),
  );
  return rows.map((row) => ({
    receipt: row.receipt ?? (fromImport(row) ? noted.get(row.note) : undefined) ?? null,
    amount: { minor: row.minor, currency: row.currency },
    paidOn: row.paidOn,
    kind:
      row.withheld === 1
        ? "tds"
        : row.paidOn < before || row.originKey.startsWith("receipt:")
          ? "advance"
          : "received",
  }));
});

/** Only the columns the input declares, so a row carries nothing else Kin stores. */
const pick = (input: InputDecl, row: Readonly<Record<string, Cell>>) =>
  Object.fromEntries(Object.keys(input.columns).map((column) => [column, row[column] ?? null]));

/**
 * Whether a job is confidential: any value it was given is, by where it came from. The recipe's
 * own `sensitive` can only raise it.
 */
export const jobSensitive = (
  recipe: Recipe,
  inputs: Readonly<Record<string, Value>>,
  gathered: Gathered,
) =>
  recipe.sensitive ||
  recipe.inputs.some((input) => {
    const value = inputs[input.name];
    return value !== null && value !== undefined && gathered.sensitive(input);
  });

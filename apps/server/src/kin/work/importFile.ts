// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous hash of the file; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import {
  KIN_CURRENCY_CODES,
  KIN_IMPORT_MAX_COLUMNS,
  KIN_IMPORT_MAX_FILE_BYTES,
  KIN_IMPORT_MAX_ROWS,
  KinChatError,
  kinCurrency,
  type KinDealStage,
  type KinImportApplied,
  type KinImportApplyInput,
  type KinImportCheck,
  type KinImportCheckInput,
  type KinImportClientDecision,
  type KinImportDateFormat,
  type KinImportDecisions,
  type KinImportFile,
  type KinImportFileInput,
  type KinImportLeftOut,
  type KinImportMapping,
  type KinImportRuns,
  type KinImportRunning,
  type KinImportRunsInput,
  type KinImportTarget,
  type KinImportUndoInput,
  type KinImportUndone,
  type KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { mayActAsOwner } from "../people/KinAccess.ts";
import { sectionOn } from "../shell/KinShell.ts";
import { DEALS_OFF } from "../shell/sections.ts";
import { companyMoneyState } from "./companyProfile.ts";
import { contactAll } from "./contactDetails.ts";
import { stagesOf } from "./dealStages.ts";
import { type ImportReport, KinImport } from "./KinImport.ts";
import { beating } from "./importUndo.ts";
import { heldImportFile, holdImportFile, releaseImportFile } from "./importUploads.ts";
import { fieldList, fieldText, parseFields } from "./lists.ts";
import { dayIn, isCurrency } from "./money.ts";
import { fold, matchName } from "./nameMatch.ts";
import { viewerOf } from "./ownerWork.ts";
import { iso, ownerZone, workFailure } from "./recordRows.ts";

/**
 * A spreadsheet saved as CSV, brought in through the one import engine (`KinImport`): read, its
 * columns mapped, its rows matched to the clients and contacts Kin has by plain rules, and turned
 * into `kin-import` rows the engine checks and applies. Nothing here is a model's judgement.
 */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const isKinError = Schema.is(KinChatError);
const OWNERS_ONLY = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner brings a file in.",
});
const MB = 1024 * 1024;
export const TOO_BIG = `The file is over ${KIN_IMPORT_MAX_FILE_BYTES / MB} MB; Kin takes up to ${KIN_IMPORT_MAX_FILE_BYTES / MB} MB at a time. Split it into smaller files and import each.`;
const tooManyRows = (rows: string) =>
  `The file has ${rows} rows; Kin takes up to ${KIN_IMPORT_MAX_ROWS.toLocaleString("en-US")} at a time. Split it into smaller files and import each.`;
const NOT_TEXT =
  "Kin reads files saved as CSV in UTF-8 or UTF-16, and this one is neither. Save it again as CSV UTF-8 and choose it again.";
const MAIL_BASIS =
  "Why we may mail them comes in with sending to a list. Kin doesn't import it yet.";
const LISTED = 2_000;

export type CsvRow = { readonly line: number; readonly cells: ReadonlyArray<string> };
export type Csv = { readonly headers: ReadonlyArray<string>; readonly rows: ReadonlyArray<CsvRow> };

const decodeText = (bytes: Uint8Array): string | KinChatError => {
  const decode = (label: string, from: number) => {
    try {
      return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(from));
    } catch {
      return invalid(NOT_TEXT);
    }
  };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return decode("utf-8", 3);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decode("utf-16le", 2);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decode("utf-16be", 2);
  // Without a mark, UTF-16 shows as a zero byte beside each letter of plain text.
  let even = 0;
  let odd = 0;
  const probe = Math.min(bytes.length, 2_000);
  for (let index = 0; index < probe; index += 1)
    if (bytes[index] === 0) {
      if (index % 2 === 0) even += 1;
      else odd += 1;
    }
  if (odd > probe / 4 && even === 0) return decode("utf-16le", 0);
  if (even > probe / 4 && odd === 0) return decode("utf-16be", 0);
  return decode("utf-8", 0);
};

/** The separator the header row uses most, outside quotes: comma, semicolon or tab. */
const separatorOf = (text: string) => {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && char in counts) counts[char as keyof typeof counts] += 1;
  }
  return counts[";"] > counts[","] && counts[";"] >= counts["\t"]
    ? ";"
    : counts["\t"] > counts[","]
      ? "\t"
      : ",";
};

/** RFC 4180 with any of three separators; a quoted field may hold separators and line breaks. */
export const readCsv = (bytes: Uint8Array): Csv | KinChatError => {
  if (bytes.length > KIN_IMPORT_MAX_FILE_BYTES) return invalid(TOO_BIG);
  const text = decodeText(bytes);
  if (isKinError(text)) return text;
  const separator = separatorOf(text);
  const records: Array<CsvRow> = [];
  let cells: Array<string> = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let dataRows = 0;
  const endRecord = () => {
    cells.push(cell);
    cell = "";
    if (cells.some((one) => one.trim() !== "")) {
      records.push({ line: startLine, cells });
      if (records.length > 1) dataRows += 1;
    }
    cells = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else {
        if (char === "\n" || (char === "\r" && text[index + 1] !== "\n")) line += 1;
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (char === separator) {
      cells.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      endRecord();
      line += 1;
      startLine = line;
      if (dataRows > KIN_IMPORT_MAX_ROWS)
        return invalid(tooManyRows(`more than ${KIN_IMPORT_MAX_ROWS.toLocaleString("en-US")}`));
    } else cell += char;
  }
  if (cell !== "" || cells.length > 0) endRecord();
  if (dataRows > KIN_IMPORT_MAX_ROWS)
    return invalid(tooManyRows(`more than ${KIN_IMPORT_MAX_ROWS.toLocaleString("en-US")}`));
  const [head, ...rows] = records;
  if (head === undefined) return invalid("The file is empty.");
  if (head.cells.length > KIN_IMPORT_MAX_COLUMNS)
    return invalid(`The file has more than ${KIN_IMPORT_MAX_COLUMNS} columns.`);
  if (rows.length === 0) return invalid("The file has a header row and nothing under it.");
  return { headers: head.cells.map((one) => one.trim()), rows };
};

/** The header words Kin knows, folded (`nameMatch.fold`). */
const HEADER_WORDS: ReadonlyArray<readonly [KinImportTarget, ReadonlyArray<string>]> = [
  [
    "client.name",
    [
      "company",
      "company name",
      "organisation",
      "organization",
      "organisation name",
      "organization name",
      "account",
      "account name",
      "client",
      "client name",
      "customer",
      "customer name",
      "business",
      "business name",
      "prospect",
      "prospect name",
      "name",
    ],
  ],
  [
    "client.kind",
    ["status", "type", "kind", "lifecycle stage", "relationship", "client or prospect", "category"],
  ],
  ["client.address", ["address", "street address", "billing address", "postal address"]],
  ["client.notes", ["notes", "note", "comments", "comment", "description", "remarks"]],
  ["client.source", ["source", "lead source", "came from", "origin", "channel"]],
  ["client.tags", ["tags", "tag", "labels", "label"]],
  [
    "contact.name",
    ["contact", "contact name", "contact person", "full name", "person", "primary contact"],
  ],
  ["contact.role", ["job title", "title", "role", "position", "designation"]],
  ["deal.title", ["deal", "deal name", "deal title", "opportunity", "opportunity name"]],
  ["deal.stage", ["stage", "deal stage", "pipeline stage", "opportunity stage", "sales stage"]],
  [
    "deal.value",
    ["amount", "value", "deal value", "deal amount", "opportunity value", "opportunity amount"],
  ],
  ["deal.currency", ["currency", "currency code", "deal currency"]],
  [
    "deal.expected",
    ["close date", "expected close", "expected close date", "expected", "closing date"],
  ],
  [
    "owner",
    [
      "owner",
      "deal owner",
      "account owner",
      "contact owner",
      "assigned to",
      "sales rep",
      "salesperson",
      "looked after by",
    ],
  ],
];
/** Columns of several emails or phones, in any words that hold these. */
const EMAIL_WORDS = ["email", "e mail", "mail address"];
const PHONE_WORDS = ["phone", "mobile", "telephone", "tel", "cell", "whatsapp"];
const MAIL_BASIS_WORDS = [
  "why we may mail them",
  "mail basis",
  "consent",
  "marketing consent",
  "email consent",
  "lawful basis",
  "opt in",
  "gdpr",
];
/** Several columns may go to these; one column each to the rest. */
const MANY: ReadonlyArray<KinImportTarget> = ["contact.email", "contact.phone", "client.tags"];

const isMailBasis = (header: string) => MAIL_BASIS_WORDS.some((word) => fold(header) === word);

export const proposeColumns = (headers: ReadonlyArray<string>): Array<KinImportTarget> => {
  const taken = new Set<KinImportTarget>();
  return headers.map((header) => {
    const words = fold(header);
    if (words === "" || isMailBasis(header)) return "skip";
    const exact = HEADER_WORDS.find(([, known]) => known.includes(words))?.[0];
    const padded = ` ${words} `;
    const target =
      exact ??
      (EMAIL_WORDS.some((word) => padded.includes(` ${word} `)) || words.endsWith("email")
        ? "contact.email"
        : PHONE_WORDS.some((word) => padded.includes(` ${word} `))
          ? "contact.phone"
          : "skip");
    if (target === "skip" || MANY.includes(target)) return target;
    if (taken.has(target)) return "skip";
    taken.add(target);
    return target;
  });
};

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
/** Mail anyone can sign up for: the same domain says nothing about the same company. */
const PUBLIC_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.in",
  "yahoo.fr",
  "ymail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "mail.com",
  "zoho.com",
  "zohomail.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "qq.com",
  "163.com",
  "126.com",
  "rediffmail.com",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
  "seznam.cz",
  "orange.fr",
  "free.fr",
  "laposte.net",
  "libero.it",
  "t-online.de",
  "btinternet.com",
  "comcast.net",
  "verizon.net",
  "att.net",
  "naver.com",
  "daum.net",
]);
const domainOf = (email: string) => {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return PUBLIC_MAIL.has(domain) ? undefined : domain;
};
const splitEmails = (cell: string) =>
  cell
    .split(/[;,]/)
    .map((one) => one.trim().replace(/^mailto:/i, ""))
    .filter((one) => one !== "");
const splitPhones = (cell: string) =>
  cell
    .split(";")
    .map((one) => one.trim())
    .filter((one) => one !== "");

/** Symbols that name one currency only: `€`, `£`, `S$`; never a bare `$` or `¥`, which many use. */
const SYMBOLS: ReadonlyArray<readonly [string, string]> = (() => {
  const named = new Map<string, Array<string>>();
  for (const code of KIN_CURRENCY_CODES) {
    const { symbol } = kinCurrency(code);
    if (symbol === code || symbol.includes(" ") || symbol === "$" || symbol === "¥") continue;
    named.set(symbol, [...(named.get(symbol) ?? []), code]);
  }
  return [...named.entries()]
    .flatMap(([symbol, codes]) => (codes.length === 1 ? [[symbol, codes[0]!] as const] : []))
    .toSorted(([a], [b]) => b.length - a.length);
})();
/**
 * An amount as people write it, with any currency it names: `€18.000,50`, `18 000 EUR`,
 * `USD 1,200`. One separator before exactly three digits groups them; otherwise it is the decimal
 * point. A `$` or `¥` alone names no currency, as several countries use each.
 */
export const parseMoneyCell = (
  raw: string,
): { readonly amount: string; readonly currency: string | undefined } | undefined => {
  let text = raw.trim();
  if (text === "") return undefined;
  let currency: string | undefined;
  const code = /^([A-Za-z]{3})\s*|\s*([A-Za-z]{3})$/.exec(text);
  if (code !== null) {
    const found = (code[1] ?? code[2] ?? "").toUpperCase();
    if (!isCurrency(found)) return undefined;
    currency = found;
    text = text.replace(code[0], "");
  }
  for (const [symbol, named] of SYMBOLS)
    if (text.includes(symbol)) {
      if (currency !== undefined && currency !== named) return undefined;
      currency = named;
      text = text.replace(symbol, "");
    }
  text = text.replace(/[$¥\s  ']/g, "");
  if (!/^\d[\d.,]*$/.test(text)) return undefined;
  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  let decimal: "." | "," | null = null;
  if (lastDot >= 0 && lastComma >= 0) decimal = lastDot > lastComma ? "." : ",";
  else {
    const mark = lastDot >= 0 ? "." : lastComma >= 0 ? "," : null;
    if (mark !== null) {
      const once = text.indexOf(mark) === text.lastIndexOf(mark);
      const after = text.length - text.lastIndexOf(mark) - 1;
      decimal = once && after !== 3 ? mark : null;
    }
  }
  const [whole, fraction] =
    decimal === null
      ? [text, undefined]
      : [text.slice(0, text.lastIndexOf(decimal)), text.slice(text.lastIndexOf(decimal) + 1)];
  const digits = whole.replace(/[.,]/g, "");
  if (
    digits === "" ||
    digits.length > 15 ||
    (fraction !== undefined && !/^\d{1,6}$/.test(fraction))
  )
    return undefined;
  return { amount: fraction === undefined ? digits : `${digits}.${fraction}`, currency };
};

const DATE = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(?:[ T].*)?$/;
const validDay = (year: number, month: number, day: number) => {
  if (month < 1 || month > 12 || day < 1) return undefined;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const last = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (day > last) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};
/** A day as the file writes it, read in `format`; ISO days read the same in every format. */
export const parseDayCell = (raw: string, format: KinImportDateFormat | undefined) => {
  const parts = DATE.exec(raw.trim());
  if (parts === null) return undefined;
  const [a, b, c] = [parts[1]!, parts[2]!, parts[3]!];
  if (a.length === 4) return validDay(Number(a), Number(b), Number(c));
  if (format === undefined || format === "ymd") return undefined;
  const year = c.length === 2 ? 2000 + Number(c) : Number(c);
  return format === "dmy"
    ? validDay(year, Number(b), Number(a))
    : validDay(year, Number(a), Number(b));
};
/** The formats every day of the column reads in; two means Kin asks. */
const dayFormats = (values: ReadonlyArray<string>): ReadonlyArray<KinImportDateFormat> => {
  const written = values.filter((one) => DATE.test(one.trim()));
  if (written.every((one) => /^\d{4}/.test(one.trim()))) return ["ymd"];
  return (["dmy", "mdy"] as const).filter((format) =>
    written.every((one) => parseDayCell(one, format) !== undefined),
  );
};

const PROSPECT_WORDS = [
  "prospect",
  "lead",
  "opportunity",
  "potential",
  "cold",
  "warm",
  "qualified",
];
const VENDOR_WORDS = ["vendor", "supplier"];
/** A row's kind from the file's word for it; anything else is a client. */
const kindOf = (raw: string): "client" | "prospect" | "vendor" => {
  const words = fold(raw);
  if (PROSPECT_WORDS.some((word) => words.includes(word))) return "prospect";
  if (VENDOR_WORDS.some((word) => words.includes(word))) return "vendor";
  return "client";
};

const clip = (text: string, length: number) => text.trim().slice(0, length).trim();

type Stored = {
  readonly clients: ReadonlyArray<{
    recordId: string;
    key: string;
    name: string;
    notes: string;
    fields: ReturnType<typeof parseFields>;
  }>;
  readonly contacts: ReadonlyArray<{
    key: string;
    partyId: string;
    name: string;
    emails: ReadonlyArray<string>;
    fields: ReturnType<typeof parseFields>;
  }>;
  readonly people: ReadonlyArray<{ personId: string; name: string; handle: string }>;
  readonly stages: ReadonlyArray<KinDealStage>;
  readonly dealOrigins: ReadonlySet<string>;
  readonly homeCurrency: string;
};

const storedFor = Effect.fn("KinImportFile.stored")(function* (orgId: KinOrgId, batch: string) {
  const sql = yield* SqlClient.SqlClient;
  const clients = yield* sql<{
    recordId: string;
    key: string;
    name: string;
    notes: string;
    fields: string;
  }>`
    SELECT record_id AS "recordId", key, title AS name, notes, fields_json AS fields
    FROM kin_records WHERE org_id = ${orgId} AND register_id = 'clients' AND state <> 'dropped'
      AND (category IS NULL OR category <> 'vendor')
    ORDER BY key`;
  const contacts = yield* sql<{ key: string; partyId: string; name: string; fields: string }>`
    SELECT key, party_id AS "partyId", title AS name, fields_json AS fields FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'contacts' AND state <> 'dropped'
      AND party_id IS NOT NULL
    ORDER BY key`;
  const people = yield* sql<{ personId: string; name: string; handle: string }>`
    SELECT person_id AS "personId", display_name AS name, handle FROM kin_people
    WHERE org_id = ${orgId} AND removed_at IS NULL ORDER BY person_id`;
  const deals = yield* sql<{ origin: string }>`SELECT origin_key AS origin FROM kin_records
    WHERE org_id = ${orgId} AND origin_key >= ${`import:${batch}:deal:`}
      AND origin_key < ${`import:${batch}:deal;`} ORDER BY origin_key`;
  const { stages } = yield* stagesOf(orgId);
  const { homeCurrency } = yield* companyMoneyState(orgId);
  return {
    homeCurrency,
    clients: clients.map((one) => ({ ...one, fields: parseFields(one.fields) })),
    contacts: contacts.map((one) => {
      const fields = parseFields(one.fields);
      return {
        ...one,
        fields,
        emails: contactAll(fields, "email").map((email) => email.toLowerCase()),
      };
    }),
    people,
    stages,
    dealOrigins: new Set(deals.map((one) => one.origin)),
  } satisfies Stored;
});

type Row = {
  readonly line: number;
  readonly name: string;
  readonly kind: string;
  readonly address: string;
  readonly notes: string;
  readonly cameFrom: string;
  readonly tags: ReadonlyArray<string>;
  readonly contact: string;
  readonly role: string;
  readonly emails: ReadonlyArray<string>;
  readonly phones: ReadonlyArray<string>;
  readonly deal: string;
  readonly stage: string;
  readonly value: string;
  readonly currency: string;
  readonly expected: string;
  readonly owner: string;
};

/** Rows joined when any key is shared: one client in the file, however many rows name it. */
const unionFind = (size: number) => {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (index: number): number => {
    let at = index;
    while (parent[at] !== at) {
      parent[at] = parent[parent[at]!]!;
      at = parent[at]!;
    }
    return at;
  };
  return {
    find,
    join: (a: number, b: number) => {
      const [x, y] = [find(a), find(b)];
      if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
    },
  };
};
const groupBy = <T>(items: ReadonlyArray<T>, keysOf: (item: T) => ReadonlyArray<string>) => {
  const sets = unionFind(items.length);
  const first = new Map<string, number>();
  items.forEach((item, index) => {
    for (const key of keysOf(item)) {
      const seen = first.get(key);
      if (seen === undefined) first.set(key, index);
      else sets.join(seen, index);
    }
  });
  const groups = new Map<number, Array<T>>();
  items.forEach((item, index) => {
    const root = sets.find(index);
    const held = groups.get(root);
    if (held === undefined) groups.set(root, [item]);
    else held.push(item);
  });
  return [...groups.values()];
};

type Resolved = {
  readonly check: Omit<KinImportCheck, "batch" | "rows" | "columns" | "mapping" | "checked">;
  readonly lines: ReadonlyArray<string>;
  /** The file's line for each engine line, from 1; the header is the engine's line 1. */
  readonly lineOf: ReadonlyArray<number>;
  readonly datesPassed: number;
};

const firstOf = (rows: ReadonlyArray<Row>, pick: (row: Row) => string) =>
  rows.map(pick).find((one) => one.trim() !== "") ?? "";
const uniqueBy = (values: ReadonlyArray<string>, same: (text: string) => string) => {
  const seen = new Set<string>();
  return values.filter((one) => !seen.has(same(one)) && seen.add(same(one)) !== undefined);
};

const emailKeys = (row: Row) => row.emails.map((email) => `e:${email.toLowerCase()}`);
const domainKeys = (row: Row) =>
  row.emails.flatMap((email) => {
    const domain = domainOf(email);
    return domain === undefined ? [] : [`d:${domain}`];
  });

/**
 * The file's clients: a row is under the client its own row names, folded. A row naming none
 * joins the one named client its email, else its web domain, is at in the file; else it stands
 * with the other unnamed rows it shares an email or domain with.
 */
const clientGroups = (rows: ReadonlyArray<Row>, leave: (line: number, reason: string) => void) => {
  const named = groupBy(
    rows.filter((row) => row.name !== ""),
    (row) => [`n:${fold(row.name)}`],
  );
  const unnamed = groupBy(
    rows.filter((row) => {
      if (row.name !== "") return false;
      if (row.emails.length > 0) return true;
      if (row.contact !== "" || row.deal !== "" || row.notes !== "")
        leave(row.line, "This row names no client and no email, so Kin can't tell whose it is.");
      return false;
    }),
    (row) => [...emailKeys(row), ...domainKeys(row)],
  );
  const holders = (keysOf: (row: Row) => ReadonlyArray<string>) => {
    const out = new Map<string, Set<number>>();
    named.forEach((group, index) => {
      for (const key of group.flatMap(keysOf)) out.set(key, (out.get(key) ?? new Set()).add(index));
    });
    return out;
  };
  const byEmail = holders(emailKeys);
  const byDomain = holders(domainKeys);
  const alone: Array<Array<Row>> = [];
  for (const group of unnamed) {
    const at = (index: Map<string, Set<number>>, keysOf: (row: Row) => ReadonlyArray<string>) =>
      new Set(group.flatMap(keysOf).flatMap((key) => [...(index.get(key) ?? [])]));
    const emailAt = at(byEmail, emailKeys);
    const one = emailAt.size > 0 ? emailAt : at(byDomain, domainKeys);
    if (one.size === 1) named[[...one][0]!]!.push(...group);
    else alone.push(group);
  }
  return [...named, ...alone]
    .map((group) => group.toSorted((a, b) => a.line - b.line))
    .toSorted((a, b) => a[0]!.line - b[0]!.line);
};

/** Names whose numbers differ are two companies, however close: "Works 001" and "Works 002". */
const numbersOf = (name: string) =>
  fold(name)
    .match(/\p{N}+/gu)
    ?.join(" ") ?? "";

const resolve = (
  csv: Csv,
  mapping: KinImportMapping,
  decisions: KinImportDecisions,
  stored: Stored,
  header: { readonly batch: string; readonly file: string },
  today: string,
  dealsOn: boolean,
): Resolved => {
  const leftOut: Array<KinImportLeftOut> = [];
  let more = 0;
  const leave = (line: number | null, reason: string) => {
    if (leftOut.length < LISTED) leftOut.push({ line, reason });
    else more += 1;
  };
  const columns = (target: KinImportTarget) =>
    mapping.columns.flatMap((one, index) => (one === target ? [index] : []));
  const cell = (target: KinImportTarget) => {
    const at = columns(target);
    return (cells: ReadonlyArray<string>) =>
      at.map((index) => (cells[index] ?? "").trim()).find((one) => one !== "") ?? "";
  };
  const cells = (target: KinImportTarget) => {
    const at = columns(target);
    return (row: ReadonlyArray<string>) => at.map((index) => (row[index] ?? "").trim());
  };
  const read = {
    name: cell("client.name"),
    kind: cell("client.kind"),
    address: cell("client.address"),
    notes: cell("client.notes"),
    cameFrom: cell("client.source"),
    tags: cells("client.tags"),
    contact: cell("contact.name"),
    role: cell("contact.role"),
    emails: cells("contact.email"),
    phones: cells("contact.phone"),
    deal: cell("deal.title"),
    stage: cell("deal.stage"),
    value: cell("deal.value"),
    currency: cell("deal.currency"),
    expected: cell("deal.expected"),
    owner: cell("owner"),
  };

  const rows: Array<Row> = [];
  for (const { line, cells: raw } of csv.rows) {
    const emails: Array<string> = [];
    for (const one of read.emails(raw).flatMap(splitEmails))
      if (EMAIL.test(one)) emails.push(one);
      else
        leave(
          line,
          `${clip(one, 80)} isn't an email address, so it stays out; the rest of the row comes in.`,
        );
    rows.push({
      line,
      name: read.name(raw),
      kind: read.kind(raw),
      address: read.address(raw),
      notes: read.notes(raw),
      cameFrom: read.cameFrom(raw),
      tags: read
        .tags(raw)
        .flatMap((one) => one.split(/[;,]/))
        .map((one) => one.trim())
        .filter((one) => one !== ""),
      contact: read.contact(raw),
      role: read.role(raw),
      emails,
      phones: read.phones(raw).flatMap(splitPhones),
      deal: read.deal(raw),
      stage: read.stage(raw),
      value: read.value(raw),
      currency: read.currency(raw),
      expected: read.expected(raw),
      owner: read.owner(raw),
    });
  }

  // What Kin asks once for the whole file: a currency, and how days are written.
  const hasDeals = dealsOn && columns("deal.title").length > 0;
  const valued = hasDeals ? rows.filter((row) => row.deal !== "" && row.value !== "") : [];
  const needsCurrency =
    mapping.currency === undefined &&
    valued.some((row) => {
      const money = parseMoneyCell(row.value);
      return (
        money !== undefined &&
        money.currency === undefined &&
        !isCurrency(row.currency.toUpperCase())
      );
    });
  const days = hasDeals
    ? rows.filter((row) => row.deal !== "" && row.expected !== "").map((row) => row.expected)
    : [];
  const formats = dayFormats(days);
  const dateFormat = mapping.dateFormat ?? (formats.length === 1 ? formats[0] : undefined);
  const needsDateFormat = mapping.dateFormat === undefined && formats.length > 1;
  const dateExamples = needsDateFormat
    ? uniqueBy(
        days.filter((one) => !/^\d{4}/.test(one.trim())),
        (one) => one,
      ).slice(0, 3)
    : [];

  const groups = clientGroups(rows, leave);

  const byEmail = new Map<string, Set<string>>();
  const byDomain = new Map<string, Set<string>>();
  for (const one of stored.contacts)
    for (const email of one.emails) {
      byEmail.set(email, (byEmail.get(email) ?? new Set()).add(one.partyId));
      const domain = domainOf(email);
      if (domain !== undefined)
        byDomain.set(domain, (byDomain.get(domain) ?? new Set()).add(one.partyId));
    }
  const clientById = new Map(stored.clients.map((one) => [one.recordId, one]));
  // Indexed once, so a large file never compares every row with every client Kin has.
  const index = <T, K>(items: ReadonlyArray<T>, keyOf: (item: T) => K) => {
    const out = new Map<K, Array<T>>();
    for (const item of items) {
      const held = out.get(keyOf(item));
      if (held === undefined) out.set(keyOf(item), [item]);
      else held.push(item);
    }
    return out;
  };
  const byFolded = index(stored.clients, (one) => fold(one.name));
  // A close name shares its first word with what it is close to: only those are compared.
  const byFirstWord = index(stored.clients, (one) => fold(one.name).split(" ")[0] ?? "");
  const contactsOf = index(stored.contacts, (one) => one.partyId);
  const clientByKey = new Map(stored.clients.map((one) => [one.key, one]));
  const personFor = (raw: string) => {
    if (raw === "") return undefined;
    const wanted = fold(raw.includes("@") ? raw.slice(0, raw.indexOf("@")) : raw);
    const found = stored.people.filter(
      (one) =>
        fold(one.name) === wanted ||
        fold(one.handle) === wanted ||
        fold(one.name.split(" ")[0] ?? "") === wanted,
    );
    return found.length === 1 ? found[0]!.personId : null;
  };
  const stageFor = (raw: string) =>
    stored.stages.find((one) => one.id === raw.trim().toLowerCase() || fold(one.name) === fold(raw))
      ?.id;

  const matches: Array<KinImportCheck["matches"][number]> = [];
  const decide: Array<KinImportCheck["decide"][number]> = [];
  const unknownStages = new Map<string, { value: string; rows: number }>();
  const will = { prospects: 0, clients: 0, contacts: 0, deals: 0 };
  let matched = 0;
  let ownersUnknown = 0;
  let undecided = 0;
  let datesPassed = 0;
  const lines: Array<string> = [
    JSON.stringify({
      format: "kin-import",
      version: 1,
      batch: header.batch,
      source: clip(header.file, 60) || header.batch,
    }),
  ];
  const lineOf: Array<number> = [0, 0];
  const emit = (row: unknown, line: number) => {
    lines.push(JSON.stringify(row));
    lineOf.push(line);
  };

  for (const group of groups) {
    const source = `r${group[0]!.line}`;
    const name = clip(
      firstOf(group, (row) => row.name),
      280,
    );
    const emails = uniqueBy(
      group.flatMap((row) => row.emails),
      (one) => one.toLowerCase(),
    );
    const asked = decisions.clients?.[source];
    // A named row is matched by its name alone; an email or web domain only asks. A row naming
    // none: rule 1, a contact's email; rule 2, an email's web domain at one client.
    const emailHits = new Set(
      emails.flatMap((email) => [...(byEmail.get(email.toLowerCase()) ?? [])]),
    );
    const domains = uniqueBy(
      emails.flatMap((email) => domainOf(email) ?? []),
      (one) => one,
    );
    const domainHits = new Set(domains.flatMap((domain) => [...(byDomain.get(domain) ?? [])]));
    const sameName = name === "" ? [] : (byFolded.get(fold(name)) ?? []);
    const clientsOf = (ids: ReadonlySet<string>) =>
      [...ids].flatMap((id) => clientById.get(id) ?? []);
    const closeNames = () => {
      const numbers = numbersOf(name);
      const found = matchName(
        name,
        (byFirstWord.get(fold(name).split(" ")[0] ?? "") ?? []).filter(
          (one) => numbersOf(one.name) === numbers,
        ),
      );
      return found._tag === "found"
        ? [found.item]
        : found._tag === "ambiguous"
          ? found.items.slice(0, 5)
          : [];
    };
    const exact =
      name !== ""
        ? sameName.length === 1
          ? { id: sameName[0]!.recordId, by: "name" as const, detail: "the same name" }
          : undefined
        : emailHits.size === 1
          ? {
              id: [...emailHits][0]!,
              by: "email" as const,
              detail: `contact email ${emails.find((email) => byEmail.has(email.toLowerCase())) ?? ""}`,
            }
          : emailHits.size === 0 && domainHits.size === 1
            ? {
                id: [...domainHits][0]!,
                by: "domain" as const,
                detail: `web domain ${domains.find((domain) => byDomain.has(domain)) ?? ""}`,
              }
            : undefined;
    const near =
      exact !== undefined
        ? []
        : name !== ""
          ? sameName.length > 1
            ? sameName
            : emailHits.size > 0
              ? clientsOf(emailHits).slice(0, 5)
              : domainHits.size === 1
                ? clientsOf(domainHits)
                : closeNames()
          : emailHits.size > 1
            ? clientsOf(emailHits)
            : domainHits.size > 1
              ? clientsOf(domainHits)
              : [];
    const lines0 = group.map((row) => row.line);
    let target: { recordId: string; key: string } | "new" | "skip";
    if (exact !== undefined) {
      const client = clientById.get(exact.id)!;
      const decision: KinImportClientDecision = asked === "skip" ? "skip" : "same";
      const kept = [
        ...(client.notes.trim() !== "" && firstOf(group, (row) => row.notes) !== ""
          ? ["notes"]
          : []),
        ...(fieldText(client.fields, "address") !== null &&
        firstOf(group, (row) => row.address) !== ""
          ? ["address"]
          : []),
        ...(fieldText(client.fields, "source") !== null &&
        firstOf(group, (row) => row.cameFrom) !== ""
          ? ["came from"]
          : []),
        ...(fieldList(client.fields, "tags").length > 0 && group.some((row) => row.tags.length > 0)
          ? ["tags"]
          : []),
      ];
      if (matches.length < LISTED)
        matches.push({
          source,
          name: name || client.name,
          key: client.key as KinImportCheck["matches"][number]["key"],
          existing: client.name,
          by: exact.by,
          detail: exact.detail,
          decision,
          kept,
        });
      target = decision === "skip" ? "skip" : client;
    } else if (near.length > 0) {
      const pick =
        asked === undefined || asked === "same"
          ? null
          : asked === "new" || asked === "skip"
            ? asked
            : near.some((one) => one.key === asked)
              ? asked
              : null;
      decide.push({
        source,
        name,
        rows: group.length,
        candidates: near.map((one) => ({
          key: one.key as KinImportCheck["matches"][number]["key"],
          name: one.name,
        })),
        decision: pick,
      });
      if (pick === null) {
        undecided += 1;
        continue;
      }
      target = pick === "new" || pick === "skip" ? pick : clientByKey.get(pick)!;
    } else target = asked === "skip" ? "skip" : "new";
    if (target === "skip") {
      for (const line of lines0) leave(line, "Left out, as you chose.");
      continue;
    }
    if (target === "new" && name === "") {
      for (const line of lines0)
        leave(line, "This row names no client, and no client Kin has uses its email.");
      continue;
    }
    const ownerId = personFor(firstOf(group, (row) => row.owner));
    if (ownerId === null) ownersUnknown += group.filter((row) => row.owner !== "").length;
    const kind = kindOf(firstOf(group, (row) => row.kind));
    const notes = firstOf(group, (row) => row.notes);
    const address = firstOf(group, (row) => row.address);
    const cameFrom = firstOf(group, (row) => row.cameFrom);
    const tags = uniqueBy(
      group.flatMap((row) => row.tags),
      fold,
    )
      .map((one) => clip(one, 60))
      .slice(0, 20);
    if (target === "new") {
      if (kind === "prospect") will.prospects += 1;
      else will.clients += 1;
    } else matched += 1;
    emit(
      {
        client: {
          source,
          name:
            name || (target === "new" ? source : (clientById.get(target.recordId)?.name ?? source)),
          ...(target === "new" ? { kind } : { match: target.key }),
          ...(ownerId === undefined || ownerId === null ? {} : { owner: ownerId }),
          ...(address === "" ? {} : { address: clip(address, 500) }),
          ...(cameFrom === "" ? {} : { cameFrom: clip(cameFrom, 500) }),
          ...(tags.length === 0 ? {} : { tags }),
          ...(notes === "" ? {} : { notes: notes.slice(0, 4_000) }),
        },
      },
      group[0]!.line,
    );

    // Its contacts: by email, else by name, within this client, in the file and in Kin.
    const people = groupBy(
      group.filter((row) => row.contact !== "" || row.emails.length > 0 || row.phones.length > 0),
      (row) => [
        ...row.emails.map((email) => `e:${email.toLowerCase()}`),
        ...(row.contact === "" ? [] : [`n:${fold(row.contact)}`]),
      ],
    );
    const theirs = target === "new" ? [] : (contactsOf.get(target.recordId) ?? []);
    for (const person of people) {
      const personEmails = uniqueBy(
        person.flatMap((row) => row.emails),
        (one) => one.toLowerCase(),
      );
      const personName = clip(firstOf(person, (row) => row.contact) || personEmails[0] || "", 280);
      if (personName === "") continue;
      const phones = uniqueBy(
        person.flatMap((row) => row.phones),
        (one) => one,
      ).map((one) => clip(one, 500));
      const role = firstOf(person, (row) => row.role);
      const had =
        theirs.find((one) =>
          personEmails.some((email) => one.emails.includes(email.toLowerCase())),
        ) ?? theirs.find((one) => fold(one.name) === fold(personName));
      if (had === undefined) will.contacts += 1;
      else if (matches.length > 0 && matches.at(-1)!.source === source) {
        const kept = [
          ...(personEmails.length > 0 &&
          had.emails.length > 0 &&
          !personEmails.every((email) => had.emails.includes(email.toLowerCase()))
            ? [`${had.name}'s email`]
            : []),
          ...(phones.length > 0 && contactAll(had.fields, "phone").length > 0
            ? [`${had.name}'s phone`]
            : []),
        ];
        if (kept.length > 0) {
          const last = matches.at(-1)!;
          matches[matches.length - 1] = { ...last, kept: [...last.kept, ...kept] };
        }
      }
      emit(
        {
          contact: {
            source: `p${person[0]!.line}`,
            client: source,
            name: personName,
            ...(role === "" ? {} : { role: clip(role, 500) }),
            ...(personEmails.length === 0
              ? {}
              : { emails: personEmails.map((one) => clip(one, 500)).slice(0, 20) }),
            ...(phones.length === 0 ? {} : { phones: phones.slice(0, 20) }),
            ...(had === undefined ? {} : { match: had.key }),
          },
        },
        person[0]!.line,
      );
    }

    // Its deals: one per title; a stage it doesn't have waits for a decision, never invented.
    const deals = groupBy(
      group.filter((row) => row.deal !== ""),
      (row) => [`t:${fold(row.deal)}`],
    );
    for (const deal of deals) {
      const first = deal[0]!;
      const dealSource = `d${first.line}`;
      if (!dealsOn) {
        if (!stored.dealOrigins.has(`import:${header.batch}:deal:${dealSource}`))
          leave(first.line, DEALS_OFF);
        continue;
      }
      const known = stageFor(first.stage);
      const decided = decisions.stages?.[fold(first.stage)];
      const stage =
        known ??
        (decided !== undefined &&
        (decided === "skip" || stored.stages.some((one) => one.id === decided))
          ? decided
          : undefined);
      if (known === undefined) {
        const slot = fold(first.stage);
        const had = unknownStages.get(slot);
        unknownStages.set(slot, {
          value: had?.value ?? first.stage,
          rows: (had?.rows ?? 0) + deal.length,
        });
      }
      if (stage === undefined) {
        undecided += 1;
        continue;
      }
      if (stage === "skip") {
        leave(first.line, "Left out, as you chose for its stage.");
        continue;
      }
      const money = first.value === "" ? undefined : parseMoneyCell(first.value);
      if (first.value !== "" && money === undefined)
        leave(
          first.line,
          `${clip(first.value, 40)} isn't an amount Kin can read, so the deal comes in without a value.`,
        );
      const currency =
        money?.currency ??
        (isCurrency(first.currency.toUpperCase())
          ? first.currency.toUpperCase()
          : mapping.currency);
      const expected = first.expected === "" ? undefined : parseDayCell(first.expected, dateFormat);
      if (first.expected !== "" && expected === undefined && !needsDateFormat)
        leave(
          first.line,
          `${clip(first.expected, 40)} isn't a day Kin can read, so the deal comes in without an expected day.`,
        );
      const fresh = !stored.dealOrigins.has(`import:${header.batch}:deal:${dealSource}`);
      if (fresh) {
        will.deals += 1;
        if (expected !== undefined && expected < today) datesPassed += 1;
      }
      const dealOwner = personFor(first.owner) ?? ownerId;
      if (first.owner !== "" && personFor(first.owner) === null && ownerId !== null)
        ownersUnknown += 1;
      emit(
        {
          deal: {
            source: dealSource,
            client: source,
            title: clip(first.deal, 280),
            stage,
            ...(money === undefined || currency === undefined
              ? {}
              : { value: { amount: money.amount, currency } }),
            ...(expected === undefined ? {} : { expected }),
            ...(dealOwner === undefined || dealOwner === null ? {} : { owner: dealOwner }),
            ...(cameFrom === "" ? {} : { cameFrom: clip(cameFrom, 500) }),
          },
        },
        first.line,
      );
    }
  }

  const stages = [...unknownStages.entries()].map(([slot, one]) => {
    const decided = decisions.stages?.[slot];
    return {
      value: one.value,
      rows: one.rows,
      decision:
        decided !== undefined &&
        (decided === "skip" || stored.stages.some((stage) => stage.id === decided))
          ? decided
          : null,
    };
  });
  return {
    check: {
      asks: { currency: needsCurrency, dateFormat: needsDateFormat, dateExamples },
      will,
      matched,
      matches,
      decide: decide.slice(0, LISTED),
      stages,
      companyStages: stored.stages,
      homeCurrency: stored.homeCurrency,
      ownersUnknown,
      leftOut,
      more,
      notImported: csv.headers.flatMap((header) =>
        isMailBasis(header) ? [{ header, reason: MAIL_BASIS }] : [],
      ),
      ready: !needsCurrency && !needsDateFormat && undecided === 0,
    },
    lines,
    lineOf,
    datesPassed,
  };
};

const decodeBase64 = (file: KinImportFile) => {
  if (!/^[A-Za-z0-9+/=\s]*$/.test(file.data))
    return invalid("The file didn't arrive whole. Choose it again.");
  return new Uint8Array(Buffer.from(file.data, "base64"));
};
const hashOf = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const FILE_GONE = new KinChatError({
  reason: "not_found",
  message: "Kin no longer has this file. Choose it again.",
});
const NOT_CHECKED = invalid("This isn't the file you checked. Check it again before importing.");

/** The owner level, from the session; `guard` asks again inside the write's own transaction. */
const ownerLevel = Effect.fn("KinImportFile.ownerLevel")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const viewer = yield* viewerOf(people, orgId);
  if (viewer.teammate) return yield* OWNERS_ONLY;
  const { owner } = yield* KinIdentity;
  const personId = viewer.person.personId;
  const guard = mayActAsOwner(orgId, personId, owner).pipe(
    workFailure,
    Effect.flatMap((may) => (may ? Effect.void : Effect.fail(OWNERS_ONLY))),
  );
  return { personId, guard };
});

/** The file as sent, or the one held for this person under its id; `upload` names the held one. */
const fileOf = Effect.fn("KinImportFile.file")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  file: KinImportFileInput,
) {
  const bytes =
    "data" in file ? decodeBase64(file) : yield* heldImportFile(orgId, personId, file.upload);
  if (bytes === "gone") return yield* FILE_GONE;
  if (bytes === "changed") return yield* NOT_CHECKED;
  if (!(bytes instanceof Uint8Array)) return yield* bytes;
  const csv = readCsv(bytes);
  if (isKinError(csv)) return yield* csv;
  const hash = "data" in file ? hashOf(bytes) : file.upload.hash;
  const upload = "data" in file ? null : file.upload;
  return { csv, bytes, hash, batch: `f${hash.slice(0, 16)}`, upload };
});

const linesOf = (lines: ReadonlyArray<string>) => Stream.fromIterable(lines);
const leftOutOf = (report: ImportReport, lineOf: ReadonlyArray<number>) =>
  report.problems.map((problem) => ({
    line: problem.line === null ? null : (lineOf[problem.line] ?? null),
    reason: problem.reason,
  }));

const resolvedFor = Effect.fn("KinImportFile.resolved")(function* (
  orgId: KinOrgId,
  file: { readonly name: string },
  csv: Csv,
  batch: string,
  mapping: KinImportMapping,
  decisions: KinImportDecisions | undefined,
) {
  if (mapping.columns.length !== csv.headers.length)
    return yield* invalid("The columns changed since the file was read. Choose the file again.");
  const stored = yield* storedFor(orgId, batch).pipe(workFailure);
  const today = dayIn(yield* Clock.currentTimeMillis, yield* ownerZone(orgId).pipe(workFailure));
  // Matching a large file is one long pass over memory: give the event loop back first.
  yield* Effect.yieldNow;
  const dealsOn =
    !mapping.columns.includes("deal.title") || (yield* sectionOn(orgId, "deals").pipe(workFailure));
  return resolve(csv, mapping, decisions ?? {}, stored, { batch, file: file.name }, today, dealsOn);
});

export const check = Effect.fn("KinImportFile.check")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinImportCheckInput,
) {
  const { personId } = yield* ownerLevel(people, input.orgId);
  const { csv, batch, bytes, hash, ...file } = yield* fileOf(input.orgId, personId, input.file);
  const upload = file.upload ?? (yield* holdImportFile(input.orgId, personId, bytes, hash));
  const sample = (index: number) =>
    clip(csv.rows.map((row) => row.cells[index] ?? "").find((one) => one.trim() !== "") ?? "", 80);
  const mapping = input.mapping ?? { columns: proposeColumns(csv.headers) };
  const columns = csv.headers.map((header, index) => ({
    header,
    sample: sample(index),
    target: mapping.columns[index] ?? "skip",
    ...(isMailBasis(header) ? { note: MAIL_BASIS } : {}),
  }));
  const base = { batch, rows: csv.rows.length, columns, mapping, upload };
  const resolved = yield* resolvedFor(
    input.orgId,
    input.file,
    csv,
    batch,
    mapping,
    input.decisions,
  );
  if (input.mapping === undefined || !resolved.check.ready)
    return {
      ...base,
      ...resolved.check,
      checked: input.mapping !== undefined,
    } satisfies KinImportCheck;
  const imports = yield* KinImport;
  const report = yield* imports.plan(input.orgId, personId, linesOf(resolved.lines), {
    file: input.file.name,
  });
  const leftOut = [...resolved.check.leftOut, ...leftOutOf(report, resolved.lineOf)];
  return {
    ...base,
    ...resolved.check,
    will: {
      prospects: report.prospects,
      clients: report.clients.create - report.prospects,
      contacts: report.contacts.create,
      deals: report.deals.create,
    },
    leftOut: leftOut.slice(0, LISTED),
    more: resolved.check.more + report.more + Math.max(0, leftOut.length - LISTED),
    checked: true,
  } satisfies KinImportCheck;
});

export const apply = Effect.fn("KinImportFile.apply")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinImportApplyInput,
) {
  const { personId, guard } = yield* ownerLevel(people, input.orgId);
  const { csv, batch, upload } = yield* fileOf(input.orgId, personId, input.file);
  if (batch !== input.batch) return yield* NOT_CHECKED;
  const resolved = yield* resolvedFor(
    input.orgId,
    input.file,
    csv,
    batch,
    input.mapping,
    input.decisions,
  );
  if (!resolved.check.ready)
    return yield* invalid("Some rows still need a decision. Decide them, then import.");
  const imports = yield* KinImport;
  const report = yield* imports.apply(input.orgId, personId, linesOf(resolved.lines), {
    guard,
    file: input.file.name,
  });
  if (upload !== null) yield* releaseImportFile(upload);
  const leftOut = [...resolved.check.leftOut, ...leftOutOf(report, resolved.lineOf)];
  return {
    batch,
    added: {
      prospects: report.prospects,
      clients: report.clients.create - report.prospects,
      contacts: report.contacts.create,
      deals: report.deals.create,
    },
    matched: report.clients.matched,
    filled: report.filled,
    leftOut: leftOut.slice(0, LISTED),
    more: resolved.check.more + report.more + Math.max(0, leftOut.length - LISTED),
    noticed: {
      noNextStep: report.deals.create,
      datesPassed: Math.min(resolved.datesPassed, report.deals.create),
    },
  } satisfies KinImportApplied;
});

export const undo = Effect.fn("KinImportFile.undo")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinImportUndoInput,
) {
  const { personId, guard } = yield* ownerLevel(people, input.orgId);
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(guard).pipe(workFailure);
  const done = yield* (yield* KinImport).undo(input.orgId, personId, input.batch, {
    apply: true,
    includeChanged: false,
  });
  return {
    batch: done.batch,
    removed: {
      clients: done.removes.clients,
      contacts: done.removes.contacts,
      deals: done.removes.deals,
      other: done.removes.entries + done.removes.projects,
    },
    restored: done.restored,
    kept: [
      ...done.changed.map((key) => ({ key, reason: "someone changed it since the import" })),
      ...done.kept,
    ],
  } satisfies KinImportUndone;
});

const Created = Schema.Struct({ create: Schema.optional(Schema.Number) });
const decodeSummary = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      clients: Schema.optional(Created),
      contacts: Schema.optional(Created),
      deals: Schema.optional(Created),
      entries: Schema.optional(Created),
      projects: Schema.optional(Created),
      file: Schema.optional(Schema.String),
      done: Schema.optional(Schema.Number),
      rows: Schema.optional(Schema.Number),
      beat: Schema.optional(Schema.Number),
    }),
  ),
);
const RUNS_SHOWN = 50;
const count = (value: number | undefined) => Math.max(0, Math.floor(value ?? 0));

/**
 * Each batch's last apply, newest first, and whether an undo came after it; then what runs now.
 * A run with no end whose host isn't running it stopped part way, as when the host restarted:
 * what its finished chunks made stays, and running it again completes it.
 */
export const runs = Effect.fn("KinImportFile.runs")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinImportRunsInput,
) {
  yield* ownerLevel(people, input.orgId);
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    seq: number;
    batch: string;
    action: string;
    personId: string;
    startedAt: number;
    finishedAt: number | null;
    summary: string | null;
  }>`SELECT seq, batch, action, person_id AS "personId", started_at AS "startedAt",
      finished_at AS "finishedAt", summary_json AS summary
    FROM kin_import_runs WHERE org_id = ${input.orgId} ORDER BY seq`.pipe(workFailure);
  const live = yield* (yield* KinImport).running(input.orgId);
  const now = yield* Clock.currentTimeMillis;
  const liveSeqs = new Map(live.flatMap((one) => (one.seq === null ? [] : [[one.seq, one]])));
  const running: Array<KinImportRunning> = [];
  const last = new Map<string, KinImportRuns["runs"][number]>();
  for (const row of rows) {
    const summary = Option.getOrUndefined(decodeSummary(row.summary ?? "{}"));
    const progress = { done: count(summary?.done), of: count(summary?.rows) };
    // Another process's run, as the command line's, beats on its row as it goes.
    if (row.finishedAt === null && (liveSeqs.has(row.seq) || beating(summary?.beat, now))) {
      running.push({
        action: row.action === "undo" ? "undo" : row.action === "check" ? "check" : "apply",
        batch: row.batch,
        file: summary?.file ?? liveSeqs.get(row.seq)?.file ?? null,
        by: KinPersonId.make(row.personId),
        at: iso(row.startedAt),
        ...progress,
      });
      continue;
    }
    // A check keeps nothing: a row of one its host isn't running is left by a stop.
    if (row.action === "check") continue;
    const held = last.get(row.batch);
    if (row.action === "undo") {
      if (held === undefined) continue;
      const { undoStopped: _before, ...rest } = held;
      last.set(
        row.batch,
        row.finishedAt === null
          ? { ...rest, undoStopped: progress }
          : { ...rest, undone: { at: iso(row.startedAt), by: KinPersonId.make(row.personId) } },
      );
      continue;
    }
    const created = (part: { readonly create?: number | undefined } | undefined) =>
      count(part?.create);
    last.delete(row.batch);
    last.set(row.batch, {
      batch: row.batch,
      file: summary?.file ?? null,
      by: KinPersonId.make(row.personId),
      at: iso(row.startedAt),
      added: {
        clients: created(summary?.clients),
        contacts: created(summary?.contacts),
        deals: created(summary?.deals),
        other: created(summary?.entries) + created(summary?.projects),
      },
      undone: null,
      ...(row.finishedAt === null ? { stopped: progress } : {}),
    });
  }
  return {
    runs: [...last.values()].toReversed().slice(0, RUNS_SHOWN),
    running: running.toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
  } satisfies KinImportRuns;
});

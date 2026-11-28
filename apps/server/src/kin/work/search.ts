import * as KinShell from "../shell/KinShell.ts";
import { registerSectionColumns, sectionOfList, sectionOfRegister } from "../shell/sections.ts";
import {
  KIN_CAMPAIGN_SOURCE,
  KIN_MONEY_SEARCH_KINDS,
  type KinOrgId,
  type KinSearchKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { sectionsOf } from "./docBody.ts";
import { listOf } from "./lists.ts";
import { inheritedSensitive, isSuggestion, keptEntry, sensitiveNow } from "./recordRows.ts";
import {
  docKindWords,
  keysOfSearch,
  searchIndexed,
  stepText,
  teamListSearchText,
} from "./searchIndex.ts";
import { findBankList } from "./statements/bankList.ts";
import {
  clientsPlaceSeenBy,
  leadsEntryProject,
  leadsProject,
  listMoneySeenBy,
  notesSeenBy,
  ownMoneyDraft,
  privateListField,
  seenBy,
  teamLists,
  type KinViewer,
} from "./teamView.ts";

/**
 * One search over entries and docs. `team` is what a teammate may find (design 9.1): nothing of
 * a sensitive entry, its own label or inherited, and no field that is sensitive whatever the
 * label. Teammates' searches (`ownerDocs.search`, `leadDocs`) pass it today.
 */
export type Viewer = "owner" | "team";

export type Hit = {
  readonly recordId: string;
  readonly key: string;
  readonly kind: KinSearchKind;
  readonly bankTransaction?: true;
  readonly title: string;
  readonly snippet: string;
  readonly section?: { readonly id: string; readonly title: string };
  /** A contact's client. */
  readonly client?: string;
  readonly sensitive: boolean;
  readonly closed: boolean;
  readonly updatedAt: number;
};

type Row = {
  readonly recordId: string;
  readonly registerId: string;
  readonly key: string;
  readonly title: string;
  readonly state: string;
  readonly confirmed: number;
  readonly archivedAt: number | null;
  readonly updatedAt: number;
  readonly sensitive: number;
  readonly clientKey: string | null;
  readonly part: "public" | "sensitive";
  readonly snippet: string;
  readonly body: string | null;
};

const KINDS: ReadonlyArray<KinSearchKind> = ["work", "clients", "contacts", "projects", "docs"];
/** What a search that asks for `everything` looks through among entries. */
export const EVERY_RECORD_KIND: ReadonlyArray<KinSearchKind> = [
  ...KINDS,
  ...KIN_MONEY_SEARCH_KINDS,
];
const MONEY: ReadonlySet<string> = new Set(KIN_MONEY_SEARCH_KINDS);
const SNIPPET_WORDS = 12;

const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
    .slice(0, 12);

const withoutGrouping = (text: string) =>
  text.replace(/\b\d{1,3}(?:,\d{3})+\b|\b\d{1,2}(?:,\d{2})+,\d{3}\b/g, (amount) =>
    amount.replaceAll(",", ""),
  );
const ungroupedNumber = /\b\d{4,}\b/;
const searchTerms = (text: string) =>
  Array.from(text.matchAll(/"([^"]+)"|([^"]+)/g))
    .flatMap((match) => {
      const words = wordsOf(withoutGrouping(match[1] ?? match[2] ?? ""));
      return match[1] === undefined || words.length === 0 ? words : [words.join(" ")];
    })
    .slice(0, 12);

const groupedDigits = (digits: string, width: number): string =>
  digits.length <= 3
    ? digits
    : digits.slice(0, -3).replace(new RegExp(`(?<=\\d)(?=(?:\\d{${width}})+$)`, "g"), " ") +
      " " +
      digits.slice(-3);

/** Each term must match, or with `any` one of them. The last word may be incomplete. */
const ftsQuery = (terms: ReadonlyArray<string>, any: boolean) =>
  terms
    .map((term, index) => {
      const suffix = index === terms.length - 1 ? "*" : "";
      const forms = new Set([term]);
      if (ungroupedNumber.test(term))
        for (const width of [3, 2])
          forms.add(term.replace(/\b\d{4,}\b/g, (digits) => groupedDigits(digits, width)));
      const match = [...forms].map((form) => `"${form}"${suffix}`);
      return match.length === 1 ? match[0] : `(${match.join(" OR ")})`;
    })
    .join(any ? " OR " : " AND ");

const around = (text: string, words: ReadonlyArray<string>) => {
  const lower = text.toLowerCase();
  const found = words.map((word) => lower.indexOf(word)).filter((i) => i >= 0);
  // Only a doc's kind may have matched: then the text from its start.
  const at = found.length === 0 ? 0 : Math.min(...found);
  const start = Math.max(0, lower.lastIndexOf(" ", Math.max(0, at - 60)) + 1);
  const shown = text
    .slice(start, start + 160)
    .replace(/\s+/g, " ")
    .trim();
  return `${start > 0 ? "…" : ""}${shown}${start + 160 < text.length ? "…" : ""}`;
};

const ownDraftOf = (sql: SqlClient.SqlClient, scope: KinViewer) =>
  scope._tag === "people" && scope.people.length === 1
    ? ownMoneyDraft(sql, scope.people[0]!)
    : sql`0`;

export const search = Effect.fn("KinSearch.search")(function* (
  orgId: KinOrgId,
  input: {
    readonly text: string;
    readonly kinds?: ReadonlyArray<KinSearchKind> | undefined;
    readonly closed?: boolean | undefined;
    readonly limit: number;
    readonly viewer: Viewer;
    /** Whose entries: only what every one of its people sees (`seenBy`). */
    readonly scope: KinViewer;
    /** With nothing that has every word, look again for any of them (`widened`). */
    readonly widen?: boolean;
    /** Deals too, when the caller can open them. */
    readonly deals?: boolean;
    readonly bankTransactions?: boolean;
    /** Exact keys can reach lists that don't take part in ordinary word search. */
    readonly allKeys?: boolean;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const terms = searchTerms(input.text);
  const words = wordsOf(input.text);
  const indexed = yield* searchIndexed();
  if (words.length === 0)
    return { hits: [] as ReadonlyArray<Hit>, indexed, widened: false, keyedCount: 0 };
  const keys = keysOfSearch(input.text);
  const kinds = input.kinds === undefined || input.kinds.length === 0 ? KINDS : input.kinds;
  const shell = yield* KinShell.get(orgId);
  const deals = input.deals === true && KinShell.sectionOn(shell, "deals");
  const shared = kinds.includes("work") ? [...(yield* teamLists(orgId))] : [];
  const bank =
    input.bankTransactions === true && KinShell.sectionOn(shell, "money")
      ? yield* findBankList(orgId)
      : undefined;
  const bankId = bank !== undefined && (bank.archivedAt === null || input.closed) ? bank.id : null;
  const registers = [
    ...(deals ? [...kinds, "deals"] : kinds).filter((kind) => {
      const section = sectionOfList(kind);
      return section === null || KinShell.sectionOn(shell, section);
    }),
    ...shared,
  ];
  const wordRegisters = bankId === null ? registers : [...registers, bankId];
  const keyRegisters = bank === undefined ? registers : [...registers, bank.id];
  const allKeys = input.allKeys ?? (input.kinds === undefined || input.kinds.length === 0);
  const onTeamList = shared.length === 0 ? sql`0 = 1` : sql`r.register_id IN ${sql.in(shared)}`;
  const visible = [
    sql`r.org_id = ${orgId}`,
    // A money list labels every entry private, so a teammate finds what Money shows them, and
    // their own priced draft as they read it.
    ...(input.viewer === "team"
      ? [
          sql`(r.register_id IN ${sql.in(bank === undefined ? KIN_MONEY_SEARCH_KINDS : [...KIN_MONEY_SEARCH_KINDS, bank.id])} OR NOT ${sensitiveNow(sql)}
            OR ${ownDraftOf(sql, input.scope)})`,
          sql`(r.register_id <> 'deals' OR ${clientsPlaceSeenBy(sql, input.scope)})`,
        ]
      : []),
    seenBy(sql, input.scope),
  ];
  const where = [
    ...visible,
    sql`r.register_id IN ${sql.in(wordRegisters)}`,
    ...(input.closed === true
      ? []
      : [sql`NOT (r.state = 'dropped' OR (r.state = 'done' AND ${keptEntry(sql)}))`]),
  ];
  const columns = sql`r.record_id AS "recordId", r.register_id AS "registerId", r.key, r.title,
    r.state, r.confirmed, r.updated_at AS "updatedAt", CASE WHEN r.register_id = 'contacts'
      THEN (SELECT p.key FROM kin_records p WHERE p.org_id = r.org_id
        AND p.record_id = r.party_id AND EXISTS (SELECT 1 FROM kin_records r
          WHERE r.org_id = p.org_id AND r.record_id = p.record_id
            AND ${seenBy(sql, input.scope)})) END AS "clientKey", CASE WHEN r.register_id IN ${sql.in([...MONEY])}
      THEN ${inheritedSensitive(sql)} ELSE ${sensitiveNow(sql)} END AS sensitive`;
  const wordColumns = sql`${columns}, (SELECT g.archived_at FROM kin_registers g
    WHERE g.org_id = r.org_id AND g.register_id = r.register_id) AS "archivedAt",
    CASE WHEN r.register_id = 'docs' THEN ${docBody(sql)} END AS body`;
  const find = Effect.fnUntraced(function* (any: boolean) {
    const regular = [...where, sql`NOT (${onTeamList})`];
    const team = input.viewer === "team";
    // The old index is usable only for rows whose entire indexed text is readable.
    const readableIndex = sql`(r.fields_json = '{}' AND
      (r.register_id = 'work' OR (r.register_id = 'docs' AND r.notes = '')))`;
    const limit = input.limit * 2;
    const indexedRows = indexed
      ? yield* sql<Row>`SELECT ${wordColumns}, m.part,
          snippet(kin_search, 1, '', '', '…', ${SNIPPET_WORDS}) AS snippet
        FROM kin_search s JOIN kin_search_rows m ON m.id = s.rowid
        JOIN kin_records r ON r.org_id = m.org_id AND r.record_id = m.record_id
        WHERE kin_search MATCH ${ftsQuery(terms, any)} AND m.org_id = ${orgId}
          AND ${sql.and(team ? [...regular, readableIndex, sql`m.part = 'public'`] : regular)}
        ORDER BY ${team ? sql`` : sql`bm25(kin_search, 4.0, 1.0, 2.0),`}
          r.updated_at DESC, r.record_id
        LIMIT ${limit}`
      : [];
    const scanned =
      !indexed || team
        ? yield* scan(
            sql,
            terms,
            any,
            indexed ? [...regular, sql`NOT ${readableIndex}`] : regular,
            wordColumns,
            input.viewer,
            limit,
            team ? teamSearchText(sql, input.scope) : undefined,
          )
        : [];
    const found = team
      ? [...indexedRows, ...scanned].sort(
          (a, b) => b.updatedAt - a.updatedAt || (a.recordId < b.recordId ? -1 : 1),
        )
      : [...indexedRows, ...scanned];
    if (shared.length === 0) return found;
    const opened = yield* scan(
      sql,
      terms,
      any,
      [...where, onTeamList],
      wordColumns,
      input.viewer,
      limit,
      team
        ? teamSearchText(sql, input.scope, true)
        : sql`r.title || ' ' || ${teamListSearchText(sql)}`,
    );
    return [...opened, ...found];
  });
  const keyed =
    keys.length === 0 || (!allKeys && keyRegisters.length === 0)
      ? []
      : (yield* sql<Row & Parameters<typeof sectionOfRegister>[0]>`
          SELECT ${columns}, g.archived_at AS "archivedAt", 'public' AS part, r.title AS snippet,
            NULL AS body,
            ${registerSectionColumns(sql)}
          FROM kin_records r JOIN kin_registers g ON g.org_id = r.org_id AND g.register_id = r.register_id
          WHERE ${sql.and([...visible, sql`r.key IN ${sql.in(keys)}`])}
          ORDER BY r.key`).filter((row) => {
          if (keyRegisters.includes(row.registerId)) return true;
          if (
            !allKeys ||
            row.registerId === "deals" ||
            row.registerId === "bank_transactions" ||
            row.name?.trim().toLowerCase() === "bank transactions"
          )
            return false;
          const section = sectionOfRegister(row) ?? sectionOfList(row.id);
          return section === null || KinShell.sectionOn(shell, section);
        });
  const every = wordRegisters.length === 0 || keyed.length >= input.limit ? [] : yield* find(false);
  const widened =
    wordRegisters.length > 0 &&
    keyed.length === 0 &&
    every.length === 0 &&
    terms.length > 1 &&
    input.widen === true &&
    input.limit > 0;
  const rows = [...keyed, ...(widened ? yield* find(true) : every)];
  const seen = new Set<string>();
  const best = rows.filter((row) => !seen.has(row.recordId) && seen.add(row.recordId));
  const shown = best.slice(0, input.limit);
  const hits = shown.map((row): Hit => {
    const section =
      row.body === null
        ? undefined
        : sectionsOf(row.body).find((part) =>
            words[widened ? "some" : "every"]((word) => part.text.toLowerCase().includes(word)),
          );
    return {
      recordId: row.recordId,
      key: row.key,
      // A milestone or a goal opens as an entry does.
      kind: MONEY.has(row.registerId)
        ? (row.registerId as KinSearchKind)
        : ((list) =>
            list === "milestones" || list === "goals" || list === "deals" ? "work" : list)(
            listOf(row.registerId),
          ),
      ...(row.registerId === bank?.id ? { bankTransaction: true as const } : {}),
      title: row.title,
      // A project's notes carry its price and terms, which only its lead and the owner read; a
      // deal's fields (a stage id, a value in minor units) are no one's words.
      snippet:
        (input.viewer === "team" && listOf(row.registerId) === "projects") ||
        row.registerId === "deals"
          ? row.title
          : ((said) => (said === "" ? row.title : said))(withoutIds(row.snippet)),
      ...(section === undefined || section.id === "top"
        ? {}
        : { section: { id: section.id, title: section.title } }),
      ...(row.clientKey === null ? {} : { client: row.clientKey }),
      sensitive: row.sensitive === 1 || row.part === "sensitive",
      closed:
        row.state === "dropped" ||
        (row.state === "done" && !isSuggestion(row)) ||
        row.archivedAt !== null,
      updatedAt: row.updatedAt,
    };
  });
  return {
    hits,
    indexed,
    widened: widened && hits.length > 0,
    keyedCount: Math.min(keyed.length, hits.length),
  };
});

/** A snippet indexed before members' ids were left out of the index, without them. */
const withoutIds = (snippet: string) =>
  snippet
    .replace(/\[?\s*"(?:person|agent):[^"]*"(?:\s*,\s*"(?:person|agent):[^"]*")*\s*\]?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

const docBody = (sql: SqlClient.SqlClient) => sql`COALESCE((SELECT v.body FROM kin_doc_versions v
  WHERE v.org_id = r.org_id AND v.record_id = r.record_id ORDER BY v.version DESC LIMIT 1), '')`;

const fieldsIn = (
  sql: SqlClient.SqlClient,
  keys: ReadonlyArray<string>,
  allowed = sql`1 = 1`,
) => sql`COALESCE((SELECT group_concat(j.value, ' ') FROM json_each(r.fields_json) j
  WHERE j.key IN ${sql.in(keys)} AND j.type <> 'object' AND (${allowed})), '')`;

const teamSearchText = (sql: SqlClient.SqlClient, viewer: KinViewer, shared = false) => {
  const clients = clientsPlaceSeenBy(sql, viewer);
  const projectLead = leadsProject(sql, viewer);
  const notes = shared
    ? sql`r.notes`
    : sql`CASE WHEN r.register_id = 'docs' THEN '' ELSE ${notesSeenBy(sql, viewer)} END`;
  const listFields = sql`COALESCE((SELECT group_concat(j.value, ' ')
    FROM json_each(r.fields_json) j
    JOIN kin_registers g ON g.org_id = r.org_id AND g.register_id = r.register_id
    JOIN json_each(g.definition_json, '$.fields') f ON json_extract(f.value, '$.key') = j.key
    WHERE j.type IN ('text', 'integer', 'real')
      AND json_extract(f.value, '$.type') NOT IN ('person', 'link', 'file', 'money')
      AND j.key NOT IN ('payment', 'payments')
      AND (${listMoneySeenBy(sql, viewer)} OR NOT ${privateListField(sql, sql`j.key`)})), '')`;
  const projects = fieldsIn(
    sql,
    ["repos", "billing", "startsOn", "renewsOn", "noticeDays", "audience"],
    sql`(j.key <> 'billing' OR ${projectLead})`,
  );
  const work = fieldsIn(
    sql,
    ["reason", "where", "size"],
    sql`(j.key = 'reason' OR ${leadsEntryProject(sql, viewer)})`,
  );
  // The deal page resolves stage and campaign references to names.
  const deal = fieldsIn(
    sql,
    ["source", "lostReason", "concerns"],
    sql`(
    (j.key = 'source' AND j.value NOT LIKE ${KIN_CAMPAIGN_SOURCE + "%"})
    OR (j.key = 'lostReason' AND r.state = 'dropped') OR j.key = 'concerns')`,
  );
  const fields = shared
    ? listFields
    : sql`CASE r.register_id
    WHEN 'projects' THEN ${projects}
    WHEN 'clients' THEN CASE WHEN ${clients} THEN
      ${fieldsIn(
        sql,
        ["address", "source", "tags"],
        sql`j.key <> 'source'
        OR j.value NOT LIKE ${KIN_CAMPAIGN_SOURCE + "%"}`,
      )} ELSE '' END
    WHEN 'contacts' THEN ${fieldsIn(
      sql,
      ["role", "tags", "email", "phone", "emails", "phones"],
      sql`(j.key IN ('role', 'tags') OR ${clients})`,
    )}
    WHEN 'deals' THEN ${deal}
    WHEN 'work' THEN ${work} || ' ' || ${stepText(sql)}
    WHEN 'docs' THEN ${docBody(sql)}
    ELSE ${listFields}
  END`;
  return sql`r.title || ' ' || ${notes} || ' ' || ${fields}`;
};

/** Scan the allowed text, newest first, including when SQLite has no FTS5. */
const scan = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  terms: ReadonlyArray<string>,
  any: boolean,
  where: ReadonlyArray<ReturnType<SqlClient.SqlClient["and"]>>,
  columns: ReturnType<SqlClient.SqlClient["and"]>,
  viewer: Viewer,
  limit: number,
  readableText?: ReturnType<SqlClient.SqlClient["and"]>,
) {
  const shown =
    readableText ??
    sql`r.title || ' ' || r.notes || ' ' || ${docBody(sql)} || ' ' || ${stepText(sql)}`;
  const fields =
    viewer === "owner" && readableText === undefined ? sql`r.fields_json || ' '` : sql`''`;
  const text = sql`lower(contents || ' ' || extra)`;
  const matches = terms.map((term) =>
    ungroupedNumber.test(term)
      ? sql`instr(replace(${text}, ',', ''), ${term}) > 0`
      : sql`instr(${text}, ${term}) > 0`,
  );
  const rows = yield* sql<Omit<Row, "part" | "snippet"> & { readonly text: string }>`
    WITH readable AS MATERIALIZED (
      SELECT r.org_id, r.record_id, r.updated_at, ${shown} AS contents,
        (${fields} || ${docKindWords(sql)}) AS extra
      FROM kin_records r WHERE ${sql.and(where)}
    ), matched AS (
      SELECT org_id, record_id, contents FROM readable
      WHERE ${any ? sql.or(matches) : sql.and(matches)}
      ORDER BY updated_at DESC, record_id LIMIT ${limit}
    )
    SELECT ${columns}, m.contents AS text FROM matched m
    JOIN kin_records r ON r.org_id = m.org_id AND r.record_id = m.record_id
    ORDER BY r.updated_at DESC, r.record_id`;
  return rows.map(({ text: found, ...row }): Row => ({
    ...row,
    part: "public",
    snippet: around(found, terms),
  }));
});

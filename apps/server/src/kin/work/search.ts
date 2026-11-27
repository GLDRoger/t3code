import * as KinShell from "../shell/KinShell.ts";
import { registerSectionColumns, sectionOfList, sectionOfRegister } from "../shell/sections.ts";
import { KIN_MONEY_SEARCH_KINDS, type KinOrgId, type KinSearchKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { sectionsOf } from "./docBody.ts";
import { latestOf } from "./docs.ts";
import { listOf } from "./lists.ts";
import { inheritedSensitive, sensitiveNow } from "./recordRows.ts";
import {
  docKindWords,
  keysOfSearch,
  searchIndexed,
  stepText,
  teamListSearchText,
} from "./searchIndex.ts";
import { findBankList } from "./statements/bankList.ts";
import { ownMoneyDraft, seenBy, teamLists, type KinViewer } from "./teamView.ts";

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
  readonly updatedAt: number;
  readonly sensitive: number;
  readonly clientKey: string | null;
  readonly part: "public" | "sensitive";
  readonly snippet: string;
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

/** Every word must match, or with `any` one of them; the last may be the start of one. */
const ftsQuery = (words: ReadonlyArray<string>, any: boolean) =>
  words
    .map((word, index) => `"${word}"${index === words.length - 1 ? "*" : ""}`)
    .join(any ? " OR " : " ");

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
        ]
      : []),
    seenBy(sql, input.scope),
  ];
  const where = [
    ...visible,
    sql`r.register_id IN ${sql.in(wordRegisters)}`,
    ...(input.closed === true ? [] : [sql`r.state NOT IN ('done', 'dropped')`]),
  ];
  const columns = sql`r.record_id AS "recordId", r.register_id AS "registerId", r.key, r.title,
    r.state, r.updated_at AS "updatedAt", CASE WHEN r.register_id = 'contacts'
      THEN (SELECT p.key FROM kin_records p WHERE p.org_id = r.org_id
        AND p.record_id = r.party_id AND EXISTS (SELECT 1 FROM kin_records r
          WHERE r.org_id = p.org_id AND r.record_id = p.record_id
            AND ${seenBy(sql, input.scope)})) END AS "clientKey", CASE WHEN r.register_id IN ${sql.in([...MONEY])}
      THEN ${inheritedSensitive(sql)} ELSE ${sensitiveNow(sql)} END AS sensitive`;
  const find = (any: boolean) => {
    const regular = [...where, sql`NOT (${onTeamList})`];
    return Effect.gen(function* () {
      const found = indexed
        ? yield* sql<Row>`SELECT ${columns}, m.part,
            snippet(kin_search, 1, '', '', '…', ${SNIPPET_WORDS}) AS snippet
          FROM kin_search s JOIN kin_search_rows m ON m.id = s.rowid
          JOIN kin_records r ON r.org_id = m.org_id AND r.record_id = m.record_id
          WHERE kin_search MATCH ${ftsQuery(words, any)} AND m.org_id = ${orgId}
            AND ${sql.and([...regular, ...(input.viewer === "team" ? [sql`m.part = 'public'`] : [])])}
          ORDER BY bm25(kin_search, 4.0, 1.0, 2.0), r.updated_at DESC, r.record_id
          LIMIT ${input.limit * 2}`
        : yield* scan(sql, words, any, regular, columns, input.viewer, input.limit * 2);
      if (shared.length === 0) return found;
      // Match and show the same allowed text even if the FTS row predates the list's definition.
      const opened = yield* scan(
        sql,
        words,
        any,
        [...where, onTeamList],
        columns,
        input.viewer,
        input.limit * 2,
        teamListSearchText(sql),
      );
      return [...opened, ...found];
    });
  };
  const keyed =
    keys.length === 0 || (!allKeys && keyRegisters.length === 0)
      ? []
      : (yield* sql<
          Row & Parameters<typeof sectionOfRegister>[0] & { readonly archivedAt: number | null }
        >`
          SELECT ${columns}, 'public' AS part, r.title AS snippet, ${registerSectionColumns(sql)},
            g.archived_at AS "archivedAt"
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
  const exact = new Map(keyed.map((row) => [row.recordId, row]));
  const every = wordRegisters.length === 0 || keyed.length >= input.limit ? [] : yield* find(false);
  const widened =
    wordRegisters.length > 0 &&
    keyed.length === 0 &&
    every.length === 0 &&
    words.length > 1 &&
    input.widen === true &&
    input.limit > 0;
  const rows = [...keyed, ...(widened ? yield* find(true) : every)];
  const seen = new Set<string>();
  const best = rows.filter((row) => !seen.has(row.recordId) && seen.add(row.recordId));
  const shown = best.slice(0, input.limit);
  const docs = yield* latestOf(
    orgId,
    shown
      .slice(keyed.length)
      .filter((row) => listOf(row.registerId) === "docs")
      .map((row) => row.recordId),
  );
  const hits = shown.map((row): Hit => {
    const body = docs.get(row.recordId)?.body;
    const section =
      body === undefined
        ? undefined
        : sectionsOf(body).find((part) =>
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
        row.state === "done" ||
        row.state === "dropped" ||
        (exact.get(row.recordId)?.archivedAt ?? null) !== null,
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

/** Without FTS5: every word, or with `any` one of them, somewhere in the same text, newest first. */
const scan = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  words: ReadonlyArray<string>,
  any: boolean,
  where: ReadonlyArray<ReturnType<SqlClient.SqlClient["and"]>>,
  columns: ReturnType<SqlClient.SqlClient["and"]>,
  viewer: Viewer,
  limit: number,
  safeListText?: ReturnType<SqlClient.SqlClient["and"]>,
) {
  const body = sql`COALESCE((SELECT v.body FROM kin_doc_versions v WHERE v.org_id = r.org_id
    AND v.record_id = r.record_id ORDER BY v.version DESC LIMIT 1), '')`;
  // The scan reads fields only for the owner: which are sensitive is the index's job.
  const fields =
    viewer === "owner" && safeListText === undefined ? sql`r.fields_json || ' ' ||` : sql``;
  const shown =
    safeListText === undefined
      ? sql`r.title || ' ' || r.notes || ' ' || ${body} || ' ' || ${stepText(sql)}`
      : sql`r.title || ' ' || ${safeListText}`;
  const text = sql`lower(${shown} || ' ' || ${fields} ${docKindWords(sql)})`;
  const rows = yield* sql<Omit<Row, "part" | "snippet"> & { readonly text: string }>`
    SELECT ${columns}, ${shown} AS text
    FROM kin_records r
    WHERE ${sql.and([
      ...where,
      ((found) => (any ? sql.or(found) : sql.and(found)))(
        words.map((word) => sql`instr(${text}, ${word}) > 0`),
      ),
    ])}
    ORDER BY r.updated_at DESC, r.record_id LIMIT ${limit}`;
  return rows.map(({ text: found, ...row }): Row => ({
    ...row,
    part: "public",
    snippet: around(found, words),
  }));
});

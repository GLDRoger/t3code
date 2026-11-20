import { KIN_MONEY_SEARCH_KINDS, type KinOrgId, type KinSearchKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { sectionsOf } from "./docBody.ts";
import { latestOf } from "./docs.ts";
import { listOf } from "./lists.ts";
import { inheritedSensitive, sensitiveNow } from "./recordRows.ts";
import { searchIndexed } from "./searchIndex.ts";
import { seenBy, type KinViewer } from "./teamView.ts";

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
  const at = Math.max(
    0,
    Math.min(...words.map((word) => lower.indexOf(word)).filter((i) => i >= 0)),
  );
  const start = Math.max(0, lower.lastIndexOf(" ", Math.max(0, at - 60)) + 1);
  const shown = text
    .slice(start, start + 160)
    .replace(/\s+/g, " ")
    .trim();
  return `${start > 0 ? "…" : ""}${shown}${start + 160 < text.length ? "…" : ""}`;
};

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
    /** Deals among `work`, and a deal by its exact key: a person's own search box asks. */
    readonly deals?: boolean;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const words = wordsOf(input.text);
  const indexed = yield* searchIndexed();
  if (words.length === 0) return { hits: [] as ReadonlyArray<Hit>, indexed, widened: false };
  const kinds = input.kinds === undefined || input.kinds.length === 0 ? KINDS : input.kinds;
  const registers: ReadonlyArray<string> =
    input.deals === true && kinds.includes("work") ? [...kinds, "deals"] : kinds;
  const where = [
    sql`r.org_id = ${orgId}`,
    sql`r.register_id IN ${sql.in(registers)}`,
    ...(input.closed === true ? [] : [sql`r.state NOT IN ('done', 'dropped')`]),
    // A money list labels every entry private, so a teammate finds what Money shows them.
    ...(input.viewer === "team"
      ? [sql`(r.register_id IN ${sql.in([...MONEY])} OR NOT ${sensitiveNow(sql)})`]
      : []),
    seenBy(sql, input.scope),
  ];
  const columns = sql`r.record_id AS "recordId", r.register_id AS "registerId", r.key, r.title,
    r.state, r.updated_at AS "updatedAt", CASE WHEN r.register_id = 'contacts'
      THEN (SELECT p.key FROM kin_records p WHERE p.org_id = r.org_id
        AND p.record_id = r.party_id AND EXISTS (SELECT 1 FROM kin_records r
          WHERE r.org_id = p.org_id AND r.record_id = p.record_id
            AND ${seenBy(sql, input.scope)})) END AS "clientKey", CASE WHEN r.register_id IN ${sql.in([...MONEY])}
      THEN ${inheritedSensitive(sql)} ELSE ${sensitiveNow(sql)} END AS sensitive`;
  const find = (any: boolean) =>
    indexed
      ? sql<Row>`SELECT ${columns}, m.part,
          snippet(kin_search, 1, '', '', '…', ${SNIPPET_WORDS}) AS snippet
        FROM kin_search s JOIN kin_search_rows m ON m.id = s.rowid
        JOIN kin_records r ON r.org_id = m.org_id AND r.record_id = m.record_id
        WHERE kin_search MATCH ${ftsQuery(words, any)} AND m.org_id = ${orgId}
          AND ${sql.and([...where, ...(input.viewer === "team" ? [sql`m.part = 'public'`] : [])])}
        ORDER BY bm25(kin_search, 4.0, 1.0), r.updated_at DESC, r.record_id
        LIMIT ${input.limit * 2}`
      : scan(sql, words, any, where, columns, input.viewer, input.limit * 2);
  // No index holds a key; a deal's, typed whole, finds that deal first.
  const typed = input.text.trim().toUpperCase();
  const keyed =
    input.deals === true && /^DL-\d{1,9}$/.test(typed)
      ? yield* sql<Row>`SELECT ${columns}, 'public' AS part, r.title AS snippet FROM kin_records r
          WHERE ${sql.and([...where, sql`r.register_id = 'deals'`, sql`r.key = ${typed}`])}`
      : [];
  const every = yield* find(false);
  const widened = every.length === 0 && words.length > 1 && input.widen === true;
  const rows = [...keyed, ...(widened ? yield* find(true) : every)];
  const seen = new Set<string>();
  const best = rows.filter((row) => !seen.has(row.recordId) && seen.add(row.recordId));
  const shown = best.slice(0, input.limit);
  const docs = yield* latestOf(
    orgId,
    shown.filter((row) => listOf(row.registerId) === "docs").map((row) => row.recordId),
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
      closed: row.state === "done" || row.state === "dropped",
      updatedAt: row.updatedAt,
    };
  });
  return { hits, indexed, widened: widened && hits.length > 0 };
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
) {
  const body = sql`COALESCE((SELECT v.body FROM kin_doc_versions v WHERE v.org_id = r.org_id
    AND v.record_id = r.record_id ORDER BY v.version DESC LIMIT 1), '')`;
  // The scan reads fields only for the owner: which are sensitive is the index's job.
  const text =
    viewer === "owner"
      ? sql`lower(r.title || ' ' || r.notes || ' ' || r.fields_json || ' ' || ${body})`
      : sql`lower(r.title || ' ' || r.notes || ' ' || ${body})`;
  const rows = yield* sql<Omit<Row, "part" | "snippet"> & { readonly text: string }>`
    SELECT ${columns}, r.title || ' ' || r.notes || ' ' || ${body} AS text
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

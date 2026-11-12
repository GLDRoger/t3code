import type { KinOrgId, KinSearchKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { sectionsOf } from "./docBody.ts";
import { latestOf } from "./docs.ts";
import { listOf } from "./lists.ts";
import { sensitiveNow } from "./recordRows.ts";
import { searchIndexed } from "./searchIndex.ts";

/**
 * One search over entries and docs. `team` is what a teammate may find (design 9.1): nothing of
 * a sensitive entry, its own label or inherited, and no field that is sensitive whatever the
 * label. Only owner-only callers exist yet; the teammate view will pass `team`.
 */
export type Viewer = "owner" | "team";

export type Hit = {
  readonly recordId: string;
  readonly key: string;
  readonly kind: KinSearchKind;
  readonly title: string;
  readonly snippet: string;
  readonly section?: { readonly id: string; readonly title: string };
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
  readonly part: "public" | "sensitive";
  readonly snippet: string;
};

const KINDS: ReadonlyArray<KinSearchKind> = ["work", "clients", "contacts", "projects", "docs"];
const SNIPPET_WORDS = 12;

const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
    .slice(0, 12);

/** Every word must match; the last may be the start of one, as someone still typing it. */
const ftsQuery = (words: ReadonlyArray<string>) =>
  words.map((word, index) => `"${word}"${index === words.length - 1 ? "*" : ""}`).join(" ");

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
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const words = wordsOf(input.text);
  const indexed = yield* searchIndexed();
  if (words.length === 0) return { hits: [] as ReadonlyArray<Hit>, indexed };
  const kinds = input.kinds === undefined || input.kinds.length === 0 ? KINDS : input.kinds;
  const where = [
    sql`r.org_id = ${orgId}`,
    sql`r.register_id IN ${sql.in(kinds)}`,
    ...(input.closed === true ? [] : [sql`r.state NOT IN ('done', 'dropped')`]),
    ...(input.viewer === "team" ? [sql`NOT ${sensitiveNow(sql)}`] : []),
  ];
  const columns = sql`r.record_id AS "recordId", r.register_id AS "registerId", r.key, r.title,
    r.state, r.updated_at AS "updatedAt", ${sensitiveNow(sql)} AS sensitive`;
  const rows = indexed
    ? yield* sql<Row>`SELECT ${columns}, m.part,
          snippet(kin_search, 1, '', '', '…', ${SNIPPET_WORDS}) AS snippet
        FROM kin_search s JOIN kin_search_rows m ON m.id = s.rowid
        JOIN kin_records r ON r.org_id = m.org_id AND r.record_id = m.record_id
        WHERE kin_search MATCH ${ftsQuery(words)} AND m.org_id = ${orgId}
          AND ${sql.and([...where, ...(input.viewer === "team" ? [sql`m.part = 'public'`] : [])])}
        ORDER BY bm25(kin_search, 4.0, 1.0), r.updated_at DESC, r.record_id
        LIMIT ${input.limit * 2}`
    : yield* scan(sql, words, where, columns, input.viewer, input.limit * 2);
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
            words.every((word) => part.text.toLowerCase().includes(word)),
          );
    return {
      recordId: row.recordId,
      key: row.key,
      kind: listOf(row.registerId),
      title: row.title,
      snippet: row.snippet.trim() === "" ? row.title : row.snippet,
      ...(section === undefined || section.id === "top"
        ? {}
        : { section: { id: section.id, title: section.title } }),
      sensitive: row.sensitive === 1 || row.part === "sensitive",
      closed: row.state === "done" || row.state === "dropped",
      updatedAt: row.updatedAt,
    };
  });
  return { hits, indexed };
});

/** Without FTS5: every word somewhere in the same text, newest first. */
const scan = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  words: ReadonlyArray<string>,
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
    WHERE ${sql.and([...where, ...words.map((word) => sql`instr(${text}, ${word}) > 0`)])}
    ORDER BY r.updated_at DESC, r.record_id LIMIT ${limit}`;
  return rows.map(({ text: found, ...row }): Row => ({
    ...row,
    part: "public",
    snippet: around(found, words),
  }));
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { indexWhere } from "../../work/searchIndex.ts";

/**
 * The search index gains a `kind` column, a doc's kind as words, so "playbooks" finds the default
 * playbooks whose text never says it. FTS5 can't add a column: the index is rebuilt from what is
 * stored. Without FTS5 (no `kin_search`) search scans, and there is nothing to rebuild.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const indexed = yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'kin_search'`;
  if (indexed.length === 0) return;
  yield* sql`DROP TABLE kin_search`;
  yield* sql`CREATE VIRTUAL TABLE kin_search USING fts5(
    title, body, kind, tokenize = 'unicode61 remove_diacritics 2')`;
  yield* indexWhere(sql, sql.and([sql`1 = 1`]));
});

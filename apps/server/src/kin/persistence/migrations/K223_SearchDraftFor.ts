import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { indexWhere } from "../../work/searchIndex.ts";

/**
 * Whom a draft is for is a person id, which search no longer indexes: rows indexed before keep
 * it in their text, and a snippet showed it. Those entries are indexed again from what is stored.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const indexed = yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'kin_search'`;
  if (indexed.length === 0) return;
  const drafts = sql`json_extract(r.fields_json, '$.draftFor') IS NOT NULL`;
  yield* sql`DELETE FROM kin_search WHERE rowid IN (SELECT m.id FROM kin_search_rows m
    JOIN kin_records r ON r.org_id = m.org_id AND r.record_id = m.record_id WHERE ${drafts})`;
  yield* indexWhere(sql, sql.and([drafts]));
});

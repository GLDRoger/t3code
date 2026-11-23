import type { KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * What a push was about, by key (`kin_push_about`): `task:<record key>` for a notice or bundle of
 * tasks, `fact:<fact key>` for Kin's notice of pulse facts. Kept apart from the push services so
 * the pulse and held delivery can note it without importing them.
 */

/** What `ref` is about, of keys starting `prefix`, without it. */
export const aboutOf = Effect.fn("KinPushTopics.aboutOf")(function* (
  orgId: KinOrgId,
  ref: string,
  prefix: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ key: string }>`SELECT key FROM kin_push_about
    WHERE org_id = ${orgId} AND ref = ${ref} AND substr(key, 1, ${prefix.length}) = ${prefix}
    ORDER BY key`;
  return rows.map((row) => row.key.slice(prefix.length));
});

/** Notes what `ref` (a push's topic or a notice's message) is about, by key. */
export const noteAbout = Effect.fn("KinPushTopics.noteAbout")(function* (
  orgId: KinOrgId,
  ref: string,
  keys: ReadonlyArray<string>,
) {
  if (keys.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  for (const key of new Set(keys))
    yield* sql`INSERT INTO kin_push_about (org_id, ref, key, at)
      VALUES (${orgId}, ${ref}, ${key}, ${now}) ON CONFLICT (org_id, ref, key) DO NOTHING`;
});

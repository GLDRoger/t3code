import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { WatchContext, WatchRow } from "./kind.ts";

/** "Brightwell Labs'" and "Lumen Studio's". */
export const possessive = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

const encodeSince = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ id: Schema.String, record: Schema.String, since: Schema.Number })),
  ),
);

/** Watches on a record that changed since their last look (or since they were made). */
export const recordMoved = Effect.fn("KinWatch.recordMoved")(function* (
  ctx: WatchContext,
  watches: ReadonlyArray<WatchRow>,
) {
  const sql = yield* SqlClient.SqlClient;
  const since = watches.flatMap((watch) =>
    watch.recordId === null
      ? []
      : [{ id: watch.watchId, record: watch.recordId, since: watch.lookedAt ?? watch.createdAt }],
  );
  if (since.length === 0) return new Set<string>();
  const rows = yield* sql<{ id: string }>`SELECT json_extract(w.value, '$.id') AS id
    FROM json_each(${yield* encodeSince(since)}) w
    WHERE EXISTS (SELECT 1 FROM kin_record_changes ch WHERE ch.org_id = ${ctx.orgId}
      AND ch.record_id = json_extract(w.value, '$.record') AND ch.at > json_extract(w.value, '$.since'))
    ORDER BY id`;
  return new Set(rows.map((row) => row.id));
});

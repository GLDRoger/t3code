import {
  KinTrigger,
  type KinMemoryItemId,
  type KinOrgId,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";

export interface MemoryItem {
  readonly head: MemoryItemHead;
  readonly body: string;
}

export class MemoryHistoryError extends Schema.TaggedError<MemoryHistoryError>()(
  "MemoryHistoryError",
  { orgId: Schema.String, cause: Schema.Defect() },
) {}

export class MemoryCache extends Context.Service<
  MemoryCache,
  {
    readonly read: (
      orgId: KinOrgId,
      id: KinMemoryItemId,
    ) => Effect.Effect<void, MemoryHistoryError>;
    readonly ownerTimeZone: (orgId: KinOrgId) => Effect.Effect<string, MemoryHistoryError>;
    readonly lastReads: (
      orgId: KinOrgId,
    ) => Effect.Effect<Readonly<Record<string, number>>, MemoryHistoryError>;
  }
>()("t3/kin/memory/MemoryCache") {}

const decodeTimeZone = Schema.decodeUnknownEffect(KinTrigger.fields.timeZone);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return MemoryCache.of({
    read: Effect.fn("MemoryCache.read")(function* (orgId, id) {
      const now = yield* Clock.currentTimeMillis;
      // Memory.readItem validates the item against this organization's committed snapshot.
      yield* sql`
        INSERT INTO kin_memory_reads (org_id, item_id, last_read_at)
        VALUES (${orgId}, ${id}, ${now})
        ON CONFLICT (org_id, item_id) DO UPDATE SET last_read_at = excluded.last_read_at
      `.pipe(
        Effect.mapError(toPersistenceSqlError("MemoryCache.read")),
        Effect.mapError((cause) => new MemoryHistoryError({ orgId, cause })),
      );
    }),
    ownerTimeZone: Effect.fn("MemoryCache.ownerTimeZone")(function* (orgId) {
      const rows = yield* sql<{ time_zone: unknown }>`
        SELECT time_zone FROM kin_trigger_settings WHERE org_id = ${orgId} ORDER BY org_id
      `.pipe(
        Effect.mapError(toPersistenceSqlError("MemoryCache.ownerTimeZone")),
        Effect.mapError((cause) => new MemoryHistoryError({ orgId, cause })),
      );
      if (rows.length === 0) return "UTC";
      return yield* decodeTimeZone(rows[0]?.time_zone).pipe(
        Effect.catch(() =>
          Effect.logWarning("Invalid memory owner time zone; using UTC", { orgId }).pipe(
            Effect.as("UTC"),
          ),
        ),
      );
    }),
    lastReads: Effect.fn("MemoryCache.lastReads")(function* (orgId) {
      const rows = yield* sql<{ item_id: string; last_read_at: number }>`
        SELECT item_id, last_read_at FROM kin_memory_reads WHERE org_id = ${orgId} ORDER BY item_id
      `.pipe(
        Effect.mapError(toPersistenceSqlError("MemoryCache.lastReads")),
        Effect.mapError((cause) => new MemoryHistoryError({ orgId, cause })),
      );
      return Object.fromEntries(rows.map((row) => [row.item_id, row.last_read_at]));
    }),
  });
});

export const layer = Layer.effect(MemoryCache, make);

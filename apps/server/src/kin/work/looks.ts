import type { KinOrgId, KinPersonId, KinRecordId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { notFound, workFailure } from "./recordRows.ts";
import { type KinViewer, seenBy } from "./teamView.ts";

export const lookedAt = Effect.fn("KinLooks.lookedAt")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ lookedAt: number }>`SELECT looked_at AS "lookedAt" FROM kin_looks
    WHERE org_id = ${orgId} AND person_id = ${personId} AND record_id = ${recordId}`;
  return row?.lookedAt ?? null;
});

// Only the explicit screen RPC advances the mark. Preview and background reads share the same entry reads.
export const look = Effect.fn("KinLooks.look")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordId: KinRecordId,
  upTo: number,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* sql`INSERT INTO kin_looks (org_id, person_id, record_id, looked_at)
    SELECT r.org_id, ${personId}, r.record_id, ${Math.min(upTo, now)}
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.record_id = ${recordId}
      AND ${seenBy(sql, viewer)}
    ON CONFLICT (org_id, person_id, record_id)
    DO UPDATE SET looked_at = MAX(kin_looks.looked_at, excluded.looked_at)
    RETURNING looked_at`.pipe(workFailure);
  if (rows.length === 0) return yield* notFound("with that id");
});

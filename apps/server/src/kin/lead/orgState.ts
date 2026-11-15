import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { ownerLevel } from "../people/KinAccess.ts";

/** Owner-level: the owner or a co-owner, by stored kind. */
export const isOrgOwner = ownerLevel;

export const STOP_REASON = "Stopped by the Kin stop switch.";

/** The stop switch. Paused orgs start no wake-up, worker, dream or routine. */
export const isOrgPaused = Effect.fn("KinOrgState.isOrgPaused")(
  function* (orgId: KinOrgId) {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`SELECT 1 FROM kin_org_state WHERE org_id = ${orgId} AND paused = 1 ORDER BY org_id`;
    return rows.length > 0;
  },
  Effect.mapError(toPersistenceSqlError("KinOrgState.isOrgPaused")),
);

import type { KinActionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRetiredActions, RETIRED_ACTION_REASON } from "../lead/Retirement.ts";
import * as Audit from "./Audit.ts";
import * as PendingActions from "./PendingActions.ts";

/**
 * A waiting request is cancelled, and an approved one, or a claimed one whose write hasn't started,
 * is voided, all audited. One already sending is left to reconciliation.
 */
export const layer = Layer.effect(
  KinRetiredActions,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const actions = yield* PendingActions.KinPendingActions;
    return {
      close: Effect.fn("KinRetiredActions.close")(function* ({ orgId, agentId }) {
        for (const row of yield* sql<{ actionId: KinActionId; revision: number; state: string }>`
            SELECT action_id AS "actionId", revision, state FROM kin_pending_actions
            WHERE org_id = ${orgId} AND requested_by_agent_id = ${agentId}
              AND state IN ('awaiting_approval', 'approved')
            ORDER BY action_id`)
          yield* actions.transition({
            orgId,
            actionId: row.actionId,
            revision: row.revision,
            to: row.state === "approved" ? "voided" : "cancelled",
            reason: RETIRED_ACTION_REASON,
          });
        yield* actions.voidRetiredClaims({ orgId, agentId });
      }),
    };
  }),
);

/** The host's CLI has no approvals layer of its own. */
export const hostLayer = layer.pipe(
  Layer.provide(PendingActions.layer),
  Layer.provide(Audit.layer),
);

import { KinApprovalError, type KinGrant, type KinPendingAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as KinLevels from "../../lead/KinLevels.ts";

const refuse = (message: string) =>
  Effect.fail(new KinApprovalError({ reason: "invalid_state", message }));

const REFUSALS: Record<KinLevels.KinLevelRefused["reason"], string> = {
  not_a_lead: "The agent is retired or gone.",
  conflict: "What the agent may do changed meanwhile.",
  not_found: "The agent is no longer in that chat.",
  invalid_level: "What the agent may do no longer matches what was approved.",
  not_granted: "No claimed owner grant backs this change.",
};
const refusal = (error: KinLevels.KinLevelRefused) => refuse(REFUSALS[error.reason]);

/**
 * Raises a lead's level, or a chat's cap, once the owner's grant for the `set_level` action is
 * verified and claimed. `approvals/layer.ts` registers it with the executor.
 */
export const makeSetLevelHandler = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const reached = Effect.fn("setLevel.reached")(function* (action: KinPendingAction) {
    if (action.kind !== "set_level" || action.target._tag !== "level")
      return yield* refuse("Not a permission change.");
    const target = action.target;
    const level = yield* KinLevels.effectiveLevel({
      orgId: action.orgId,
      agentId: target.agentId,
      chatId: target.chatId,
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTags({ KinLevelRefused: refusal }),
    );
    return KinLevels.atLeast(level, target.level);
  });

  const precheck = Effect.fn("setLevel.precheck")(function* (action: KinPendingAction) {
    if (yield* reached(action)) return yield* refuse("The agent can already do this.");
  });

  const run = Effect.fn("setLevel.run")(function* (action: KinPendingAction, _grant: KinGrant) {
    yield* KinLevels.raiseByGrant({ orgId: action.orgId, actionId: action.id }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTags({ KinLevelRefused: refusal }),
    );
    return "succeeded" as const;
  });

  const reconcile = Effect.fn("setLevel.reconcile")(function* (action: KinPendingAction) {
    return (yield* reached(action)) ? ("done" as const) : ("not_done" as const);
  });

  // A local write with no GitHub credential, so the hygiene check doesn't gate it.
  return { kind: "set_level" as const, credentialCheck: false, precheck, run, reconcile };
});

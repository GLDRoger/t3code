import { KinApprovalError, type KinGrant, type KinPendingAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ApproverKeys } from "../ApproverKeys.ts";

const refuse = (message: string) =>
  Effect.fail(new KinApprovalError({ reason: "invalid_state", message }));

/**
 * Activates a later approver key once an existing key's grant for it is verified and claimed.
 * Shaped as spec section 6's `KinActionHandler`; APPR-9 registers it with the executor.
 */
export const makeRegisterApproverKeyHandler = Effect.gen(function* () {
  const keys = yield* ApproverKeys;

  const pendingKey = Effect.fn("registerApproverKey.pendingKey")(function* (
    action: KinPendingAction,
  ) {
    if (action.kind !== "register_approver_key" || action.target._tag !== "device_key")
      return yield* refuse("Not an approver key registration.");
    const target = action.target;
    const key = yield* keys.get({ orgId: action.orgId, thumbprint: target.thumbprint });
    if (Option.isNone(key)) return yield* refuse("The key to add no longer exists.");
    return { target, key: key.value };
  });

  const precheck = Effect.fn("registerApproverKey.precheck")(function* (action: KinPendingAction) {
    const { target, key } = yield* pendingKey(action);
    if (key.state !== "pending") return yield* refuse("The key isn't waiting to be added.");
    // The card showed the target; the stored key must still be what it described.
    if (!key.attested || key.hardware !== target.hardware)
      return yield* refuse("The key doesn't match what was approved.");
  });

  const run = Effect.fn("registerApproverKey.run")(function* (
    action: KinPendingAction,
    grant: KinGrant,
  ) {
    yield* precheck(action);
    const { target } = yield* pendingKey(action);
    if (grant.keyThumbprint === target.thumbprint)
      return yield* refuse("A key can't approve itself.");
    const activated = yield* keys.activateByGrant({
      orgId: action.orgId,
      thumbprint: target.thumbprint,
    });
    return activated ? ("succeeded" as const) : yield* refuse("The key couldn't be activated.");
  });

  const reconcile = Effect.fn("registerApproverKey.reconcile")(function* (
    action: KinPendingAction,
  ) {
    const { key } = yield* pendingKey(action);
    return key.state === "active" ? ("done" as const) : ("not_done" as const);
  });

  // Gated like the GitHub kinds (spec section 12).
  return {
    kind: "register_approver_key" as const,
    credentialCheck: true,
    precheck,
    run,
    reconcile,
  };
});

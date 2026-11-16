import type { KinGrant, KinPendingAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as ActionExecutor from "./ActionExecutor.ts";
import * as ActionHandlers from "./ActionHandlers.ts";
import * as ApproverKeys from "./ApproverKeys.ts";
import * as Audit from "./Audit.ts";
import * as AttestationTrust from "./attestation/AttestationTrust.ts";
import * as GrantPorts from "./GrantPorts.ts";
import * as GrantVerifier from "./GrantVerifier.ts";
import { makeSetLevelHandler } from "./handlers/setLevel.ts";
import * as PendingActions from "./PendingActions.ts";

const refused = (error: { readonly message: string }) =>
  new ActionHandlers.KinExecError({ reason: "refused", detail: error.message });

/** `set_level`'s handler takes the stored grant only and reports a bare success. */
const grantOnly = <R>(
  make: Effect.Effect<
    {
      readonly kind: ActionHandlers.KinActionHandler["kind"];
      readonly precheck: (
        action: KinPendingAction,
      ) => Effect.Effect<void, { readonly message: string }>;
      readonly run: (
        action: KinPendingAction,
        grant: KinGrant,
      ) => Effect.Effect<unknown, { readonly message: string }>;
      readonly reconcile: (
        action: KinPendingAction,
      ) => Effect.Effect<"done" | "not_done" | "unknown", { readonly message: string }>;
    },
    never,
    R
  >,
) =>
  Effect.map(make, (handler): ActionHandlers.KinActionHandler => ({
    kind: handler.kind,
    precheck: (action) => handler.precheck(action).pipe(Effect.mapError(refused)),
    run: (action, { grant }) =>
      handler.run(action, grant).pipe(Effect.as({}), Effect.mapError(refused)),
    reconcile: (action) =>
      handler.reconcile(action).pipe(Effect.orElseSucceed(() => "unknown" as const)),
  }));

// Only levels run here; a stored merge or delete-branch approval has no handler and is voided.
const handlers = Layer.effect(
  ActionHandlers.KinActionHandlers,
  Effect.map(grantOnly(makeSetLevelHandler), (setLevel) => ActionHandlers.make([setLevel])),
);

/**
 * The executor and its worker, with nothing in the output: context lookups go by key string, so
 * anything here would reach every service holding `kin.services`. Built on top of the layer that
 * supplies `KinPendingActions`, so it takes the very approvals that instance publishes.
 */
export const executorLayer = Layer.empty.pipe(
  Layer.provide(
    ActionExecutor.layer.pipe(
      Layer.provide(Layer.merge(handlers, PendingActions.ledgerLayer)),
      Layer.provide(GrantPorts.orgRolesLayer),
      Layer.provide(Audit.layer),
      Layer.provide(KinPersistence.layer),
    ),
  ),
);

/** Push routing and level control read pending actions, so they stay in the output. */
export const layer = GrantVerifier.layer.pipe(
  Layer.provideMerge(ApproverKeys.layer),
  Layer.provideMerge(PendingActions.layer),
  Layer.provide(
    Layer.mergeAll(
      AttestationTrust.layer.pipe(Layer.provide(FetchHttpClient.layer)),
      GrantPorts.orgRolesLayer,
      GrantPorts.liveTargetsUnconfiguredLayer,
      GrantPorts.auditLayer,
    ),
  ),
  Layer.provide(Audit.layer),
  Layer.provide(KinPersistence.layer),
);

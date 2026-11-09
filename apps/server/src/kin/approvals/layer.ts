import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as ApproverKeys from "./ApproverKeys.ts";
import * as Audit from "./Audit.ts";
import * as AttestationTrust from "./attestation/AttestationTrust.ts";
import * as GrantPorts from "./GrantPorts.ts";
import * as GrantVerifier from "./GrantVerifier.ts";
import * as PendingActions from "./PendingActions.ts";

// Push routing reads pending actions, so they stay in the layer's output.
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

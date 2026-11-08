import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as ApproverKeys from "./ApproverKeys.ts";
import * as AttestationTrust from "./attestation/AttestationTrust.ts";
import * as GrantPorts from "./GrantPorts.ts";
import * as GrantVerifier from "./GrantVerifier.ts";
import * as PendingActions from "./PendingActions.ts";

export const layer = GrantVerifier.layer.pipe(
  Layer.provideMerge(ApproverKeys.layer),
  Layer.provide(
    Layer.mergeAll(
      PendingActions.layer,
      AttestationTrust.layer.pipe(Layer.provide(FetchHttpClient.layer)),
      GrantPorts.orgRolesLayer,
      GrantPorts.liveTargetsUnconfiguredLayer,
      GrantPorts.auditLogLayer,
    ),
  ),
  Layer.provide(KinPersistence.layer),
);

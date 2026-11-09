import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as ApproverKeys from "./ApproverKeys.ts";
import * as Audit from "./Audit.ts";
import * as AttestationTrust from "./attestation/AttestationTrust.ts";
import * as PendingActions from "./PendingActions.ts";

export const layer = ApproverKeys.layer.pipe(
  Layer.provideMerge(PendingActions.layer.pipe(Layer.provide(Audit.layer))),
  Layer.provide(AttestationTrust.layer.pipe(Layer.provide(FetchHttpClient.layer))),
  Layer.provide(KinPersistence.layer),
);

export * from "../../auth/EnvironmentAuth.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as Layer from "effect/Layer";
import * as ProofKeySessions from "./ProofKeySessions.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";

export const layerRuntime = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(ProofKeySessions.layerCli),
  Layer.provideMerge(ManagedPolicy.layer),
  Layer.provideMerge(Layer.mergeAll(ServerSecretStore.layer, SqlitePersistence.layerConfig)),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
);

export { flags as repairFlags, create as createRepairPairing } from "./repairPairing.ts";

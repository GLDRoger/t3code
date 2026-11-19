export * from "../../auth/EnvironmentAuth.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { KinChatError } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../../config.ts";
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

/**
 * The running server's own database, for a host CLI that only asks it for a credential: opened
 * without the server's setup or migrations, so the CLI writes nothing but that credential and
 * its revocation. It refuses a home with no database rather than make one.
 */
const layerServersDatabase = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    if (!(yield* (yield* FileSystem.FileSystem).exists(dbPath)))
      return yield* new KinChatError({
        reason: "unavailable",
        message: `No server database at ${dbPath}. Start the Kin server, then retry.`,
      });
    return Layer.provideMerge(
      // The server writes from another process; wait for it rather than fail with SQLITE_BUSY.
      Layer.effectDiscard(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql`PRAGMA busy_timeout = 5000`),
      ),
      NodeSqliteClient.layer({ filename: dbPath }),
    );
  }),
);

/** `layerRuntime` for a CLI that talks to the running server, over its database as it stands. */
export const layerServerCli = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(ProofKeySessions.layerCli),
  Layer.provideMerge(ManagedPolicy.layer),
  Layer.provideMerge(Layer.mergeAll(ServerSecretStore.layer, layerServersDatabase)),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
);

export { flags as repairFlags, create as createRepairPairing } from "./repairPairing.ts";

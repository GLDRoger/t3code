import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import { layerAuth } from "../../server.ts";

/** T3 auth with Kin on, so session issue and revoke write the proof key marks #54 defines. */
export const layerKinAuthTest = (prefix: string) =>
  layerAuth.pipe(
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { KIN_ENABLED: "true" } }),
      ),
    ),
    Layer.provideMerge(Sqlite.layerConfig),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

/** The owner's `--repair-proof-key` pairing, exchanged by the phone holding that key. */
export const repairProofKey = Effect.fn("ProofKeySessions.testkit.repairProofKey")(function* (
  thumbprint: string,
) {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const sql = yield* SqlClient.SqlClient;
  const link = yield* auth.createPairingLink({
    subject: "one-time-token",
    proofKeyThumbprint: thumbprint,
  });
  yield* sql`INSERT INTO kin_auth_key_repairs (thumbprint, pairing_link_id, created_at)
    VALUES (${thumbprint}, ${link.id}, 0)`;
  const exchanged = yield* auth.exchangeBootstrapCredentialForAccessToken(
    link.credential,
    undefined,
    { deviceType: "mobile" },
    { proofKeyThumbprint: thumbprint },
  );
  return yield* sessions.verify(exchanged.access_token);
});

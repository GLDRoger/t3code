import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuthRuntime.ts";

it.live(
  "asks the running server's database for a credential without migrating or setting it up",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "kin-cli-auth-" });
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(dir, dir)),
      );
      // The server's database as the server keeps it, a migration behind what this CLI knows.
      const counts = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ migrations: number; links: number }>`SELECT
            (SELECT COUNT(*) FROM effect_sql_migrations) AS migrations,
            (SELECT COUNT(*) FROM auth_pairing_links) AS links`;
        return row!;
      });
      const before = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM effect_sql_migrations
          WHERE migration_id = (SELECT MAX(migration_id) FROM effect_sql_migrations)`;
        return yield* counts;
      }).pipe(Effect.provide(SqlitePersistence.layerFromPath(config.dbPath)));

      const cli = EnvironmentAuth.layerServerCli.pipe(
        Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
      );
      const after = yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        yield* auth.issuePairingCredential({ label: "Kin CLI test" });
        return yield* counts;
      }).pipe(Effect.provide(cli));
      // Only the credential was written: no migration ran behind the server's back.
      assert.deepStrictEqual(after, { migrations: before.migrations, links: before.links + 1 });

      // A home with no database is refused, not made.
      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "kin-cli-auth-empty-" });
      const bare = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(empty, empty)),
      );
      const refused = yield* EnvironmentAuth.EnvironmentAuth.pipe(
        Effect.provide(
          EnvironmentAuth.layerServerCli.pipe(
            Layer.provide(Layer.succeed(ServerConfig.ServerConfig, bare)),
          ),
        ),
        Effect.flip,
      );
      assert.include(String(refused), "No server database");
      assert.isFalse(yield* fs.exists(bare.dbPath));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

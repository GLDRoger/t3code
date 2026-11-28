// @effect-diagnostics nodeBuiltinImport:off -- the fixture copies a SQLite file before opening each connection.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { beforeAll } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { runKinMigrations } from "./KinMigrations.ts";

const tempDir = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-sqlite-test-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

const configureReplica = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA busy_timeout = 5000`;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* sql`PRAGMA journal_mode = MEMORY`;
    yield* sql`PRAGMA synchronous = NORMAL`;
    yield* sql`PRAGMA temp_store = MEMORY`;
  }),
);

// The suite owns an empty template. Each layer build owns a separate writable copy.
export function makeMigratedSqliteLayer() {
  const migratedFile = Deferred.makeUnsafe<string>();
  beforeAll(() =>
    Effect.gen(function* () {
      const file = NodePath.join(yield* tempDir, "migrated.sqlite");
      yield* Effect.gen(function* () {
        yield* runKinMigrations();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`VACUUM INTO ${file}`;
      }).pipe(Effect.provide(Sqlite.layerMemory));
      yield* Deferred.succeed(migratedFile, file);
    }),
  );

  return Layer.unwrap(
    Effect.gen(function* () {
      const file = NodePath.join(yield* tempDir, "kin.sqlite");
      NodeFS.copyFileSync(yield* Deferred.await(migratedFile), file);
      return Layer.provideMerge(configureReplica, NodeSqliteClient.layer({ filename: file }));
    }),
  );
}

// @effect-diagnostics nodeBuiltinImport:off -- SQLite owns the process-lifetime advisory lock.
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";

export class KinRunnerOwned extends Schema.TaggedError<KinRunnerOwned>()("KinRunnerOwned", {}) {}

// Do not open a second descriptor: closing it can release this process's POSIX locks.
const owners = new Set<string | SqlClient.SqlClient>();
export const acquire = Effect.fn("RunnerOwnership.acquire")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{ name: string; file: string }>`PRAGMA database_list`.pipe(
    Effect.mapError(toPersistenceSqlError("RunnerOwnership.database")),
  );
  const filename = databases.find((row) => row.name === "main")?.file;
  const key = filename ? `${filename}.kin-runner.sqlite` : sql;
  yield* Effect.acquireRelease(
    Effect.gen(function* () {
      if (owners.has(key)) return yield* new KinRunnerOwned({});
      owners.add(key);
      return yield* Effect.try({
        try: () => {
          if (typeof key !== "string") return undefined;
          const db = new NodeSqlite.DatabaseSync(key);
          try {
            db.exec(
              "PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS kin_runner_lock (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;",
            );
            return db;
          } catch (cause) {
            db.close();
            throw cause;
          }
        },
        catch: toPersistenceSqlError("RunnerOwnership.acquire"),
      }).pipe(Effect.tapError(() => Effect.sync(() => owners.delete(key))));
    }),
    (db) =>
      Effect.sync(() => {
        db?.close();
        owners.delete(key);
      }),
  );
});

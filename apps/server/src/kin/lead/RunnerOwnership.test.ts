import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProcessRunner from "../../processRunner.ts";
import * as RunnerOwnership from "./RunnerOwnership.ts";

it.live("excludes another process without locking data writes and releases on scope close", () =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const filename = `${directory}/state.sqlite`;
    const context = yield* Layer.build(NodeSqliteClient.layer({ filename }));
    const sql = Context.get(context, SqlClient.SqlClient);
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    yield* RunnerOwnership.acquire().pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(Scope.Scope, scope),
    );
    const contender = yield* Effect.scoped(RunnerOwnership.acquire()).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.flip,
    );
    assert.strictEqual(contender._tag, "KinRunnerOwned");
    yield* sql`CREATE TABLE normal_writes (id INTEGER PRIMARY KEY)`;
    yield* sql`INSERT INTO normal_writes VALUES (1)`;
    const runner = yield* ProcessRunner.ProcessRunner;
    const probe = Effect.fn("test.probe")(function* () {
      return yield* runner.run({
        command: "node",
        args: [
          "-e",
          `
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(process.argv[1]);
          try { db.exec('BEGIN IMMEDIATE'); process.stdout.write('acquired'); }
          catch (error) { if (error.errcode !== 5) throw error; process.stdout.write('owned'); }
          finally { db.close(); }
        `,
          `${filename}.kin-runner.sqlite`,
        ],
      });
    });
    const blocked = yield* probe();
    assert.strictEqual(blocked.code, 0);
    assert.strictEqual(blocked.stdout, "owned");
    yield* Scope.close(scope, Exit.void);
    const acquired = yield* probe();
    assert.strictEqual(acquired.code, 0);
    assert.strictEqual(acquired.stdout, "acquired");
    yield* Effect.scoped(RunnerOwnership.acquire()).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "081_AuthSessionProofKeyThumbprint",
  (it) => {
    it.effect("preserves pre-migration sessions without inventing proof-key bindings", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 80 });
        yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('legacy-session', 'browser', '[]', 'browser-session-cookie',
          '2026-11-08T00:00:00.000Z', '2026-11-09T00:00:00.000Z')`;
        yield* runMigrations();
        assert.deepStrictEqual(
          yield* sql`SELECT session_id, proof_key_thumbprint FROM auth_sessions`,
          [{ session_id: "legacy-session", proof_key_thumbprint: null }],
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
      }),
    );
  },
);

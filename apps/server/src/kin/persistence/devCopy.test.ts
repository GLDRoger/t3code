import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { dropPersonalSendCards } from "./devCopy.ts";

// A dev copy as `migrate-dev-db` makes it: the source attached as `src`, its rows copied to main.
it.effect("a dev copy keeps no send card of someone's own mailbox, nor what waits on it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ATTACH DATABASE ':memory:' AS src`;
    yield* sql`CREATE TABLE src.kin_connections (org_id TEXT, connection_id TEXT, person_id TEXT)`;
    yield* sql`CREATE TABLE src.kin_connection_asks (org_id TEXT, ask_id TEXT,
      connection_id TEXT, widget_id TEXT)`;
    yield* sql`CREATE TABLE src.kin_widgets (widget_id TEXT, state_json TEXT)`;
    yield* sql`INSERT INTO src.kin_connections VALUES ('org', 'conn-company', NULL),
      ('org', 'conn-own', 'mate')`;
    yield* sql`INSERT INTO src.kin_connection_asks VALUES ('org', 'a1', 'conn-company', 'card-company'),
      ('org', 'a2', 'conn-own', 'card-own')`;
    yield* sql`CREATE TABLE kin_widgets (widget_id TEXT, state_json TEXT)`;
    yield* sql`CREATE TABLE kin_waiting (waiting_id TEXT, widget_id TEXT)`;
    yield* sql`INSERT INTO kin_widgets VALUES ('card-company', '{"subject":"company"}'),
      ('card-own', '{"subject":"private"}')`;
    yield* sql`INSERT INTO kin_waiting VALUES ('w1', 'card-own'), ('w2', 'card-company')`;
    yield* dropPersonalSendCards(sql);
    assert.deepStrictEqual(yield* sql`SELECT widget_id FROM kin_widgets ORDER BY widget_id`, [
      { widget_id: "card-company" },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT waiting_id FROM kin_waiting ORDER BY waiting_id`, [
      { waiting_id: "w2" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

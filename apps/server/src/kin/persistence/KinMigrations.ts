import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ChatCore from "./migrations/K001_ChatCore.ts";
import Lead from "./migrations/K002_Lead.ts";
import Triggers from "./migrations/K003_Triggers.ts";
import MemoryReads from "./migrations/K004_MemoryReads.ts";
import OneChatOwner from "./migrations/K005_OneChatOwner.ts";
import Pings from "./migrations/K006_Pings.ts";
import Budget from "./migrations/K007_Budget.ts";
import Approvals from "./migrations/K009_Approvals.ts";

const table = "kin_sql_migrations";
const run = Migrator.make({});
const loader = Migrator.fromRecord({
  "1_ChatCore": ChatCore,
  "2_Lead": Lead,
  "3_Triggers": Triggers,
  "4_MemoryReads": MemoryReads,
  "5_OneChatOwner": OneChatOwner,
  "6_Pings": Pings,
  "7_Budget": Budget,
  "9_Approvals": Approvals,
});

// The Migrator skips every id at or below the latest applied one, so a migration that
// merged out of order would silently never run. Refuse to start instead.
const refuseSkippedMigrations = Effect.fn("KinMigrations.refuseSkipped")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const exists = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
  if (exists.length === 0) return;
  const applied = new Map(
    (yield* sql<{
      migration_id: number;
      name: string;
    }>`SELECT migration_id, name FROM ${sql(table)}`).map((row) => [row.migration_id, row.name]),
  );
  const latest = Math.max(0, ...applied.keys());
  const registered = yield* loader;
  const skipped = registered.filter(([id]) => id < latest && !applied.has(id));
  // Two branches can take the same number; the Migrator would treat the second as already run.
  const renamed = registered.filter(([id, name]) => applied.has(id) && applied.get(id) !== name);
  if (skipped.length === 0 && renamed.length === 0) return;
  const names = (list: typeof registered) => list.map(([id, name]) => `${id}_${name}`).join(", ");
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message:
      skipped.length > 0
        ? `Kin migrations ${names(skipped)} are registered below the latest applied migration ${latest} but never ran. They merged out of order; renumber them above ${latest}.`
        : `Kin migrations ${names(renamed)} share a number with a different migration this database already ran. Renumber them above ${latest}.`,
  });
});

export const runKinMigrations = Effect.fn("KinMigrations.run")(function* () {
  yield* refuseSkippedMigrations();
  return yield* run({ table, loader });
});

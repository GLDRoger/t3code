import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import ChatCore from "./migrations/K001_ChatCore.ts";
import Lead from "./migrations/K002_Lead.ts";

const run = Migrator.make({});
const loader = Migrator.fromRecord({ "1_ChatCore": ChatCore, "2_Lead": Lead });

export const runKinMigrations = Effect.fn("KinMigrations.run")(function* () {
  return yield* run({ table: "kin_sql_migrations", loader });
});

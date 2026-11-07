import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import ChatCore from "./migrations/K001_ChatCore.ts";
import Lead from "./migrations/K002_Lead.ts";
import Triggers from "./migrations/K003_Triggers.ts";
import MemoryReads from "./migrations/K004_MemoryReads.ts";

import OneChatOwner from "./migrations/K006_OneChatOwner.ts";

const run = Migrator.make({});
const loader = Migrator.fromRecord({
  "1_ChatCore": ChatCore,
  "2_Lead": Lead,
  "3_Triggers": Triggers,
  "4_MemoryReads": MemoryReads,
  "6_OneChatOwner": OneChatOwner,
});

export const runKinMigrations = Effect.fn("KinMigrations.run")(function* () {
  return yield* run({ table: "kin_sql_migrations", loader });
});

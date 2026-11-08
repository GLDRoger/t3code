import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import ChatCore from "./migrations/K001_ChatCore.ts";
import Lead from "./migrations/K002_Lead.ts";
import Triggers from "./migrations/K003_Triggers.ts";
import MemoryReads from "./migrations/K004_MemoryReads.ts";
import OneChatOwner from "./migrations/K005_OneChatOwner.ts";
import Pings from "./migrations/K006_Pings.ts";
import Budget from "./migrations/K007_Budget.ts";
import Floor from "./migrations/K008_Floor.ts";

import JudgeLog from "./migrations/K009_JudgeLog.ts";

import ChatChanges from "./migrations/K010_ChatChanges.ts";
import MemoryHeads from "./migrations/K011_MemoryHeads.ts";

import LeadToolCalls from "./migrations/K013_LeadToolCalls.ts";

const run = Migrator.make({});
const loader = Migrator.fromRecord({
  "1_ChatCore": ChatCore,
  "2_Lead": Lead,
  "3_Triggers": Triggers,
  "4_MemoryReads": MemoryReads,
  "5_OneChatOwner": OneChatOwner,
  "6_Pings": Pings,
  "7_Budget": Budget,
  "8_Floor": Floor,
  "9_JudgeLog": JudgeLog,
  "10_ChatChanges": ChatChanges,
  "11_MemoryHeads": MemoryHeads,
  "13_LeadToolCalls": LeadToolCalls,
});

export const runKinMigrations = Effect.fn("KinMigrations.run")(function* () {
  return yield* run({ table: "kin_sql_migrations", loader });
});

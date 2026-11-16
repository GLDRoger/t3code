import { assert } from "@effect/vitest";
import { createOxlintRuleHarness } from "../test/utils.ts";

const state = createOxlintRuleHarness("t3code/kin-zoned-time", { filename: "fixture.ts" });

// widgets/reminderCard.ts before check-ins followed the owner's zone: its own read, UTC when unset.
state.invalid(
  "catches a second owner-zone read that falls back to UTC",
  `const ownerZone = Effect.fn("KinReminderCard.ownerZone")(function* (orgId: KinOrgId) {
     const sql = yield* SqlClient.SqlClient;
     const [row] = yield* sql<{ timeZone: string }>\`SELECT time_zone AS "timeZone"
       FROM kin_trigger_settings WHERE org_id = \${orgId} ORDER BY org_id\`;
     return Option.getOrElse(decodeZone(row?.timeZone), () => "UTC");
   });`,
  (output) => assert.include(output, "ownerZone"),
);
state.invalid(
  "catches a time formatted in the server's zone",
  `const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(at);`,
);
state.invalid(
  "catches a day read in the server's zone",
  "const late = new Date(due).getHours() > 17;",
);
state.invalid(
  "catches a date-shaped toLocaleString",
  "const shown = new Date(dueAt).toLocaleString();",
);
state.valid(
  "allows a format in a named zone",
  `const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit" }).format(at);`,
);
state.valid(
  "allows a number's toLocaleString",
  'const shown = (full.length - at).toLocaleString("en-US");',
);
state.valid(
  "allows other settings reads",
  "const rows = yield* sql`SELECT quiet_hours_json FROM kin_trigger_settings WHERE org_id = ${orgId}`;",
);

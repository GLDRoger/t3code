import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "./KinPersistence.ts";
import * as KinRetention from "./KinRetention.ts";

const layer = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);
const timestamp = "2026-11-07T00:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-11-20T09:00:00.000Z");

it.layer(layer)("Kin retention", (it) => {
  it.effect("drops tool-call receipts of long-ended wake-ups and keeps every one still read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_orgs VALUES ('ambermill', 'Ambermill', ${timestamp})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES ('rhea', 'ambermill', 'rhea', 'Rhea', ${timestamp})`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES ('chief', 'ambermill', 'Chief of staff', 'lead', 'rhea', ${timestamp})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at) VALUES ('rhea-chief', 'ambermill', 'direct', 'rhea-chief', 0, ${timestamp})`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id) VALUES ('chief', 'ambermill', 'Chief of staff', 0, '{}', '[]', 'rhea-chief')`;
      const wakeups = [
        // Started long ago and still running: its receipts are its retries' dedupe keys.
        { id: "running", status: "running", endedAt: null },
        { id: "recent", status: "completed", endedAt: now - 10 * DAY },
        { id: "edge", status: "failed", endedAt: now - 90 * DAY },
        { id: "old", status: "completed", endedAt: now - 91 * DAY },
        { id: "old-released", status: "released", endedAt: now - 200 * DAY },
      ];
      for (const wake of wakeups) {
        yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, ended_at, status, event_ids) VALUES ('ambermill', ${wake.id}, 'chief', 'fixture', ${now - 300 * DAY}, ${wake.endedAt}, ${wake.status}, '[]')`;
        for (const key of ["item:def-1", "end"])
          yield* sql`INSERT INTO kin_lead_tool_calls (org_id, wakeup_id, call_key, request_hash) VALUES ('ambermill', ${wake.id}, ${key}, 'hash')`;
      }
      yield* TestClock.setTime(now);
      yield* KinRetention.prune();
      const kept = yield* sql<{ wakeupId: string; n: number }>`SELECT wakeup_id AS "wakeupId",
          COUNT(*) AS n FROM kin_lead_tool_calls WHERE org_id = 'ambermill'
        GROUP BY wakeup_id ORDER BY wakeup_id`;
      assert.deepStrictEqual(kept, [
        { wakeupId: "edge", n: 2 },
        { wakeupId: "recent", n: 2 },
        { wakeupId: "running", n: 2 },
      ]);
      const wakeupRows = yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = 'ambermill'`;
      assert.strictEqual(wakeupRows.length, wakeups.length);
    }),
  );
});

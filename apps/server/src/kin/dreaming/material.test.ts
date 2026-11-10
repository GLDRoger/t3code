import { assert, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { collectMaterial } from "./material.ts";

const at = "2026-11-10T00:00:00.000Z";
const orgId = KinOrgId.make("org");
const layer = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);

it.effect("attributes each journal entry to the lead that wrote it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [org, agents] of [
      ["org", ["lead-tech", "lead-growth"]],
      ["other", ["lead-other"]],
    ] as const) {
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${org}, ${org}, ${at})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES (${`owner-${org}`}, ${org}, ${`owner-${org}`}, 'Owner', ${at})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES (${`chat-${org}`}, ${org}, 'team_group', 0, ${at})`;
      for (const agent of agents) {
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
          VALUES (${agent}, ${org}, ${agent}, 'lead', ${`owner-${org}`}, ${at})`;
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
          VALUES (${agent}, ${org}, ${agent}, 0, '{}', '[]', ${`chat-${org}`})`;
      }
    }
    const entry = (wakeup: string, agent: string, line: string) =>
      `\n## 09:00 · wake-up ${wakeup} · ${agent} · L2\n\nOutcome: completed\nEvents: e\n\n- ${line}\n`;
    const path = "journal/2026/11-10.md";
    const material = yield* collectMaterial({
      orgId,
      from: 0,
      until: Date.parse("2026-11-10T12:00:00.000Z"),
      full: false,
      timeZone: "UTC",
      files: new Map([
        [
          path,
          entry("w1", "lead-growth", "Launch post Friday.") +
            entry("w2", "lead-tech", "Merged the fix.") +
            // A dream may edit journal files; another org's lead is nobody here.
            entry("w3", "lead-other", "Planted."),
        ],
        ["journal/2026/11-09.md", entry("w0", "lead-tech", "One entry, whole file.")],
      ]),
    });
    assert.deepStrictEqual(
      material.entries.map(({ ref, saidBy, trust }) => ({ ref, saidBy, trust })),
      [
        { ref: "memory:journal/2026/11-09.md", saidBy: "lead-tech", trust: "agent" },
        { ref: `memory:${path}#w1`, saidBy: "lead-growth", trust: "agent" },
        { ref: `memory:${path}#w2`, saidBy: "lead-tech", trust: "agent" },
        { ref: `memory:${path}#w3`, saidBy: "kin", trust: "agent" },
      ],
    );
    assert.include(material.entries[1]?.text, "Launch post Friday.");
    assert.notInclude(material.entries[1]?.text, "Merged the fix.");
  }).pipe(Effect.provide(layer)),
);

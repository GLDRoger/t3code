import { assert, it } from "@effect/vitest";
import { KinAgentId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Persistence from "../persistence/KinPersistence.ts";
import { leadListsTool } from "./seatHome.ts";

it.effect("an engineering lead leaves bills_add to Finance while Ambermill has one", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const orgId = KinOrgId.make("org-ambermill");
    const at = "2026-11-15T00:00:00.000Z";
    yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${at})`;
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES ('rhea', ${orgId}, 'rhea', 'Rhea', ${at}, 'owner')`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES ('chat', ${orgId}, 'direct', 'rhea:finance', 0, ${at})`;
    for (const [agentId, domain] of [
      ["finance", "finance"],
      ["engineering", "engineering"],
    ] as const) {
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id,
          created_at) VALUES (${agentId}, ${orgId}, ${agentId}, 'lead', 'rhea', ${at})`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, domain, level_since, models_json,
          worker_projects_json, owner_chat_id)
        VALUES (${agentId}, ${orgId}, ${agentId}, ${domain}, 0, '{}', '[]', 'chat')`;
    }
    const lists = (agentId: string) => leadListsTool(orgId, KinAgentId.make(agentId), "bills_add");
    assert.deepStrictEqual([yield* lists("finance"), yield* lists("engineering")], [true, false]);
    yield* sql`UPDATE kin_agents SET retired_at = ${at} WHERE agent_id = 'finance'`;
    assert.isTrue(yield* lists("engineering"));
  }).pipe(Effect.provide(Persistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

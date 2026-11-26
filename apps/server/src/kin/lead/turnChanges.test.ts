import { assert, it } from "@effect/vitest";
import { KinAgentId, KinOrgId, KinPersonId, KinWakeupId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { KIN_OWNER_LEVEL, viewerOfPeople } from "../work/teamView.ts";
import { hasTurnChanges, turnChanges } from "./turnChanges.ts";

const layer = KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("uses the same visible changes for reserving a reply and reading its last bubble", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const orgId = KinOrgId.make("receipt-test");
    const wakeupId = KinWakeupId.make("tap-turn");
    const agentId = KinAgentId.make("finance");
    const at = "2026-11-26T00:00:00Z";
    yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
      VALUES (${orgId}, 'Receipt test', ${at})`;
    yield* sql`INSERT INTO kin_people (org_id, person_id, handle, display_name, access, created_at)
      VALUES (${orgId}, 'owner', 'owner', 'Owner', 'owner', ${at}),
             (${orgId}, 'mate', 'mate', 'Mate', 'member', ${at})`;
    yield* sql`INSERT INTO kin_agents (org_id, agent_id, owner_person_id, display_name, role, created_at)
      VALUES (${orgId}, ${agentId}, 'owner', 'Finance', 'lead', ${at})`;
    yield* sql`INSERT INTO kin_chats (org_id, chat_id, kind, title, last_seq, created_at)
      VALUES (${orgId}, 'chat', 'team_group', 'Launch', 2, ${at})`;
    yield* sql`INSERT INTO kin_chat_members (org_id, chat_id, member_id, principal_kind, agent_id, role, joined_at)
      VALUES (${orgId}, 'chat', 'member', 'agent', ${agentId}, 'member', ${at})`;
    yield* sql`INSERT INTO kin_messages (org_id, chat_id, message_id, seq, author_kind, author_role,
        author_agent_id, author_owner_person_id, author_member_id, author_thread_id,
        kind, body, mentions_json, status, created_at, source_wakeup_id, client_message_id, silent)
      VALUES (${orgId}, 'chat', 'first', 1, 'agent', 'member', ${agentId}, 'owner', 'member', 'thread',
          'text', 'First part', '[]', 'posted', ${at}, ${wakeupId}, 'send:reply:answer', 0),
        (${orgId}, 'chat', 'last', 2, 'agent', 'member', ${agentId}, 'owner', 'member', 'thread',
          'text', 'Last part', '[]', 'posted', ${at}, ${wakeupId}, 'send:reply:answer~b2', 1)`;
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, created_at)
      VALUES (${orgId}, 'docs', 'Docs', 'D', 0)`;
    yield* sql`INSERT INTO kin_records (org_id, record_id, key, register_id, title, owner_kind,
        owner_id, created_by_kind, origin_key, sensitive, created_at, updated_at)
      VALUES (${orgId}, 'doc', 'D-11', 'docs', 'Launch checklist', 'person', 'owner', 'agent', 'doc', 1, 0, 0)`;
    yield* sql`INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind, actor_id,
        via, kind, fields_json, wakeup_id)
      VALUES (${orgId}, 'doc', 1, 0, 'agent', ${agentId}, 'lead', 'created', '[]', ${wakeupId})`;
    for (const [viewer, keys] of [
      [KIN_OWNER_LEVEL, ["D-11"]],
      [viewerOfPeople([KinPersonId.make("mate")]), []],
    ] as const) {
      assert.strictEqual(yield* hasTurnChanges(viewer, orgId, wakeupId, agentId), keys.length > 0);
      assert.isFalse(
        yield* hasTurnChanges(viewer, orgId, KinWakeupId.make("question-turn"), agentId),
      );
      assert.strictEqual((yield* turnChanges(viewer, orgId, ["first"])).size, 0);
      const receipts = yield* turnChanges(viewer, orgId, ["last"]);
      assert.deepStrictEqual(
        receipts.get("last")?.items.map((item) => item.key),
        [...keys],
      );
    }
  }).pipe(Effect.provide(layer)),
);

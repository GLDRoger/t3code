import { assert, it } from "@effect/vitest";
import { KinChatId, KinMemberId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinChatRepository from "../chat/KinChatRepository.ts";
import * as Memory from "../memory/Memory.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as OwnerNotices from "./OwnerNotices.ts";

const orgId = KinOrgId.make("org");
const at = "2026-11-11T03:00:00.000Z";
const database = KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect(
  "a notice goes to the Chief of staff chat alone, and counts only if it needs the owner",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* KinChatRepository.KinChatRepository;
      const hooks = yield* Memory.MemoryRecoveryHooks;
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Org', ${at})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES ('owner', ${orgId}, 'owner', 'Owner', ${at})`;
      // Tech lead was placed first; the Chief of staff still gets the notice.
      for (const [agent, domain, created] of [
        ["tech", "engineering", "2026-11-01T00:00:00.000Z"],
        ["chief", "chief-of-staff", "2026-11-02T00:00:00.000Z"],
      ] as const) {
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        VALUES (${agent}, ${orgId}, ${agent}, 'lead', 'owner', ${created})`;
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES (${`chat-${agent}`}, ${orgId}, 'team_group', 0, ${at})`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES (${`owner-${agent}`}, ${orgId}, ${`chat-${agent}`}, 'person', 'owner', 'owner', ${at})`;
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id, domain)
        VALUES (${agent}, ${orgId}, ${agent}, 0, '{}', '[]', ${`chat-${agent}`}, ${domain})`;
      }
      const unread = (agent: string) =>
        repo.unreadCount({
          orgId,
          chatId: KinChatId.make(`chat-${agent}`),
          memberId: KinMemberId.make(`owner-${agent}`),
        });
      const rows = (agent: string) =>
        sql<{
          body: string;
        }>`SELECT body FROM kin_messages WHERE chat_id = ${`chat-${agent}`} ORDER BY seq`;

      yield* hooks.notify({ orgId, branch: "main", reason: "Recovered from remote head" });
      assert.deepStrictEqual(yield* rows("chief"), [{ body: "Recovered from remote head" }]);
      assert.strictEqual(yield* unread("chief"), 0);

      yield* hooks.notify({ orgId, branch: "main", reason: "Close the PR", needsOwner: true });
      assert.strictEqual(yield* unread("chief"), 1);
      assert.deepStrictEqual(yield* rows("tech"), []);
      assert.strictEqual(yield* unread("tech"), 0);
    }).pipe(
      Effect.provide(
        OwnerNotices.layer.pipe(
          Layer.provideMerge(KinChatRepository.layer),
          Layer.provideMerge(database),
        ),
      ),
    ),
);

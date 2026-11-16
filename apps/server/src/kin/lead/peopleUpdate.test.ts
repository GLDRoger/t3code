import { assert, describe, it } from "@effect/vitest";
import { KinAgentId, KinOrgId, KinPersonId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { updatePeople } from "./peopleUpdate.ts";

const orgId = KinOrgId.make("fixture-org");
const agentId = KinAgentId.make("lead-a");
const at = "2026-11-08T00:00:00.000Z";
const layer = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);

/** The asker's own message in the group wakes the lead; `none` is a routine. */
const setup = Effect.fn(function* (asker: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${orgId}, 'Fixture', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, created_at) VALUES
    ('owner', ${orgId}, 'owner', 'Ravi', 'owner', ${at}),
    ('co', ${orgId}, 'co', 'Meera', 'co_owner', ${at}),
    ('mate', ${orgId}, 'mate', 'Arjun', 'member', ${at})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at, direct_key)
    VALUES ('group', ${orgId}, 'team_group', 0, ${at}, NULL)`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES (${agentId}, ${orgId}, 'Ada', 'lead', 'owner', ${at})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, thread_id, models_json, worker_projects_json, owner_chat_id)
    VALUES (${agentId}, ${orgId}, 'Ada', 'L1', 0, 'lead-a-thread', '{}', '[]', 'group')`;
  for (const [seq, person] of ["owner", "co", "mate", "none"].entries()) {
    if (person === asker) {
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, run_id, model, started_at, status, event_ids, audience)
        VALUES (${`wake-${person}`}, ${orgId}, ${agentId}, 'lead-a-thread', ${`run-${person}`}, 'fixture', 0,
          'running', ${JSON.stringify([`event-${person}`])}, 'shared')`;
      const event =
        person === "none"
          ? { _tag: "routine", routine: "morning_brief", provenance: { _tag: "system" } }
          : {
              _tag: "chat.message",
              chatId: "group",
              messageId: `message-${person}`,
              provenance: { _tag: "human", personId: person, memberId: `member-${person}` },
            };
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id)
        VALUES (${`event-${person}`}, ${orgId}, ${agentId}, ${event._tag}, 'P0',
          ${JSON.stringify({ ...event, orgId, agentId, eventId: `event-${person}`, receivedAt: at, dedupeKey: null })},
          0, 0, 'claimed', ${`wake-${person}`})`;
    }
    if (person === "none") continue;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES (${`member-${person}`}, ${orgId}, 'group', 'person', ${person}, ${person === "owner" ? "owner" : "member"}, ${at})`;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
        author_member_id, author_role, kind, body, mentions_json, status, created_at)
      VALUES (${`message-${person}`}, ${orgId}, 'group', ${seq + 1}, 'human', ${person},
        ${`member-${person}`}, 'member', 'text', 'Invented', '[]', 'posted', ${at})`;
  }
});

const turn = (asker: string) => ({
  _tag: "agent" as const,
  orgId,
  agentId,
  ownerPersonId: KinPersonId.make("owner"),
  threadId: ThreadId.make("lead-a-thread"),
  wakeupId: `wake-${asker}`,
  startedAt: 0,
});

describe("people_update", () => {
  it.effect.each([
    ["mate", "me", "saved"],
    ["mate", "Ravi", "A teammate changes only their own profile."],
    ["mate", "Meera", "A teammate changes only their own profile."],
    ["co", "Arjun", "saved"],
    ["co", "owner", "Only the owner changes the owner's profile."],
    ["owner", "Meera", "saved"],
    ["none", "me", "Kin can't tell which one person asked"],
  ] as const)("%s sets %s's time zone: %s", ([asker, person, outcome]) =>
    Effect.gen(function* () {
      yield* setup(asker);
      const sql = yield* SqlClient.SqlClient;
      const exit = yield* Effect.exit(
        updatePeople(turn(asker), { person, timeZone: "Asia/Kolkata" }),
      );
      const zones = yield* sql<{ zone: string | null }>`SELECT time_zone AS zone FROM kin_people
        WHERE time_zone IS NOT NULL`;
      if (outcome === "saved") {
        assert.isTrue(Exit.isSuccess(exit));
        assert.strictEqual(zones.length, 1);
      } else {
        assert.isTrue(Exit.isFailure(exit));
        assert.include(JSON.stringify(exit), outcome);
        assert.strictEqual(zones.length, 0);
      }
    }).pipe(Effect.provide(layer)),
  );
});

import { assert, it } from "@effect/vitest";
import { KinAgentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { relayPrefix, unkeptPromise } from "./promises.ts";

// Invented company and people only.
const orgId = KinOrgId.make("org");
const chief = KinAgentId.make("chief");
const at = "2026-11-16T00:00:00.000Z";
const layer = KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const wake = {
  orgId,
  agentId: chief,
  wakeupId: "wake",
  threadId: "chief-thread",
  startedAt: Date.parse(at),
  chatId: KinChatId.make("zoya-chat"),
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Studio', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES ('ishaan', ${orgId}, 'ishaan', 'Ishaan Rao', ${at}),
      ('zoya', ${orgId}, 'zoya', 'Zoya Sheikh', ${at})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES (${chief}, ${orgId}, 'Chief of staff', 'lead', 'ishaan', ${at})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('zoya-chat', ${orgId}, 'direct', 'zoya:chief', 0, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, agent_id, role, joined_at)
    VALUES ('m-zoya', ${orgId}, 'zoya-chat', 'person', 'zoya', NULL, 'member', ${at}),
      ('m-chief', ${orgId}, 'zoya-chat', 'agent', NULL, ${chief}, 'member', ${at})`;
});
const say = (seq: number, body: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_agent_id, author_owner_person_id, author_thread_id, author_member_id, author_role,
        kind, body, mentions_json, status, created_at)
      VALUES (${`said-${seq}`}, ${orgId}, 'zoya-chat', ${seq}, 'agent', ${chief}, 'ishaan',
        'chief-thread', 'm-chief', 'member', 'text', ${body}, '[]', 'posted', ${at})`;
  });

it.effect("a promise to tell someone stands only when the turn told them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    yield* say(1, "I'll let you know once it's sorted.");
    assert.isUndefined(yield* unkeptPromise(wake));
    // Run 3's words: a promise to him, and nothing sent.
    yield* say(2, "Ishaan assigned W-7. I'll put your request to him now and come back here.");
    assert.strictEqual(yield* unkeptPromise(wake), "Ishaan");
    yield* say(3, "I'll ask Ishaan whether 1 February works.");
    assert.strictEqual(yield* unkeptPromise(wake), "Ishaan");
    // The relay that carried it keeps the promise.
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES ('owner-chat', ${orgId}, 'direct', 'ishaan:chief', 0, ${at})`;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_role,
        kind, body, mentions_json, status, created_at)
      VALUES (${`${relayPrefix("wake")}ishaan`}, ${orgId}, 'owner-chat', 1, 'system', 'member',
        'system', 'Zoya Sheikh asked', '[]', 'posted', ${at})`;
    assert.isUndefined(yield* unkeptPromise(wake));
  }).pipe(Effect.provide(layer)),
);

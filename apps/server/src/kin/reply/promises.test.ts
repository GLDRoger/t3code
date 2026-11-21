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
    // A saved standing permission, and its read-back, name him without promising anything now.
    yield* say(
      10,
      "Saved. From now on I'll message Ishaan directly when something needs him, no need to involve you.",
    );
    yield* say(
      11,
      "Noted: I'll message Ishaan directly without involving you.\nYour saved permissions:\n1. You and Ishaan may message each other directly; I'll pass things to Ishaan whenever either of you asks.\n2. Going forward I will check with Ishaan before booking travel.",
    );
    assert.isUndefined(yield* unkeptPromise(wake));
    // Run 3's words: a promise to him, and nothing sent.
    yield* say(2, "Ishaan assigned W-7. I'll put your request to him now and come back here.");
    assert.strictEqual(yield* unkeptPromise(wake), "Ishaan");
    yield* say(3, "I'll ask Ishaan whether 1 February works.");
    assert.strictEqual(yield* unkeptPromise(wake), "Ishaan");
    yield* sql`DELETE FROM kin_messages WHERE message_id IN ('said-2', 'said-3')`;
    yield* say(4, "I'll tell Ishaan now that the release moved to Friday.");
    assert.strictEqual(yield* unkeptPromise(wake), "Ishaan");
    // A question with a default to someone else, safe or not, leaves the promise to Ishaan unkept.
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES ('owner-chat', ${orgId}, 'direct', 'ishaan:chief', 0, ${at})`;
    const ask = (person: string, chat: string) =>
      sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id, kind,
          question, default_label, safe, asked_at, due_at, act_at, state)
        VALUES (${`q-${person}`}, ${orgId}, ${chief}, ${person}, ${chat}, 'card',
          'Invented: which name stands?', 'Yours', 0, ${Date.parse(at)},
          ${Date.parse(at) + 86_400_000}, ${Date.parse(at) + 86_400_000}, 'open')`;
    yield* ask("zoya", "zoya-chat");
    assert.strictEqual(yield* unkeptPromise(wake), "Ishaan");
    yield* sql`UPDATE kin_questions SET safe = 1`;
    assert.strictEqual(yield* unkeptPromise(wake), "Ishaan");
    // His own question keeps it only while it is open with a default Kin will take.
    yield* ask("ishaan", "owner-chat");
    yield* sql`UPDATE kin_questions SET safe = 0 WHERE person_id = 'ishaan'`;
    assert.strictEqual(yield* unkeptPromise(wake), "Ishaan");
    yield* sql`UPDATE kin_questions SET safe = 1 WHERE person_id = 'ishaan'`;
    assert.isUndefined(yield* unkeptPromise(wake));
    yield* sql`UPDATE kin_questions SET state = 'answered' WHERE person_id = 'ishaan'`;
    assert.strictEqual(yield* unkeptPromise(wake), "Ishaan");
    yield* sql`DELETE FROM kin_questions`;
    // The relay that carried it keeps the promise, held through his quiet hours or posted.
    yield* sql`INSERT INTO kin_held_posts (hold_id, org_id, chat_id, person_id, kind, body,
        audience, held_at, deliver_at, waits)
      VALUES ('held', ${orgId}, 'owner-chat', 'ishaan', ${`${relayPrefix("wake")}ishaan`},
        'Zoya Sheikh asked', 'chat', ${Date.parse(at)}, ${Date.parse(at) + 3_600_000}, 1)`;
    assert.isUndefined(yield* unkeptPromise(wake));
    yield* sql`DELETE FROM kin_held_posts`;
    assert.strictEqual(yield* unkeptPromise(wake), "Ishaan");
    // So does a question put to him for this chat, held for his quiet hours with no card yet.
    yield* sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id, kind,
        question, safe, asked_at, due_at, act_at, state, for_chat_id, for_person_id)
      VALUES ('q-held', ${orgId}, ${chief}, 'ishaan', 'owner-chat', 'card',
        'Does 1 February work?', 0, ${Date.parse(at)}, 0, 0, 'open', 'zoya-chat', 'zoya')`;
    assert.isUndefined(yield* unkeptPromise(wake));
    yield* sql`DELETE FROM kin_questions`;
    assert.strictEqual(yield* unkeptPromise(wake), "Ishaan");
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_role,
        kind, body, mentions_json, status, created_at)
      VALUES (${`${relayPrefix("wake")}ishaan`}, ${orgId}, 'owner-chat', 1, 'system', 'member',
        'system', 'Zoya Sheikh asked', '[]', 'posted', ${at})`;
    assert.isUndefined(yield* unkeptPromise(wake));
  }).pipe(Effect.provide(layer)),
);

// Run 4: a check-in told the owner "Finance will send the reminder once you confirm", and
// nothing was handed to Finance.
it.effect("a promise about what another agent will do stands only when it was handed over", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES ('finance', ${orgId}, 'Finance', 'lead', 'ishaan', ${at})`;
    yield* say(1, "Finance has the invoice figures.");
    assert.isUndefined(yield* unkeptPromise(wake));
    yield* say(2, "Orbit is 11 days overdue, and Finance will send the reminder once you confirm.");
    assert.strictEqual(yield* unkeptPromise(wake), "Finance");
    yield* sql`INSERT INTO kin_handoffs (org_id, message_id, from_agent_id, to_agent_id, event_id,
        created_at)
      VALUES (${orgId}, 'kin-handoff:x', ${chief}, 'finance', 'handoff-x', ${Date.parse(at)})`;
    assert.isUndefined(yield* unkeptPromise(wake));
  }).pipe(Effect.provide(layer)),
);

// @effect-diagnostics nodeBuiltinImport:off -- reads sources for the shared-fragment guard.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  type KinChatId,
  KinMemberId,
  KinMessageId,
  KinWakeupId,
  type KinPersonId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { KinChatHub } from "../chat/KinChatHub.ts";
import * as ChatService from "../chat/KinChatService.ts";
import { isKeySent, KEY_SENT_STORED } from "../chat/keySent.ts";
import { storedClientId } from "../chat/KinChatRepository.ts";
import * as ChatWake from "../lead/ChatWake.ts";
import { KinEventQueue } from "../lead/KinEventQueue.ts";
import { codingAgentSource } from "../lead/OutsideContent.ts";
import { ownerLevelAsked } from "../people/KinAccess.ts";
import { wordOf } from "../pulse/holds.ts";
import { startedBy } from "../connections/privateTurn.ts";
import { ownMessages } from "../questions/askPerson.ts";
import { wokenByTheirWords } from "../questions/openQuestions.ts";
import * as Presence from "../reply/KinPresence.ts";
import { KinTeam } from "../team/KinTeam.ts";
import { personInTurn, personSpokeInTurn } from "../work/dismissedHold.ts";
import { askedBy, type Lead } from "../work/leadWork.ts";
import { askAgent } from "./chat.ts";
import { admitted, layer, team } from "./tasksKey.testkit.ts";
import * as TasksKeys from "./TasksKeys.ts";

// Invented: Rhea's agent Finance, and her direct chat with it.
const finance = KinAgentId.make("finance");
const at = "1970-01-01T00:00:00.000Z";
const withChat = ChatService.layer.pipe(
  Layer.provideMerge(Presence.layer),
  Layer.provideMerge(layer),
);

it("the one stored spelling of a key's send is the repository's", () => {
  assert.strictEqual(KEY_SENT_STORED, storedClientId("send", "key:"));
  assert.isTrue(isKeySent(storedClientId("send", "key:session:hash")));
  assert.isFalse(isKeySent(storedClientId("send", "typed-in-the-app")));
});

it.effect(
  "a key's real send starts the agent's turn, answers nothing, and counts as nobody's own word",
  () =>
    Effect.gen(function* () {
      const { orgId, rhea } = yield* team;
      const sql = yield* SqlClient.SqlClient;
      const chats = yield* ChatService.KinChatService;
      const queue = yield* KinEventQueue;
      const me = { _tag: "person" as const, orgId, personId: rhea.personId };
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        VALUES (${finance}, ${orgId}, 'Finance', 'lead', ${rhea.personId}, ${at})`;
      const chatId: KinChatId = (yield* chats.createDirect(me, { orgId, agentId: finance })).chatId;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
          worker_projects_json, owner_chat_id)
        VALUES (${finance}, ${orgId}, 'Finance', 0, '{}', '[]', ${chatId})`;
      // The real wake path, ChatWake, with each post it pulls handed to the test.
      const hub = yield* KinChatHub;
      const pulled = yield* Queue.unbounded<string>();
      yield* Layer.build(
        ChatWake.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(KinTeam)({ personAsked: () => Effect.succeed(false) }),
              Layer.succeed(KinChatHub, {
                ...hub,
                subscribeAll: hub.subscribeAll.pipe(
                  Effect.map(
                    Stream.tap((event) =>
                      event.type === "message.posted"
                        ? Queue.offer(pulled, event.message.messageId)
                        : Effect.void,
                    ),
                  ),
                ),
              }),
            ),
          ),
        ),
      );
      // A post nobody answers, pulled by the wake path: everything posted before it is handled.
      let settled = 0;
      const settle = Effect.gen(function* () {
        settled += 1;
        const ready = KinMessageId.make(`settle-${settled}`);
        yield* hub.publish({
          type: "message.posted",
          orgId,
          message: {
            orgId,
            chatId,
            messageId: ready,
            seq: 1,
            author: {
              _tag: "agent",
              agentId: finance,
              memberId: KinMemberId.make("finance-member"),
              ownerPersonId: rhea.personId,
              threadId: ThreadId.make("finance-thread"),
            },
            authorRole: "member",
            kind: "text",
            body: "Invented",
            intent: null,
            mentions: [],
            replyTo: null,
            widgetId: null,
            floorRunId: null,
            status: "posted",
            sentBy: null,
            createdAt: at,
            editedAt: null,
          },
        });
        while ((yield* Queue.take(pulled)) !== ready);
      });
      yield* settle;
      const key = yield* admitted((yield* TasksKeys.issue(rhea.app, { orgId })).secret);
      yield* sql`UPDATE kin_tasks_keys SET label = 'Invented laptop'
        WHERE session_id = ${key.sessionId}`;
      // Finance asked her a question in text: only her own typed words answer it.
      yield* sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id, kind,
          question, safe, asked_at, due_at, act_at, state)
        VALUES ('q-1', ${orgId}, ${finance}, ${rhea.personId}, ${chatId}, 'text',
          'Invented: which month?', 0, 0, 0, 0, 'open')`;
      const question = { questionId: "q-1", widgetId: null, chatId, askedAt: 0 } as const;

      let turns = 0;
      const turn = Effect.fn("test.turn")(function* () {
        yield* settle;
        // Past the queue's batch window, as the ChatWake tests do.
        yield* TestClock.adjust("1 minute");
        turns += 1;
        const wakeupId = KinWakeupId.make(`turn-${turns}`);
        const claim = { orgId, agentId: finance, wakeupId, model: "fixture" };
        const claimed = yield* Effect.scoped(queue.claim(claim));
        return { wakeupId, claimed, claim };
      });
      const typed = (body: string) =>
        chats.send(me, { chatId, clientMessageId: `typed-${body}`, body });
      const viaKey = (text: string) => askAgent(key, { agent: "Finance", text });
      const consumers = Effect.fn("test.consumers")(function* (wakeupId: KinWakeupId) {
        const lead = { orgId, agentId: finance, wakeupId } as unknown as Lead;
        const turnOf = { orgId, agentId: finance, wakeupId };
        return {
          ownerLevelAsked: yield* ownerLevelAsked(orgId, finance, wakeupId),
          personSpokeInTurn: yield* personSpokeInTurn(orgId, finance, wakeupId),
          personInTurn: yield* personInTurn(orgId, finance, wakeupId, rhea.personId),
          askedBy: yield* askedBy(lead),
          wordOf: (yield* wordOf(turnOf))?.personId ?? null,
          startedBy: yield* startedBy(turnOf, rhea.personId),
          ownMessages: yield* ownMessages(turnOf, chatId, rhea.personId as KinPersonId),
          wokenByTheirWords: yield* wokenByTheirWords(orgId, finance, wakeupId, {
            ...question,
            personId: rhea.personId,
          }),
        };
      });

      // Through the key alone: a turn starts, marked as from her coding agent, and nothing in it
      // is her own word. Her text question stays open: the key answered nothing.
      const sent = yield* viaKey("Invented: set the software budget to 100");
      assert.deepStrictEqual(sent, { sent: true, agent: "Finance", chat: chatId });
      const keyOnly = yield* turn();
      assert.lengthOf(keyOnly.claimed, 1);
      const [stored] = yield* sql<{ id: string }>`SELECT client_message_id AS id FROM kin_messages
        WHERE org_id = ${orgId} AND chat_id = ${chatId} ORDER BY seq DESC LIMIT 1`;
      assert.isTrue(isKeySent(stored?.id));
      const [stamp] = yield* sql<{ source: string }>`SELECT outside_from AS source
        FROM kin_event_outside WHERE event_id = ${keyOnly.claimed[0]?.eventId ?? ""}`;
      assert.strictEqual(stamp?.source, codingAgentSource("Invented laptop"));
      assert.deepStrictEqual(yield* consumers(keyOnly.wakeupId), {
        ownerLevelAsked: false,
        personSpokeInTurn: false,
        personInTurn: false,
        askedBy: null,
        wordOf: null,
        startedBy: false,
        ownMessages: [],
        wokenByTheirWords: false,
      });
      const [open] = yield* sql<{ state: string }>`SELECT state FROM kin_questions
        WHERE question_id = 'q-1'`;
      assert.strictEqual(open?.state, "open");
      yield* queue.finish({ ...keyOnly.claim, status: "completed" });

      // Her own typed words, the control: each consumer takes them as hers.
      yield* typed("March");
      const own = yield* turn();
      assert.deepStrictEqual(yield* consumers(own.wakeupId), {
        ownerLevelAsked: true,
        personSpokeInTurn: true,
        personInTurn: true,
        askedBy: rhea.personId,
        wordOf: rhea.personId,
        startedBy: true,
        ownMessages: ["March"],
        wokenByTheirWords: true,
      });
      yield* queue.finish({ ...own.claim, status: "completed" });

      // Both in one wake: only the typed words count as hers, and nothing asked "in person"
      // rides with the key's.
      yield* viaKey("Invented: and close the question");
      yield* typed("April");
      const mixed = yield* turn();
      assert.lengthOf(mixed.claimed, 2);
      assert.deepStrictEqual(yield* consumers(mixed.wakeupId), {
        ownerLevelAsked: false,
        personSpokeInTurn: true,
        personInTurn: true,
        askedBy: null,
        wordOf: null,
        startedBy: true,
        ownMessages: ["April"],
        wokenByTheirWords: true,
      });
    }).pipe(Effect.scoped, Effect.provide(withChat)),
);

it("every other check that a person said it themselves leaves out what a key sent", () => {
  // Each reads `kin_messages` for a person's own words inside a larger read a test can't reach
  // alone; each goes through the one shared fragment, and nothing spells it a second way.
  const root = NodePath.resolve(import.meta.dirname, "..");
  const read = (file: string) => NodeFS.readFileSync(NodePath.join(root, file), "utf8");
  for (const [file, uses] of [
    ["work/registers.ts", 1],
    ["lead/LeadMemory.ts", 2],
    ["lead/awaySet.ts", 1],
    ["sales/read.ts", 1],
    ["work/leadStatements.ts", 3],
    ["triggers/pings.ts", 1],
    ["team/KinTeam.ts", 1],
    ["pictures/picture.ts", 1],
    ["work/teamView.ts", 1],
    ["questions/openQuestions.ts", 1],
    ["questions/askPerson.ts", 1],
    ["connections/privateTurn.ts", 1],
  ] as const)
    assert.lengthOf(
      read(file).match(/keySentSql\((?:"m\.client_message_id"|`\$\{m\}\.client_message_id`)\)/g) ??
        [],
      uses,
      file,
    );
  for (const file of ["people/KinAccess.ts", "work/dismissedHold.ts", "work/leadWork.ts"])
    assert.notInclude(read(file), "'key:%'", file);
});

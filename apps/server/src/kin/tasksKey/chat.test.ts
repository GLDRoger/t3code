import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  type KinChat,
  KinChatId,
  type KinMessage,
  KinMemberId,
  KinMessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { KinChatHub, type KinChatHubEvent } from "../chat/KinChatHub.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { wakeEvent } from "../lead/ChatWake.ts";
import { codingAgentSource } from "../lead/OutsideContent.ts";
import { ownerLevelAsked } from "../people/KinAccess.ts";
import { ASK_WAIT, askAgent, readChat } from "./chat.ts";
import { admitted, layer, team } from "./tasksKey.testkit.ts";
import * as TasksKeys from "./TasksKeys.ts";

// Invented: Rhea's agent Finance, and her direct chat with it.
const finance = KinAgentId.make("finance");
const chatId = KinChatId.make("finance-rhea");
const at = "1970-01-01T00:00:00.000Z";

it.effect(
  "ask_agent speaks as the person in their own chat with an agent, marked as their coding agent, and brings back its reply",
  () =>
    Effect.gen(function* () {
      const { orgId, rhea } = yield* team;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        VALUES (${finance}, ${orgId}, 'Finance', 'lead', ${rhea.personId}, ${at})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES (${chatId}, ${orgId}, 'direct', ${`${rhea.personId}:${finance}`}, 0, ${at})`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
          worker_projects_json, owner_chat_id)
        VALUES (${finance}, ${orgId}, 'Finance', 0, '{}', '[]', ${chatId})`;
      const issued = yield* TasksKeys.issue(rhea.app, { orgId });
      const key = yield* admitted(issued.secret);
      yield* sql`UPDATE kin_tasks_keys SET label = 'Invented laptop'
        WHERE session_id = ${key.sessionId}`;

      // The chat's own service and hub stand in; the key's checks and the stamp are real.
      const events = yield* Queue.unbounded<KinChatHubEvent>();
      const sends = yield* Queue.unbounded<KinMessage>();
      let seq = 0;
      const message = (input: {
        readonly body: string;
        readonly agent?: boolean;
        readonly clientMessageId?: string;
      }): KinMessage => {
        seq += 1;
        return {
          orgId,
          chatId,
          messageId: KinMessageId.make(`message-${seq}`),
          seq,
          ...(input.clientMessageId === undefined
            ? {}
            : { clientMessageId: input.clientMessageId }),
          author: input.agent
            ? {
                _tag: "agent",
                agentId: finance,
                memberId: KinMemberId.make("finance-member"),
                ownerPersonId: rhea.personId,
                threadId: ThreadId.make("finance-thread"),
              }
            : { _tag: "human", personId: rhea.personId, memberId: KinMemberId.make("rhea-member") },
          authorRole: input.agent ? "member" : "owner",
          kind: "text",
          body: input.body,
          intent: null,
          mentions: [],
          replyTo: null,
          widgetId: null,
          floorRunId: null,
          status: "posted",
          sentBy: null,
          createdAt: at,
          editedAt: null,
        };
      };
      const stubs = Layer.mergeAll(
        Layer.mock(KinChatService)({
          createDirect: () => Effect.succeed({ chatId } as KinChat),
          send: (_identity, input) =>
            Effect.sync(() =>
              message({ body: input.body, clientMessageId: input.clientMessageId }),
            ).pipe(Effect.tap((made) => Queue.offer(sends, made))),
          history: () =>
            Effect.succeed({
              messages: [message({ body: "Invented: hello" })],
              widgets: [],
              hasMore: false,
            }),
        }),
        Layer.mock(KinChatHub)({
          subscribeForViewer: () => Effect.succeed(Stream.fromQueue(events)),
        }),
      );
      const ask = (text: string) =>
        askAgent(key, { agent: "Finance", text }).pipe(Effect.provide(stubs));

      const asked = yield* ask("Invented: what is late this week?").pipe(Effect.forkChild);
      const sent = yield* Queue.take(sends);
      assert.strictEqual(
        sent.body,
        "*Sent by my coding agent, Invented laptop.*\n\nInvented: what is late this week?",
      );
      assert.isTrue(sent.clientMessageId?.startsWith(`key:${key.sessionId}:`));
      const reply = message({ body: "Invented: two invoices are late.", agent: true });
      yield* Queue.offer(events, { type: "message.posted", orgId, message: reply });
      const answered = yield* Fiber.join(asked);

      assert.deepInclude(answered, { chat: chatId, replied: true, note: null });
      assert.deepInclude(answered.reply, { by: "Finance (agent)", text: reply.body });
      // The turn it starts is told the words came from her coding agent, by the key's name.
      const [stamp] = yield* sql<{ source: string }>`SELECT outside_from AS source
        FROM kin_event_outside WHERE event_id = ${wakeEvent(sent, finance, undefined).eventId}`;
      assert.strictEqual(stamp?.source, codingAgentSource("Invented laptop"));

      // No reply within the wait: it says the agent is still working, and where to read it.
      const slow = yield* ask("Invented: draft the reminder").pipe(Effect.forkChild);
      yield* Queue.take(sends);
      yield* TestClock.adjust(ASK_WAIT);
      const waited = yield* Fiber.join(slow);
      assert.deepInclude(waited, { replied: false, reply: null, chat: chatId });
      assert.include(waited.note ?? "", "read_chat");
      const read = yield* readChat(key, { chat: chatId }).pipe(Effect.provide(stubs));
      assert.deepStrictEqual(
        read.messages.map((one) => one.text),
        ["Invented: hello"],
      );

      // A person is no agent to ask, and a revoked key asks nothing.
      assert.strictEqual(
        (yield* Effect.flip(
          askAgent(key, { agent: "Zoya", text: "Invented" }).pipe(Effect.provide(stubs)),
        )).reason,
        "invalid_state",
      );
      yield* TasksKeys.revoke(rhea.app, { orgId, sessionId: key.sessionId });
      assert.strictEqual((yield* Effect.flip(ask("Invented: after"))).reason, "not_allowed");
    }).pipe(Effect.provide(layer)),
);

it.effect("words a coding agent sent through its key are never the person's ask in person", () =>
  Effect.gen(function* () {
    const { orgId, rhea } = yield* team;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${finance}, ${orgId}, 'Finance', 'lead', ${rhea.personId}, ${at})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES (${chatId}, ${orgId}, 'direct', ${`${rhea.personId}:${finance}`}, 0, ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
        role, joined_at)
      VALUES ('rhea-member', ${orgId}, ${chatId}, 'person', ${rhea.personId}, 'owner', ${at})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
        worker_projects_json, owner_chat_id)
      VALUES (${finance}, ${orgId}, 'Finance', 0, '{}', '[]', ${chatId})`;
    const asked = Effect.fn("test.asked")(function* (wakeupId: string, clientId: string | null) {
      const messageId = `${wakeupId}-message`;
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
          created_at, client_message_id)
        VALUES (${messageId}, ${orgId}, ${chatId}, ${wakeupId === "typed" ? 1 : 2}, 'human',
          ${rhea.personId}, 'rhea-member', 'owner', 'text', 'Invented: send it', '[]', 'posted',
          ${at}, ${clientId})`;
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status,
          event_ids)
        VALUES (${wakeupId}, ${orgId}, ${finance}, 'test', 0, 'completed', '[]')`;
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
          received_at, queued_at, state, wakeup_id)
        VALUES (${`${wakeupId}-event`}, ${orgId}, ${finance}, 'chat.message', 'P0', ${JSON.stringify(
          {
            _tag: "chat.message",
            chatId,
            messageId,
            provenance: { _tag: "human", personId: rhea.personId, memberId: "rhea-member" },
          },
        )}, 0, 0, 'claimed', ${wakeupId})`;
      return yield* ownerLevelAsked(orgId, finance, wakeupId);
    });
    assert.isTrue(yield* asked("typed", "typed-in-the-app"));
    assert.isFalse(yield* asked("through-key", "key:invented-session:0a1b2c"));
  }).pipe(Effect.provide(layer)),
);

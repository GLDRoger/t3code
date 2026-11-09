import { assert, describe, it } from "@effect/vitest";
import { KinEvent, KinMessage, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as ChatWake from "./ChatWake.ts";
import * as KinEventQueue from "./KinEventQueue.ts";

const decodeMessage = Schema.decodeUnknownSync(KinMessage);
const decodeEventJson = Schema.decodeEffect(Schema.fromJsonString(KinEvent));
const createdAt = "1970-01-01T00:00:00.000Z";

const database = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);
const services = Layer.mergeAll(KinEventQueue.layer, Hub.layer).pipe(
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(database),
);

const seed = Effect.fn("test.seed")(function* (org: string) {
  const sql = yield* SqlClient.SqlClient;
  const lead = `lead-${org}`;
  yield* sql`INSERT INTO kin_orgs VALUES (${org}, 'Kin', ${createdAt})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${`owner-${org}`}, ${org}, ${`owner-${org}`}, 'Owner', ${createdAt})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES (${lead}, ${org}, 'Lead', 'lead', ${`owner-${org}`}, ${createdAt})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES (${`chat-${org}`}, ${org}, 'direct', ${`direct-${org}`}, 0, ${createdAt})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES (${`owner-member-${org}`}, ${org}, ${`chat-${org}`}, 'person', ${`owner-${org}`}, 'owner', ${createdAt})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES (${`lead-member-${org}`}, ${org}, ${`chat-${org}`}, 'agent', ${lead}, 'member', ${createdAt})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES (${lead}, ${org}, 'Lead', 0, '{}', '[]', ${`chat-${org}`})`;
});

const message = (
  org: string,
  messageId: string,
  options: { readonly seq?: number; readonly agent?: boolean; readonly tap?: string } = {},
) =>
  decodeMessage({
    orgId: org,
    chatId: `chat-${org}`,
    messageId,
    seq: options.seq ?? 1,
    author:
      options.agent === true
        ? {
            _tag: "agent",
            agentId: `lead-${org}`,
            memberId: `lead-member-${org}`,
            ownerPersonId: `owner-${org}`,
            threadId: `thread-${org}`,
          }
        : { _tag: "human", personId: `owner-${org}`, memberId: `owner-member-${org}` },
    authorRole: options.agent === true ? "member" : "owner",
    kind: options.tap === undefined ? "text" : "widget_action",
    body:
      options.tap === undefined
        ? "Can you check the release?"
        : JSON.stringify({ widgetId: "widget", revision: 1, actionId: options.tap }),
    intent: options.agent === true ? "answer" : null,
    mentions: [],
    replyTo: null,
    widgetId: null,
    floorRunId: null,
    status: "posted",
    sentBy: null,
    createdAt,
    editedAt: null,
  });

const storeMessage = Effect.fn("test.storeMessage")(function* (row: KinMessage) {
  const sql = yield* SqlClient.SqlClient;
  const agent = row.author._tag === "agent" ? row.author : undefined;
  const human = row.author._tag === "human" ? row.author : undefined;
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
      author_agent_id, author_owner_person_id, author_thread_id, author_member_id, author_role, kind, body,
      intent, mentions_json, status, created_at)
    VALUES (${row.messageId}, ${row.orgId}, ${row.chatId}, ${row.seq}, ${row.author._tag},
      ${human?.personId ?? null}, ${agent?.agentId ?? null}, ${agent?.ownerPersonId ?? null},
      ${agent?.threadId ?? null}, ${agent?.memberId ?? human?.memberId ?? null}, ${row.authorRole},
      ${row.kind}, ${row.body}, ${row.intent}, '[]', ${row.status}, ${row.createdAt})`;
});

// Records every enqueue result, so tests await the bridge's work instead of sleeping.
const start = Effect.fn("test.start")(function* () {
  const results = yield* Queue.unbounded<{
    readonly event: KinEvent;
    readonly duplicate: boolean;
  }>();
  const queue = yield* KinEventQueue.KinEventQueue;
  yield* Layer.build(
    ChatWake.layer.pipe(
      Layer.provide(
        Layer.succeed(KinEventQueue.KinEventQueue, {
          ...queue,
          enqueue: (event) =>
            queue.enqueue(event).pipe(Effect.tap((result) => Queue.offer(results, result))),
        }),
      ),
    ),
  );
  return results;
});

const storedEvents = Effect.fn("test.storedEvents")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ json: string; priority: string }>`
    SELECT json, priority FROM kin_events ORDER BY event_id`;
  return yield* Effect.forEach(rows, (row) =>
    decodeEventJson(row.json).pipe(Effect.map((event) => ({ event, priority: row.priority }))),
  );
});

describe("ChatWake", () => {
  it.effect("wakes the lead once for each owner message and widget tap in its chat", () =>
    Effect.gen(function* () {
      yield* seed("a");
      const hub = yield* Hub.KinChatHub;
      const results = yield* start();
      const orgId = KinOrgId.make("a");
      yield* hub.publish({ type: "message.posted", orgId, message: message("a", "m1") });
      yield* hub.publish({ type: "message.posted", orgId, message: message("a", "m1") });
      yield* hub.publish({
        type: "message.posted",
        orgId,
        message: message("a", "tap", { seq: 2, tap: "approve" }),
      });
      const [first, replay, tap] = yield* Queue.takeN(results, 3);
      assert.strictEqual(first?.duplicate, false);
      assert.strictEqual(replay?.duplicate, true);
      assert.strictEqual(tap?.duplicate, false);
      const stored = yield* storedEvents();
      assert.deepStrictEqual(
        stored.map(({ event, priority }) => [event._tag, event.eventId, priority]),
        [
          ["chat.message", "chat-message:m1:lead-a", "P0"],
          ["widget.action", "widget-action:tap:lead-a", "P0"],
        ],
      );
      const event = stored[0]!.event;
      assert.strictEqual(event.agentId, "lead-a");
      assert.strictEqual(event.dedupeKey, event.eventId);
      assert.deepStrictEqual(event.provenance, message("a", "m1").author);
      assert.strictEqual(
        stored[1]!.event._tag === "widget.action" && stored[1]!.event.actionId,
        "approve",
      );
    }).pipe(Effect.provide(services)),
  );

  it.effect("never wakes a lead for its own posts or after retirement", () =>
    Effect.gen(function* () {
      yield* seed("a");
      yield* seed("b");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_agents SET retired_at = ${createdAt} WHERE agent_id = 'lead-b'`;
      const hub = yield* Hub.KinChatHub;
      const results = yield* start();
      yield* hub.publish({
        type: "message.posted",
        orgId: KinOrgId.make("a"),
        message: message("a", "reply", { agent: true }),
      });
      yield* hub.publish({
        type: "message.posted",
        orgId: KinOrgId.make("b"),
        message: message("b", "to-retired"),
      });
      yield* hub.publish({
        type: "message.posted",
        orgId: KinOrgId.make("a"),
        message: message("a", "sentinel", { seq: 2 }),
      });
      // The stream is ordered, so the sentinel's result means the earlier posts were handled.
      const result = yield* Queue.take(results);
      assert.strictEqual(result.event.eventId, "chat-message:sentinel:lead-a");
      assert.deepStrictEqual(
        (yield* storedEvents()).map(({ event }) => event.eventId),
        ["chat-message:sentinel:lead-a"],
      );
    }).pipe(Effect.provide(services)),
  );

  it.effect("catches up on owner messages the lead has not answered since its last post", () =>
    Effect.gen(function* () {
      yield* seed("a");
      yield* storeMessage(message("a", "answered", { seq: 1 }));
      yield* storeMessage(message("a", "lead-reply", { seq: 2, agent: true }));
      yield* storeMessage(message("a", "unanswered", { seq: 3 }));
      const hub = yield* Hub.KinChatHub;
      const results = yield* start();
      assert.strictEqual(
        (yield* Queue.take(results)).event.eventId,
        "chat-message:unanswered:lead-a",
      );
      yield* hub.publish({
        type: "message.posted",
        orgId: KinOrgId.make("a"),
        message: message("a", "live", { seq: 4 }),
      });
      assert.strictEqual((yield* Queue.take(results)).event.eventId, "chat-message:live:lead-a");
      assert.deepStrictEqual(
        (yield* storedEvents()).map(({ event }) => event.eventId),
        ["chat-message:live:lead-a", "chat-message:unanswered:lead-a"],
      );
    }).pipe(Effect.provide(services)),
  );
});

// @effect-diagnostics nodeBuiltinImport:off -- node:fs reads sources for the subscribeAll guard.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { KinEvent, KinMessage, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

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

const seed = Effect.fn("test.seed")(function* (
  org: string,
  kind: "direct" | "team_group" = "direct",
) {
  const sql = yield* SqlClient.SqlClient;
  const lead = `lead-${org}`;
  yield* sql`INSERT INTO kin_orgs VALUES (${org}, 'Kin', ${createdAt})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${`owner-${org}`}, ${org}, ${`owner-${org}`}, 'Owner', ${createdAt})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES (${lead}, ${org}, 'Lead', 'lead', ${`owner-${org}`}, ${createdAt})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES (${`chat-${org}`}, ${org}, ${kind}, ${kind === "direct" ? `direct-${org}` : null}, 0, ${createdAt})`;
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
  options: {
    readonly seq?: number;
    readonly agent?: boolean;
    readonly tap?: string;
    readonly chat?: string;
  } = {},
) =>
  decodeMessage({
    orgId: org,
    chatId: options.chat ?? `chat-${org}`,
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

// Records every enqueue attempt and result. `settle` publishes a post the bridge ignores and waits
// until the bridge pulls it: catch-up and every earlier hub event are handled by then.
const start = Effect.fn("test.start")(function* () {
  const attempts: Array<KinEvent> = [];
  const results: Array<{ readonly event: KinEvent; readonly duplicate: boolean }> = [];
  const pulled = yield* Queue.unbounded<string>();
  const queue = yield* KinEventQueue.KinEventQueue;
  const hub = yield* Hub.KinChatHub;
  yield* Layer.build(
    ChatWake.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(KinEventQueue.KinEventQueue, {
            ...queue,
            enqueue: (event) =>
              Effect.sync(() => attempts.push(event)).pipe(
                Effect.andThen(queue.enqueue(event)),
                Effect.tap((result) => Effect.sync(() => results.push(result))),
              ),
          }),
          Layer.succeed(Hub.KinChatHub, {
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
  let settled = 0;
  const settle = Effect.gen(function* () {
    const id = `settle-${++settled}`;
    yield* hub.publish({
      type: "message.posted",
      orgId: KinOrgId.make("a"),
      message: message("a", id, { agent: true }),
    });
    while ((yield* Queue.take(pulled)) !== id);
  });
  return { attempts, results, settle };
});

const storedEvents = Effect.fn("test.storedEvents")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ json: string; priority: string }>`
    SELECT json, priority FROM kin_events ORDER BY event_id`;
  return yield* Effect.forEach(rows, (row) =>
    decodeEventJson(row.json).pipe(Effect.map((event) => ({ event, priority: row.priority }))),
  );
});

const keys = (events: ReadonlyArray<KinEvent>) => events.map((event) => event.dedupeKey);
const post = (org: string, messageId: string, options: Parameters<typeof message>[2] = {}) =>
  Effect.gen(function* () {
    const hub = yield* Hub.KinChatHub;
    yield* hub.publish({
      type: "message.posted",
      orgId: KinOrgId.make(org),
      message: message(org, messageId, options),
    });
  });

describe("ChatWake", () => {
  it.effect("wakes the lead once for each owner message and widget tap in its chat", () =>
    Effect.gen(function* () {
      yield* seed("a");
      const { results, settle } = yield* start();
      yield* post("a", "m1");
      yield* post("a", "m1");
      yield* post("a", "tap", { seq: 2, tap: "approve" });
      yield* settle;
      assert.deepStrictEqual(
        results.map((result) => result.duplicate),
        [false, true, false],
      );
      const stored = yield* storedEvents();
      assert.deepStrictEqual(
        stored.map(({ event, priority }) => [event._tag, event.dedupeKey, priority]),
        [
          ["chat.message", "chat-message:m1:lead-a", "P0"],
          ["widget.action", "widget-action:tap:lead-a", "P0"],
        ],
      );
      const event = stored[0]!.event;
      assert.strictEqual(event.agentId, "lead-a");
      assert.match(event.eventId, /^chat-message-[a-f0-9]{32}$/);
      assert.deepStrictEqual(event.provenance, message("a", "m1").author);
      assert.strictEqual(
        stored[1]!.event._tag === "widget.action" && stored[1]!.event.actionId,
        "approve",
      );
    }).pipe(Effect.provide(services)),
  );

  it.effect("never wakes a lead for its own posts or after retirement, live or on catch-up", () =>
    Effect.gen(function* () {
      yield* seed("a");
      yield* seed("b");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_agents SET retired_at = ${createdAt} WHERE agent_id = 'lead-b'`;
      yield* storeMessage(message("b", "missed-by-retired"));
      const { attempts, settle } = yield* start();
      yield* post("a", "reply", { agent: true });
      // The bridge itself skips retired leads; the queue's own refusal is a second line.
      yield* post("b", "to-retired", { seq: 2 });
      yield* post("a", "wake", { seq: 2 });
      yield* settle;
      assert.deepStrictEqual(keys(attempts), ["chat-message:wake:lead-a"]);
      assert.deepStrictEqual(keys((yield* storedEvents()).map(({ event }) => event)), [
        "chat-message:wake:lead-a",
      ]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("never wakes a lead for group posts, live or on catch-up, until CHAT-11", () =>
    Effect.gen(function* () {
      yield* seed("a");
      yield* seed("g", "team_group");
      yield* storeMessage(message("g", "missed-group"));
      const { attempts, settle } = yield* start();
      yield* post("g", "group", { seq: 2 });
      yield* settle;
      assert.deepStrictEqual(attempts, []);
      assert.deepStrictEqual(yield* storedEvents(), []);
    }).pipe(Effect.provide(services)),
  );

  it.effect("catches up on owner messages the lead has not answered since its last post", () =>
    Effect.gen(function* () {
      yield* seed("a");
      yield* storeMessage(message("a", "answered", { seq: 1 }));
      yield* storeMessage(message("a", "lead-reply", { seq: 2, agent: true }));
      yield* storeMessage(message("a", "unanswered", { seq: 3 }));
      const { results, settle } = yield* start();
      yield* post("a", "live", { seq: 4 });
      yield* settle;
      assert.deepStrictEqual(keys(results.map((result) => result.event)), [
        "chat-message:unanswered:lead-a",
        "chat-message:live:lead-a",
      ]);
      assert.deepStrictEqual(keys((yield* storedEvents()).map(({ event }) => event)).toSorted(), [
        "chat-message:live:lead-a",
        "chat-message:unanswered:lead-a",
      ]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("stores one event when catch-up and live delivery see the same message", () =>
    Effect.gen(function* () {
      yield* seed("a");
      // Committed before catch-up reads, and published to the already subscribed bridge.
      yield* storeMessage(message("a", "both"));
      const { results, settle } = yield* start();
      yield* post("a", "both");
      yield* settle;
      assert.deepStrictEqual(
        results.map((result) => [result.event.dedupeKey, result.duplicate]),
        [
          ["chat-message:both:lead-a", false],
          ["chat-message:both:lead-a", true],
        ],
      );
      assert.lengthOf(yield* storedEvents(), 1);
    }).pipe(Effect.provide(services)),
  );

  it.effect("counts only posts a lead could answer toward the catch-up limit", () =>
    Effect.gen(function* () {
      yield* seed("a");
      const sql = yield* SqlClient.SqlClient;
      // A group the lead is in, and a retired lead's direct chat, each busier than the limit.
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES ('group-a', 'a', 'team_group', 0, ${createdAt})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
        VALUES ('lead-group-member', 'a', 'group-a', 'agent', 'lead-a', 'member', ${createdAt})`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at)
        VALUES ('old-a', 'a', 'Old', 'lead', 'owner-a', ${createdAt}, ${createdAt})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('old-chat', 'a', 'direct', 'direct-old', 0, ${createdAt})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
        VALUES ('old-member', 'a', 'old-chat', 'agent', 'old-a', 'member', ${createdAt})`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
        VALUES ('old-a', 'a', 'Old', 0, '{}', '[]', 'old-chat')`;
      // Their ids sort above the direct post, so either one counted would push it out.
      for (let seq = 1; seq <= 200; seq++) {
        const n = String(seq).padStart(3, "0");
        yield* storeMessage(message("a", `z-group-${n}`, { seq, chat: "group-a" }));
        yield* storeMessage(message("a", `y-retired-${n}`, { seq, chat: "old-chat" }));
      }
      yield* storeMessage(message("a", "a-direct"));
      const { attempts, settle } = yield* start();
      yield* settle;
      assert.deepStrictEqual(keys(attempts), ["chat-message:a-direct:lead-a"]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("limits catch-up per organization, so a busy one cannot starve another", () =>
    Effect.gen(function* () {
      yield* seed("a");
      yield* seed("b");
      for (let seq = 1; seq <= 201; seq++)
        yield* storeMessage(message("a", `m${String(seq).padStart(3, "0")}`, { seq }));
      // Sorts below org a's ids, so a single global limit would drop it.
      yield* storeMessage(message("b", "b-quiet"));
      const { results, settle } = yield* start();
      yield* settle;
      const woken = results.map((result) => result.event);
      assert.strictEqual(woken.filter((event) => event.orgId === "a").length, 200);
      assert.deepStrictEqual(keys(woken.filter((event) => event.orgId === "b")), [
        "chat-message:b-quiet:lead-b",
      ]);
    }).pipe(Effect.provide(services)),
  );

  it("keeps the every-organization chat stream away from tools and transports", () => {
    // KinChatHub sits in KinServer.services, which the MCP toolkits receive.
    const root = NodePath.resolve(import.meta.dirname, "../..");
    const readers = (NodeFS.readdirSync(root, { recursive: true }) as Array<string>)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => file.split(NodePath.sep).join("/"))
      .filter((file) =>
        /\bsubscribeAll\b/.test(NodeFS.readFileSync(NodePath.join(root, file), "utf8")),
      )
      .toSorted();
    assert.deepStrictEqual(readers, ["kin/chat/KinChatHub.ts", "kin/lead/ChatWake.ts"]);
  });
});

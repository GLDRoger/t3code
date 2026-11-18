// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import {
  KinChatError,
  KinChatId,
  KinOrgId,
  KinPersonId,
  KinWaitingId,
  type KinOpenEvent,
  type KinOpenRead,
  kinOpenApply,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinChatHub from "../chat/KinChatHub.ts";
import * as KinChatRepository from "../chat/KinChatRepository.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import * as RefreshHub from "../chat/KinRefreshHub.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinRecords from "../work/KinRecords.ts";
import * as Open from "./people.ts";

// Invented company, people and tasks only: Ambermill.
const orgId = KinOrgId.make("ambermill");
const rhea = KinPersonId.make("rhea");
const meera = KinPersonId.make("meera");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 19, 12);
const stamp = "2026-10-01T00:00:00.000Z";
const as = (personId: KinPersonId, org = orgId): ReadonlyArray<PersonIdentity> => [
  { _tag: "person", orgId: org, personId },
];

const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId, personId: rhea },
  isAgentThread: () => false,
  isLeadThread: () => false,
});
const gate = Layer.mock(KinLevelGate)({
  ask: () => Effect.fail(new KinChatError({ reason: "unavailable", message: "No chat here." })),
});
const layer = Layer.mergeAll(KinChatHub.layer, KinRecords.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(KinChatRepository.layer, RefreshHub.layer, identity, gate)),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

const task = Effect.fn("test.task")(function* (
  key: string,
  owner: KinPersonId,
  dueAt: number,
  sensitive = 0,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
      owner_id, due_at, sensitive, created_by_kind, created_by_id, origin_key, created_at,
      updated_at)
    VALUES (${orgId}, ${`r-${key}`}, 'work', ${key}, ${`Invented ${key}`}, 'doing', 'person',
      ${owner}, ${dueAt}, ${sensitive}, 'person', ${owner}, ${`origin-${key}`}, ${NOW - HOUR},
      ${NOW - HOUR})`;
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${stamp})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'UTC', '08:30', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  for (const [person, access] of [
    [rhea, "owner"],
    [meera, "member"],
  ] as const)
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${person}, ${orgId}, ${person}, ${person}, ${stamp}, ${access})`;
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
    VALUES (${orgId}, 'work', 'work', 'W', 1, 0)`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
    VALUES ('chat-meera', ${orgId}, 'team_group', 0, ${stamp})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
      role, joined_at)
    VALUES ('member-meera', ${orgId}, 'chat-meera', 'person', ${meera}, 'member', ${stamp})`;
  // Rhea's sensitive late task: never anywhere in Meera's stream.
  yield* task("W-1", rhea, NOW - 2 * DAY, 1);
  yield* task("W-2", meera, NOW + HOUR);
});

const follow = Effect.fn("test.follow")(function* (people: ReadonlyArray<PersonIdentity>) {
  const events = yield* Queue.unbounded<KinOpenEvent>();
  yield* Open.subscribe(people, { orgId }).pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  return events;
});
const mentions = (read: KinOpenRead, key: string) => JSON.stringify(read.rows).includes(key);

it.effect("a card that starts waiting on her reaches her stream as only what moved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed;
      const events = yield* follow(as(meera));
      const first = yield* Queue.take(events);
      if (first._tag !== "snapshot") return yield* Effect.die(new Error("No first list."));
      assert.deepStrictEqual(
        first.read.rows.map((row) => row.id),
        ["task:W-2"],
      );
      assert.isFalse(mentions(first.read, "W-1"));

      const sql = yield* SqlClient.SqlClient;
      const item = {
        waitingId: KinWaitingId.make("wait-1"),
        orgId,
        personId: meera,
        chatId: KinChatId.make("chat-meera"),
        messageId: null,
        widgetId: null,
        reason: "mention" as const,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(NOW - HOUR)),
        resolvedAt: null,
        resolution: null,
      };
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO kin_waiting (waiting_id, org_id, person_id, chat_id, reason,
              created_at)
            VALUES (${item.waitingId}, ${orgId}, ${meera}, ${item.chatId}, 'mention',
              ${item.createdAt})`;
          yield* (yield* KinChatHub.KinChatHub).publish({ type: "waiting.updated", orgId, item });
        }),
      );
      const change = yield* Queue.take(events);
      if (change._tag !== "changed") return yield* Effect.die(new Error("No change."));
      assert.deepStrictEqual(
        change.updated.map((row) => row.id),
        ["waiting:wait-1"],
      );
      const fresh = yield* Open.read(as(meera), { orgId });
      assert.deepStrictEqual<unknown>(
        { ...kinOpenApply(first.read, change), asOf: fresh.asOf },
        fresh,
      );
      assert.deepStrictEqual(fresh.counts, { needsYou: 2, waiting: 1 });
      assert.isFalse(mentions(fresh, "W-1"));
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a session for another company's person ends not_found", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed;
      const error = yield* Open.subscribe(as(meera, KinOrgId.make("elsewhere")), {
        orgId: KinOrgId.make("elsewhere"),
      }).pipe(Stream.runCollect, Effect.flip);
      assert.strictEqual(error.reason, "not_found");
    }),
  ).pipe(Effect.provide(layer)),
);

// @effect-diagnostics globalDate:off -- fixed invented dates.
// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  KinChatError,
  KinOrgId,
  KinPersonId,
  type KinPulseEvent,
  kinPulseApply,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import * as RefreshHub from "../chat/KinRefreshHub.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinImport from "../work/KinImport.ts";
import { readOnlyStream } from "../readRpcs.ts";
import * as KinRecords from "../work/KinRecords.ts";
import * as Work from "../work/ownerWork.ts";
import * as KinPulse from "./KinPulse.ts";
import * as Pulse from "./people.ts";

// Invented org, people and tasks only.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const coraId = KinPersonId.make("cora");
const NOW = Date.parse("2026-11-12T06:00:00.000Z");
const day = (offset: number) => new Date(NOW + offset * 86_400_000).toISOString().slice(0, 10);
const as = (personId: KinPersonId): ReadonlyArray<PersonIdentity> => [
  { _tag: "person", orgId, personId },
];

const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId, personId: ownerId },
  isAgentThread: () => false,
  isLeadThread: () => false,
});
const gate = Layer.mock(KinLevelGate)({
  ask: () => Effect.fail(new KinChatError({ reason: "unavailable", message: "No chat here." })),
});
const layerOn = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  KinImport.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(KinRecords.layer, identity, gate)),
    Layer.provideMerge(RefreshHub.layer),
    Layer.provideMerge(KinEventQueue.layer),
    Layer.provideMerge(KinPersistence.layer),
    Layer.provideMerge(database),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-pulse-people-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  );
const testLayer = layerOn(Sqlite.layerMemory);
// A file database, so the reader pool runs as it does on a host: in memory there is one connection.
const fileLayer = layerOn(
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "kin-pulse-streams-" });
      return Sqlite.layerFromPath(path.join(directory, "state.sqlite"));
    }),
  ).pipe(Layer.provide(NodeServices.layer)),
);

const lateTask = (source: string, title: string) => ({
  entry: { source, list: "work", title, state: "open", due: day(-2), createdAt: day(-5) },
});
const importTasks = (batch: string, entries: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const lines = [{ format: "kin-import", version: 1, batch, source: "pulse people" }, ...entries];
    yield* (yield* KinImport.KinImport).apply(
      orgId,
      ownerId,
      Stream.fromIterable(lines.map((line) => JSON.stringify(line))),
    );
  });
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Studio', '2026-01-01')`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief,
      evening_summary, dream, full_rebuild_weekday, owner_check_weekday, owner_check,
      quiet_hours_json)
    VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  for (const [person, access] of [
    [ownerId, "owner"],
    [coraId, "co_owner"],
  ] as const)
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
        access, sees_docs, sees_clients)
      VALUES (${person}, ${orgId}, ${person}, ${person}, '2026-01-01', ${access}, 1, 1)`;
  yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
    VALUES ('session-cora', ${orgId}, ${coraId}, 0)`;
  // The owner's own task is late: on a co-owner's Needs attention, not a member's.
  yield* importTasks("pulse-people", [lateTask("t1", "Invented: send the venue the floor plan")]);
});
const page = { orgId, includeHandled: true, limit: 8 } as const;
const watch = (personId: KinPersonId, onReader = false) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<KinPulseEvent>();
    const stream = Pulse.subscribe(as(personId), page);
    yield* (onReader ? readOnlyStream(stream) : stream).pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
    const first = yield* Queue.take(events);
    if (first._tag !== "snapshot") return yield* Effect.die(new Error("No first page."));
    let held = first.read;
    /** The next change, folded onto the page held, beside a fresh read. */
    const next = Effect.gen(function* () {
      const change = yield* Queue.take(events);
      if (change._tag !== "changed") return yield* Effect.die(new Error("No change."));
      held = kinPulseApply(held, change);
      const fresh = yield* Pulse.read(as(personId), page);
      return { folded: { ...held, asOf: fresh.asOf }, fresh };
    });
    return { first: first.read, next };
  });

it.effect("a co-owner made a member mid-stream has her Needs attention moved to a member's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* KinPulse.tick(orgId, NOW);
      const screen = yield* watch(coraId);
      assert.isAbove(screen.first.facts.length, 0, "the owner's task as a co-owner sees it");

      yield* sql`UPDATE kin_people SET access = 'member' WHERE person_id = ${coraId}`;
      yield* (yield* KinRecords.KinRecords).peopleMoved(orgId, [coraId]);
      const { folded, fresh } = yield* screen.next;
      assert.deepStrictEqual<unknown>(folded, fresh);
      assert.strictEqual(folded.facts.length, 0, "a member is shown none of the owner's tasks");
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("a screen the pulse moves shows its tick's facts, never an older tick's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* KinPulse.tick(orgId, NOW - 60_000);
      // Late since that tick: the screen opened after it shows it.
      yield* importTasks("pulse-people-2", [lateTask("t2", "Invented: book the caterer")]);
      const screen = yield* watch(ownerId);
      assert.strictEqual(screen.first.facts.length, 2);

      // Its page moves with no tick since: the older tick's facts would drop the second task.
      yield* sql`UPDATE kin_pulse_facts SET handled_by_kind = 'person', handled_by_id = ${ownerId},
        handled_at = ${NOW} WHERE org_id = ${orgId}`;
      yield* (yield* RefreshHub.KinRefreshObserver).touch(orgId, "pulse");
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      const handled = yield* screen.next;
      assert.deepStrictEqual<unknown>(handled.folded, handled.fresh);
      assert.strictEqual(handled.folded.facts.length, 2);

      yield* importTasks("pulse-people-3", [lateTask("t3", "Invented: print the menus")]);
      yield* KinPulse.tick(orgId, NOW);
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      const ticked = yield* screen.next;
      assert.deepStrictEqual<unknown>(ticked.folded, ticked.fresh);
      assert.strictEqual(ticked.folded.facts.length, 3);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("Tasks' Needs you count rides the stream that asks for it and moves with Work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed;
      yield* KinPulse.tick(orgId, NOW);
      const events = yield* Queue.unbounded<KinPulseEvent>();
      yield* Pulse.subscribe(as(ownerId), { ...page, tasksNeedsYou: true }).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      // The Tasks screen's own count, as its Needs you heading reads it.
      const tasksScreen = Work.list(as(ownerId), { orgId, open: true, byMove: true }).pipe(
        Effect.map((one) => one.counts?.needsYou),
      );
      const first = yield* Queue.take(events);
      if (first._tag !== "snapshot") return yield* Effect.die(new Error("No first page."));
      assert.strictEqual(first.read.tasksNeedsYou, yield* tasksScreen);

      // A task late for the owner moves the count with no pulse tick, and only the count.
      yield* importTasks("pulse-people-count", [lateTask("t2", "Invented: book the caterer")]);
      const change = yield* Queue.take(events);
      if (change._tag !== "changed") return yield* Effect.die(new Error("No change."));
      assert.deepStrictEqual([change.updated, change.removed], [[], []]);
      const folded = kinPulseApply(first.read, change).tasksNeedsYou;
      assert.strictEqual(folded, yield* tasksScreen);
      assert.strictEqual(folded, (first.read.tasksNeedsYou ?? 0) + 1);
      // A stream that didn't ask is sent no count.
      const plain = Option.getOrThrow(yield* Stream.runHead(Pulse.subscribe(as(ownerId), page)));
      assert.notProperty(plain._tag === "snapshot" ? plain.read : plain, "tasksNeedsYou");
    }),
  ).pipe(Effect.provide(testLayer)),
);

// k3's scratch harness saw the tick never finish at 10,000 entries with four screens open.
it.effect("a tick at ten thousand entries finishes with four Needs attention streams open", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      // Ten thousand open tasks copied from the imported one in one statement; one in 25 late, under the senses' cap.
      const columns = (yield* sql<{
        name: string;
      }>`SELECT name FROM pragma_table_info('kin_records')
        ORDER BY cid`).map((row) => row.name);
      const copied: Record<string, string> = {
        record_id: "'bulk-' || n",
        key: "'W-' || (n + 100)",
        origin_key: "'bulk:' || n",
        title: "'Invented: bulk task ' || n",
        due_at: `CASE WHEN n % 25 = 0 THEN ${NOW - 2 * 86_400_000} ELSE ${NOW + 30 * 86_400_000} END`,
      };
      yield* sql.unsafe(
        `WITH RECURSIVE bulk(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM bulk
          WHERE n < 10000)
        INSERT INTO kin_records (${columns.join(", ")})
        SELECT ${columns.map((name) => copied[name] ?? `t.${name}`).join(", ")}
        FROM bulk, kin_records t WHERE t.org_id = ? AND t.origin_key = (SELECT origin_key
          FROM kin_records WHERE org_id = ? ORDER BY created_at LIMIT 1)`,
        [orgId, orgId],
      );
      yield* sql`UPDATE kin_registers SET next_number = 20000 WHERE org_id = ${orgId}
        AND register_id = (SELECT register_id FROM kin_records WHERE org_id = ${orgId}
          AND record_id = 'bulk-1')`;
      const [count] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records
        WHERE org_id = ${orgId}`;
      assert.strictEqual(count!.n, 10_001);
      const before = yield* KinPulse.tick(orgId, NOW - 60_000);
      assert.isAtLeast(before.facts, 400);
      // As the RPC boundary serves them: on the reader pool.
      const screens = yield* Effect.forEach([ownerId, ownerId, coraId, coraId], (personId) =>
        watch(personId, true),
      );
      const shown = screens[0]!.first.total;
      assert.isAtLeast(shown, 400);
      for (const screen of screens) assert.strictEqual(screen.first.total, shown);

      yield* importTasks("pulse-streams", [lateTask("t2", "Invented: book the caterer")]);
      const ticked = yield* KinPulse.tick(orgId, NOW);
      assert.strictEqual(ticked.facts, before.facts + 1);
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      for (const screen of screens) {
        const { folded, fresh } = yield* screen.next;
        assert.deepStrictEqual<unknown>(folded, fresh);
        assert.strictEqual(folded.total, shown + 1);
      }
    }),
  ).pipe(Effect.provide(fileLayer)),
);

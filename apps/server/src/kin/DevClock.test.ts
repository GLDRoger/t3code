import { assert, describe, it } from "@effect/vitest";
import { KinOrgId, KinPersonId, KinTrigger } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as DevClock from "./DevClock.ts";
import * as KinPersistence from "./persistence/KinPersistence.ts";
import { personHoldNow } from "./triggers/quietHold.ts";
import * as KinTriggerInbox from "./triggers/KinTriggerInbox.ts";
import * as KinTriggerScheduler from "./triggers/KinTriggerScheduler.ts";
import * as KinTriggerStore from "./triggers/KinTriggerStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";

const HOUR = 3_600_000;
// Friday 20 November 2026, 21:00 UTC.
const EVENING = Date.UTC(2026, 10, 20, 21);

const config = (dev: boolean) =>
  Layer.mergeAll(
    Layer.effect(
      ServerConfig,
      Effect.map(ServerConfig, (base) => ({
        ...base,
        devUrl: dev ? new URL("http://127.0.0.1:5733") : undefined,
      })),
    ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "kin-dev-clock-" }))),
    ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_DEV_CLOCK: "true" })),
  ).pipe(Layer.provideMerge(NodeServices.layer));

const decodeTrigger = Schema.decodeEffect(KinTrigger);
const database = KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

/** What `kv clock` writes: the offset from the real time, in the server's state directory. */
const writeOffset = Effect.fn("test.writeOffset")(function* (offsetMs: number) {
  const { stateDir } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* fs.writeFileString(
    (yield* Path.Path).join(stateDir, DevClock.DEV_CLOCK_FILE),
    JSON.stringify({ offsetMs }),
  );
});

describe("Kin's dev clock", () => {
  it.effect("a server without a dev URL keeps its clock, whatever the file and setting say", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EVENING);
      yield* writeOffset(3 * HOUR);
      const outside = yield* Clock.Clock;
      const inside = yield* Effect.gen(function* () {
        yield* (yield* DevClock.KinDevClock).reload;
        return yield* Clock.Clock;
      }).pipe(Effect.provide(DevClock.layer));
      assert.strictEqual(inside, outside);
    }).pipe(Effect.provide(config(false))),
  );

  it.effect("on a dev server the time moves forward only, and a sleep ends when it passes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EVENING);
      yield* writeOffset(HOUR);
      yield* Effect.gen(function* () {
        assert.strictEqual(yield* Clock.currentTimeMillis, EVENING + HOUR);
        const sleeper = yield* Effect.sleep("2 hours").pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* writeOffset(0);
        yield* (yield* DevClock.KinDevClock).reload;
        assert.strictEqual(yield* Clock.currentTimeMillis, EVENING + HOUR);
        // No TestClock step: the move alone ends the sleep.
        yield* writeOffset(3 * HOUR);
        yield* (yield* DevClock.KinDevClock).reload;
        yield* Fiber.join(sleeper);
        assert.strictEqual(yield* Clock.currentTimeMillis, EVENING + 3 * HOUR);
      }).pipe(Effect.provide(DevClock.layer));
    }).pipe(Effect.provide(config(true))),
  );

  it.effect("Kin's scheduler fires a 09:30 slot once, when the moved clock passes it", () =>
    Effect.gen(function* () {
      const orgId = KinOrgId.make("org");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', '2026-10-01T00:00:00.000Z')`;
      const store = yield* KinTriggerStore.KinTriggerStore;
      // 09:30 on Saturday 21 November in UTC+14 is 19:30 UTC on Friday.
      const due = "2026-11-20T19:30:00.000Z";
      const morning = yield* decodeTrigger({
        id: "morning",
        orgId,
        subject: { type: "routine", routine: "morning_brief" },
        schedule: { type: "fixed_time", timeOfDay: "09:30" },
        timeZone: "Etc/GMT-14",
        enabled: true,
        nextRunAt: due,
        lastFireId: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      });
      yield* store.put(morning);
      const seen = yield* Queue.unbounded<string>();
      const observed = KinTriggerStore.KinTriggerStore.of({
        ...store,
        listDue: (...args) =>
          store.listDue(...args).pipe(Effect.tap(() => Queue.offer(seen, "scan"))),
        fire: (...args) =>
          store.fire(...args).pipe(Effect.tap(() => Queue.offer(seen, args[0].fireId))),
      });
      const until = Effect.fn("test.until")(function* (what: string) {
        const taken: Array<string> = [];
        while (taken.at(-1) !== what) taken.push(yield* Queue.take(seen));
        return taken;
      });
      // 09:29 company time on the real (test) clock.
      yield* TestClock.setTime(Date.parse(due) - 60_000);
      yield* writeOffset(0);
      const testClock = yield* Clock.Clock;
      // Inside, `Clock` is the dev clock; the test clock under it is stepped directly.
      const step = TestClock.adjust("5 seconds").pipe(
        Effect.provideService(Clock.Clock, testClock),
      );
      yield* Effect.gen(function* () {
        const devClock = yield* DevClock.KinDevClock;
        assert.deepStrictEqual(yield* until("scan"), ["scan"]);
        for (const minutes of [1, 2]) {
          yield* writeOffset(minutes * 60_000);
          yield* devClock.reload;
          yield* step;
          yield* until("scan");
        }
        // Two whole passes after the move to 09:31: the slot fired in one, and only once.
        yield* step;
        yield* until("scan");
        const fires = yield* sql<{ fireId: string }>`SELECT fire_id AS "fireId"
          FROM kin_trigger_fires ORDER BY fire_id`;
        assert.deepStrictEqual(
          fires.map((row) => row.fireId),
          [`morning:${Date.parse(due)}`],
        );
        assert.strictEqual(
          (yield* store.get(orgId, morning.id))?.nextRunAt,
          "2026-11-21T19:30:00.000Z",
        );
      }).pipe(
        Effect.provide(
          KinTriggerScheduler.layer.pipe(
            Layer.provide(Scheduler.layer),
            Layer.provide(Layer.succeed(KinTriggerStore.KinTriggerStore, observed)),
            Layer.provideMerge(DevClock.layer),
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.merge(KinTriggerStore.layer, KinTriggerInbox.layer).pipe(
            Layer.provideMerge(database),
            Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
          ),
          config(true),
        ),
      ),
    ),
  );

  it.effect("quiet hours follow the moved clock", () =>
    Effect.gen(function* () {
      const orgId = KinOrgId.make("org");
      const personId = KinPersonId.make("meera");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', '2026-10-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
          time_zone, quiet_hours_json, hold_outside_hours)
        VALUES (${personId}, ${orgId}, 'meera', 'Meera', '2026-10-01T00:00:00.000Z', 'UTC',
          '{"from":"22:00","to":"08:00"}', 0)`;
      yield* TestClock.setTime(EVENING);
      yield* writeOffset(0);
      yield* Effect.gen(function* () {
        assert.isUndefined(yield* personHoldNow(orgId, personId));
        yield* writeOffset(2 * HOUR);
        yield* (yield* DevClock.KinDevClock).reload;
        assert.strictEqual(yield* personHoldNow(orgId, personId), "quiet");
      }).pipe(Effect.provide(DevClock.layer));
    }).pipe(Effect.provide(Layer.mergeAll(database, config(true)))),
  );
});

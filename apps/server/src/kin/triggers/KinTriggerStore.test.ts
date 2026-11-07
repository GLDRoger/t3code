import { assert, describe, it } from "@effect/vitest";
import {
  KinOrgId,
  KinTrigger,
  KinTriggerFired,
  KinTriggerFireId,
  KinTriggerId,
  KinTriggerSettings,
  KinWebhookSource,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";

const database = KinPersistence.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const inboxLayer = KinTriggerInbox.layer.pipe(Layer.provideMerge(database));
const layer = KinTriggerStore.layer.pipe(Layer.provideMerge(inboxLayer));
const orgA = Schema.decodeSync(KinOrgId)("org-a");
const orgB = Schema.decodeSync(KinOrgId)("org-b");
const timestamp = "2026-11-07T00:00:00.000Z";
const now = 1794009600000;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  for (const org of [orgA, orgB]) {
    yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${org}, 'Kin', ${timestamp})`;
  }
});

const decodeTrigger = Schema.decodeSync(KinTrigger);
const decodeTriggerId = Schema.decodeSync(KinTriggerId);
const decodeFire = Schema.decodeSync(KinTriggerFired);
const decodeFireId = Schema.decodeSync(KinTriggerFireId);
const decodeSource = Schema.decodeEffect(KinWebhookSource);
const decodeSettings = Schema.decodeEffect(KinTriggerSettings);
const isFireConflict = Schema.is(KinTriggerStore.KinTriggerFireConflict);

function trigger(id = "trigger-a", orgId = orgA): KinTrigger {
  return decodeTrigger({
    id: decodeTriggerId(id),
    orgId,
    subject: { type: "reminder", itemId: "item" },
    schedule: { type: "interval", everyMs: 60000 },
    timeZone: "Asia/Kolkata",
    enabled: true,
    nextRunAt: timestamp,
    lastFireId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function fire(value: KinTrigger, fireId = "trigger-a:1794009600000"): KinTriggerFired {
  return decodeFire({
    fireId: decodeFireId(fireId),
    orgId: value.orgId,
    dueAt: timestamp,
    firedAt: timestamp,
    lateByMs: 0,
    payload: { kind: "time", triggerId: value.id, subject: value.subject },
  });
}

describe("KinTriggerStore", () => {
  it.effect("upserts idempotently and scopes CRUD to the org", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* KinTriggerStore.KinTriggerStore;
      const sql = yield* SqlClient.SqlClient;
      const value = trigger();
      yield* store.put(value);
      yield* store.put(value);
      assert.deepStrictEqual(yield* store.get(orgA, value.id), value);
      assert.deepStrictEqual(yield* store.list(orgA), [value]);
      assert.deepStrictEqual(yield* store.list(orgB), []);
      assert.isUndefined(yield* store.get(orgB, value.id));
      for (const field of ["nextRunAt", "createdAt", "updatedAt"] as const) {
        const error = yield* Effect.flip(store.put({ ...value, [field]: "not-a-date" }));
        assert.strictEqual(error._tag, "PersistenceDecodeError");
        assert.deepStrictEqual(yield* store.get(orgA, value.id), value);
      }
      yield* store.delete(orgB, value.id);
      const changed = { ...value, enabled: false };
      yield* store.put(changed);
      assert.deepStrictEqual(yield* store.list(orgA), [changed]);
      assert.deepStrictEqual(yield* sql`SELECT org_id FROM kin_triggers`, [{ org_id: orgA }]);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(store.put({ ...value, orgId: orgB }))));
      assert.deepStrictEqual(yield* store.list(orgA), [changed]);
      yield* store.delete(orgA, value.id);
      assert.deepStrictEqual(yield* store.list(orgA), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists enabled due triggers inclusively in instant order", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* KinTriggerStore.KinTriggerStore;
      for (const [id, nextRunAt, enabled, orgId] of [
        ["past", "2026-11-06T23:59:59.999Z", true, orgA],
        ["boundary", "2026-11-07T05:30:00.000+05:30", true, orgB],
        ["future", "2026-11-07T00:00:00.001Z", true, orgA],
        ["disabled", timestamp, false, orgA],
        ["cleared", null, true, orgA],
      ] as const) {
        yield* store.put({ ...trigger(id, orgId), nextRunAt, enabled });
      }
      for (const [time, ids] of [
        [now - 2, []],
        [now - 1, ["past"]],
        [now, ["past", "boundary"]],
        [now + 1, ["past", "boundary", "future"]],
      ] as const) {
        assert.deepStrictEqual(
          (yield* store.listDue(time)).map((row) => String(row.id)),
          [...ids],
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fires once atomically, advances recurring schedules and clears once schedules", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* KinTriggerStore.KinTriggerStore;
      const inbox = yield* KinTriggerInbox.KinTriggerInbox;
      const sql = yield* SqlClient.SqlClient;
      for (const type of ["interval", "once"] as const) {
        const value = trigger(type);
        const scheduled = {
          ...value,
          schedule: type === "once" ? { type, runAt: timestamp } : value.schedule,
        };
        yield* store.put(scheduled);
        const event = fire(value, `${type}:${now}`);
        const next = "2026-11-07T00:01:00.000Z";
        const results = yield* Effect.all([store.fire(event, next), store.fire(event, next)], {
          concurrency: "unbounded",
        });
        assert.deepStrictEqual(results.sort(), ["duplicate", "fired"]);
        const after = yield* store.get(orgA, value.id);
        assert.strictEqual(after?.nextRunAt, type === "once" ? null : next);
        assert.strictEqual(after?.lastFireId, event.fireId);
        assert.strictEqual(yield* store.fire(event, "2026-11-08T00:00:00.000Z"), "duplicate");
        assert.deepStrictEqual(yield* store.get(orgA, value.id), after);
      }
      assert.lengthOf(yield* inbox.list(orgA), 2);
      assert.deepStrictEqual(yield* sql`SELECT org_id, fired_at FROM kin_trigger_fires`, [
        { org_id: orgA, fired_at: now },
        { org_id: orgA, fired_at: now },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT org_id, received_at FROM kin_trigger_inbox`, [
        { org_id: orgA, received_at: now },
        { org_id: orgA, received_at: now },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rolls back the fire and schedule when inbox insertion fails", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* KinTriggerStore.KinTriggerStore;
      const sql = yield* SqlClient.SqlClient;
      const value = trigger();
      yield* store.put(value);
      for (const reject of [
        sql`CREATE TRIGGER reject_inbox BEFORE INSERT ON kin_trigger_inbox
            BEGIN SELECT RAISE(ABORT, 'inbox unavailable'); END`,
        sql`CREATE TRIGGER reject_inbox BEFORE INSERT ON kin_trigger_inbox
            BEGIN SELECT RAISE(IGNORE); END`,
      ]) {
        yield* reject;
        const result = yield* Effect.exit(store.fire(fire(value), null));
        assert.isTrue(Exit.isFailure(result));
        assert.deepStrictEqual(yield* sql`SELECT * FROM kin_trigger_fires`, []);
        assert.deepStrictEqual(yield* sql`SELECT * FROM kin_trigger_inbox`, []);
        assert.deepStrictEqual(yield* store.get(orgA, value.id), value);
        yield* sql`DROP TRIGGER reject_inbox`;
      }
      assert.strictEqual(yield* store.fire(fire(value), null), "fired");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "rejects stale, disabled, missing and cross-org time fires without persisting anything",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* KinTriggerStore.KinTriggerStore;
        const sql = yield* SqlClient.SqlClient;
        const value = trigger();
        yield* store.put(value);
        for (const candidate of [
          { ...fire(value), dueAt: "2026-11-06T00:00:00.000Z" },
          fire(trigger("missing")),
          { ...fire(value), orgId: orgB },
        ]) {
          const result = yield* Effect.flip(store.fire(candidate, null));
          assert.isTrue(isFireConflict(result));
        }
        for (const field of ["dueAt", "firedAt"] as const) {
          const error = yield* Effect.flip(
            store.fire({ ...fire(value), [field]: "not-a-date" }, null),
          );
          assert.strictEqual(error._tag, "PersistenceDecodeError");
        }
        const invalidNext = yield* Effect.flip(store.fire(fire(value), "not-a-date"));
        assert.strictEqual(invalidNext._tag, "PersistenceDecodeError");
        yield* store.put({ ...value, enabled: false });
        assert.isTrue(isFireConflict(yield* Effect.flip(store.fire(fire(value), null))));
        assert.deepStrictEqual(yield* sql`SELECT * FROM kin_trigger_fires`, []);
        assert.deepStrictEqual(yield* sql`SELECT * FROM kin_trigger_inbox`, []);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "prunes fires strictly older than 30 days without deleting inbox work or allowing a replay",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* KinTriggerStore.KinTriggerStore;
        const sql = yield* SqlClient.SqlClient;
        const value = trigger();
        yield* store.put(value);
        const event = fire(value);
        assert.strictEqual(yield* store.fire(event, null), "fired");
        const retention = 30 * 24 * 60 * 60 * 1000;
        assert.strictEqual(yield* store.pruneFires(now + retention), 0);
        yield* sql`INSERT INTO kin_trigger_fires (fire_id, org_id, fired_at) VALUES ('newer', ${orgB}, ${now + 1})`;
        assert.strictEqual(yield* store.pruneFires(now + retention + 1), 1);
        assert.deepStrictEqual(yield* sql`SELECT fire_id, org_id FROM kin_trigger_fires`, [
          { fire_id: "newer", org_id: orgB },
        ]);
        assert.lengthOf(yield* sql`SELECT * FROM kin_trigger_inbox`, 1);
        assert.strictEqual(yield* store.fire(event, timestamp), "duplicate");
        assert.isNull((yield* store.get(orgA, value.id))?.nextRunAt);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "stores source, settings and ping records without upstream rows and enforces their org keys",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const source = yield* decodeSource({
          id: "source",
          orgId: orgA,
          repo: "owner/repo",
          scheduledTaskId: "task",
          inboxThreadId: "thread",
          githubHookId: null,
          botLogin: "kin[bot]",
          status: "active",
        });
        yield* sql`
      INSERT INTO kin_webhook_sources (source_id, org_id, repo, scheduled_task_id, inbox_thread_id, github_hook_id, bot_login, status)
      VALUES (${source.id}, ${source.orgId}, ${source.repo}, ${source.scheduledTaskId}, ${source.inboxThreadId}, ${source.githubHookId}, ${source.botLogin}, ${source.status})
    `;
        const settings = yield* decodeSettings({
          orgId: orgA,
          timeZone: "Asia/Kolkata",
          morningBrief: "08:30",
          eveningSummary: "18:30",
          dream: "03:00",
          fullRebuildWeekday: 0,
          ownerCheckWeekday: 1,
          ownerCheck: "09:00",
          quietHours: { from: "21:00", to: "08:00" },
        });
        yield* sql`
      INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary, dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
      VALUES (${settings.orgId}, ${settings.timeZone}, ${settings.morningBrief}, ${settings.eveningSummary}, ${settings.dream}, ${settings.fullRebuildWeekday}, ${settings.ownerCheckWeekday}, ${settings.ownerCheck}, ${JSON.stringify(settings.quietHours)})
    `;
        for (const org of [orgA, orgB]) {
          yield* sql`
        INSERT INTO kin_ping_ledger (org_id, person, item_id, day, pinged_at)
        VALUES (${org}, 'person', 'item', '2026-11-07', ${now})
      `;
        }
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(sql`
      INSERT INTO kin_ping_ledger (org_id, person, item_id, day, pinged_at)
      VALUES (${orgA}, 'person', 'item', '2026-11-07', ${now})
    `),
          ),
        );
        assert.deepStrictEqual(yield* sql`SELECT org_id FROM kin_webhook_sources`, [
          { org_id: orgA },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT org_id FROM kin_trigger_settings`, [
          { org_id: orgA },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT org_id FROM kin_ping_ledger ORDER BY org_id`, [
          { org_id: orgA },
          { org_id: orgB },
        ]);
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      }).pipe(Effect.provide(layer)),
  );
});

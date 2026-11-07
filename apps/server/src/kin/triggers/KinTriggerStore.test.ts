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

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";

const database = KinPersistence.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const inboxLayer = KinTriggerInbox.layer.pipe(Layer.provideMerge(database));
const layer = KinTriggerStore.layer.pipe(
  Layer.provideMerge(inboxLayer),
  Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
);
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
      for (const lastFireId of ["unknown", "another-trigger:0"]) {
        const untrusted = { ...value, lastFireId: decodeFireId(lastFireId) };
        yield* store.put(untrusted);
      }
      assert.deepStrictEqual(yield* store.get(orgA, value.id), value);
      assert.deepStrictEqual(yield* store.list(orgA), [value]);
      assert.deepStrictEqual(yield* store.list(orgB), []);
      assert.isUndefined(yield* store.get(orgB, value.id));
      for (const invalid of [
        "not-a-date",
        "1",
        "2026-11-07",
        "Nov 7 2026",
        "2026-11-07 00:00",
        "2026-11-07T00:00:00",
      ]) {
        for (const field of ["nextRunAt", "createdAt", "updatedAt"] as const) {
          const error = yield* Effect.flip(store.put({ ...value, [field]: invalid }));
          assert.strictEqual(error._tag, "PersistenceDecodeError");
          assert.deepStrictEqual(yield* store.get(orgA, value.id), value);
        }
      }
      for (const id of ["gh:", "gh:trigger", "gh:org-a:delivery"]) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(store.put(trigger(id)))));
      }
      yield* store.delete(orgB, value.id);
      const changed = { ...value, enabled: false };
      yield* store.put(changed);
      assert.deepStrictEqual(yield* store.list(orgA), [changed]);
      assert.deepStrictEqual(yield* sql`SELECT org_id FROM kin_triggers`, [{ org_id: orgA }]);
      yield* store.put({ ...value, orgId: orgB });
      assert.deepStrictEqual(yield* store.get(orgB, value.id), { ...value, orgId: orgB });
      yield* store.put({ ...changed, createdAt: "2026-11-08T00:00:00.000Z" });
      assert.strictEqual((yield* store.get(orgA, value.id))?.createdAt, timestamp);
      yield* store.delete(orgB, value.id);
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
        ["boundary", timestamp, true, orgB],
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
          (yield* store.listDue(time, 100)).map((row) => String(row.id)),
          [...ids],
        );
      }
      const sql = yield* SqlClient.SqlClient;
      yield* store.put(trigger("corrupt"));
      yield* sql`UPDATE kin_triggers SET schedule_json = 'bad' WHERE org_id = ${orgA} AND trigger_id = 'corrupt'`;
      assert.deepStrictEqual(
        (yield* store.listDue(now, 100)).map((row) => String(row.id)),
        ["past", "boundary"],
      );
      assert.lengthOf(yield* store.listDue(now, 1), 1);
      for (const id of ["corrupt-first-a", "corrupt-first-b"]) {
        yield* store.put({ ...trigger(id), nextRunAt: "2026-11-06T00:00:00.000Z" });
        yield* sql`UPDATE kin_triggers SET schedule_json = 'bad' WHERE org_id = ${orgA} AND trigger_id = ${id}`;
      }
      assert.deepStrictEqual(
        (yield* store.listDue(now, 2)).map((row) => String(row.id)),
        ["past", "boundary"],
      );
      const firstPage = yield* store.listDue(now + 1, 2);
      assert.deepStrictEqual(
        firstPage.map((row) => String(row.id)),
        ["past", "boundary"],
      );
      const past = trigger("past");
      yield* store.fire(
        { ...fire(past, `past:${now - 1}`), dueAt: "2026-11-06T23:59:59.999Z", lateByMs: 1 },
        null,
      );
      assert.deepStrictEqual(
        (yield* store.listDue(now + 1, 2, {
          nextRunAt: now,
          orgId: orgB,
          id: decodeTriggerId("boundary"),
        })).map((row) => String(row.id)),
        ["future"],
      );
      const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
        SELECT trigger_id FROM kin_triggers
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ${now}
          AND (next_run_at, org_id, trigger_id) > (${now - 1}, ${orgA}, 'past')
        ORDER BY next_run_at, org_id, trigger_id LIMIT 2`;
      assert.isTrue(plan.some((row) => row.detail.includes("idx_kin_triggers_due")));
      assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
      for (const invalid of [NaN, 1.5, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(store.listDue(invalid, 100))));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(store.pruneFires(invalid))));
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "deduplicates serialized fire requests, advances recurring schedules and clears once schedules",
    () =>
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
          yield* store.put({ ...scheduled, updatedAt: "2026-11-08T00:00:00.000Z" });
          const event = fire(value, `${type}:${now}`);
          const next = "2026-11-07T00:01:00.000Z";
          const results = yield* Effect.all([store.fire(event, next), store.fire(event, next)], {
            concurrency: "unbounded",
          });
          assert.deepStrictEqual(results.sort(), ["duplicate", "fired"]);
          const after = yield* store.get(orgA, value.id);
          assert.strictEqual(after?.nextRunAt, type === "once" ? null : next);
          assert.strictEqual(after?.lastFireId, event.fireId);
          assert.strictEqual(after?.updatedAt, "2026-11-08T00:00:00.000Z");
          assert.isDefined(after);
          const untrusted = { ...after!, lastFireId: decodeFireId("unknown") };
          yield* store.put(untrusted);
          assert.deepStrictEqual(yield* store.get(orgA, value.id), after);
          assert.strictEqual(yield* store.fire(event, "2026-11-08T00:00:00.000Z"), "duplicate");
          assert.deepStrictEqual(yield* store.get(orgA, value.id), after);
          yield* store.put(scheduled);
          assert.strictEqual(yield* store.fire(event, next), "duplicate");
          assert.isFalse((yield* store.listDue(now, 100)).some((row) => row.id === value.id));
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(store.fire({ ...event, fireId: decodeFireId("arbitrary") }, next)),
            ),
          );
          yield* store.put({ ...scheduled, orgId: orgB });
          assert.strictEqual(yield* store.fire({ ...event, orgId: orgB }, next), "fired");
        }
        assert.lengthOf(yield* inbox.listPending(orgA), 2);
        assert.deepStrictEqual(
          yield* sql`SELECT org_id, fired_at FROM kin_trigger_fires ORDER BY fire_id, org_id`,
          [
            { org_id: orgA, fired_at: now },
            { org_id: orgB, fired_at: now },
            { org_id: orgA, fired_at: now },
            { org_id: orgB, fired_at: now },
          ],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT org_id, received_at FROM kin_trigger_inbox ORDER BY fire_id, org_id`,
          [
            { org_id: orgA, received_at: now },
            { org_id: orgB, received_at: now },
            { org_id: orgA, received_at: now },
            { org_id: orgB, received_at: now },
          ],
        );
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
        sql`CREATE TRIGGER reject_fire BEFORE INSERT ON kin_trigger_fires BEGIN
          INSERT INTO kin_trigger_fires (org_id, fire_id, fired_at) VALUES (NEW.org_id, 'invalid', -1); END`,
        sql`CREATE TRIGGER reject_fire BEFORE INSERT ON kin_trigger_fires BEGIN
          INSERT INTO kin_trigger_fires (org_id, fire_id, fired_at) VALUES (NEW.org_id, 'invalid', NULL); END`,
      ]) {
        yield* reject;
        const error = yield* Effect.flip(store.fire(fire(value), null));
        assert.strictEqual(error._tag, "PersistenceSqlError");
        assert.deepStrictEqual(yield* sql`SELECT * FROM kin_trigger_fires`, []);
        assert.deepStrictEqual(yield* store.get(orgA, value.id), value);
        yield* sql`DROP TRIGGER reject_fire`;
      }
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
        for (const payload of [
          { kind: "github", sourceId: "source", scheduledTaskId: "task", deliveryId: "delivery" },
          { kind: "time", triggerId: "different", subject: value.subject },
        ]) {
          yield* sql`INSERT INTO kin_trigger_inbox (org_id, fire_id, payload_json, received_at)
            VALUES (${orgA}, ${fire(value).fireId}, ${JSON.stringify({ ...fire(value), payload })}, ${now})`;
          const result = yield* Effect.flip(store.fire(fire(value), null));
          assert.strictEqual(result._tag, "KinTriggerFireConflict");
          if (result._tag === "KinTriggerFireConflict")
            assert.strictEqual(result.reason, "identity_conflict");
          assert.deepStrictEqual(yield* store.get(orgA, value.id), value);
          yield* sql`DELETE FROM kin_trigger_inbox`;
        }
        const legacy = trigger("gh:org-a:delivery");
        yield* sql`UPDATE kin_triggers SET trigger_id = ${legacy.id} WHERE org_id = ${orgA}`;
        const collision = fire(legacy, `${legacy.id}:${now}`);
        const inbox = yield* KinTriggerInbox.KinTriggerInbox;
        yield* inbox.put(
          decodeFire({
            ...collision,
            payload: {
              kind: "github",
              sourceId: "source",
              scheduledTaskId: "task",
              deliveryId: `delivery:${now}`,
            },
          }),
          now,
        );
        const conflict = yield* Effect.flip(store.fire(collision, null));
        assert.strictEqual(conflict._tag, "KinTriggerFireConflict");
        if (conflict._tag === "KinTriggerFireConflict")
          assert.strictEqual(conflict.reason, "identity_conflict");
        assert.deepStrictEqual(yield* store.get(orgA, legacy.id), legacy);
        yield* sql`DELETE FROM kin_trigger_inbox`;
        yield* sql`UPDATE kin_triggers SET trigger_id = ${value.id} WHERE org_id = ${orgA}`;
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
        for (const next of [timestamp, "2026-11-06T00:00:00.000Z"]) {
          const error = yield* Effect.flip(store.fire(fire(value), next));
          assert.isTrue(isFireConflict(error));
        }
        const invalidNext = yield* Effect.flip(store.fire(fire(value), "not-a-date"));
        assert.strictEqual(invalidNext._tag, "PersistenceDecodeError");
        yield* store.put({ ...value, enabled: false });
        assert.isTrue(isFireConflict(yield* Effect.flip(store.fire(fire(value), null))));
        assert.deepStrictEqual(yield* sql`SELECT * FROM kin_trigger_fires`, []);
        assert.deepStrictEqual(yield* sql`SELECT * FROM kin_trigger_inbox`, []);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("prunes fires after 30 days while pending inbox rows still deduplicate", () =>
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
      assert.strictEqual(yield* store.fire(event, "2026-11-07T00:01:00.000Z"), "duplicate");
      assert.isNull((yield* store.get(orgA, value.id))?.nextRunAt);
      const inbox = yield* KinTriggerInbox.KinTriggerInbox;
      yield* inbox.markConsumed(orgA, [event.fireId]);
      assert.strictEqual(yield* inbox.pruneConsumed(now + retention + 1), 1);
      assert.deepStrictEqual(yield* sql`SELECT * FROM kin_trigger_inbox`, []);
      assert.isTrue(
        isFireConflict(yield* Effect.flip(store.fire(event, "2026-11-07T00:01:00.000Z"))),
      );
      assert.deepStrictEqual(yield* sql`SELECT fire_id FROM kin_trigger_fires`, [
        { fire_id: "newer" },
      ]);
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
        yield* sql`
          INSERT INTO kin_webhook_sources (source_id, org_id, repo, scheduled_task_id, inbox_thread_id, github_hook_id, bot_login, status)
          VALUES (${source.id}, ${orgB}, ${source.repo}, 'other-task', ${source.inboxThreadId}, NULL, ${source.botLogin}, ${source.status})
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
        assert.deepStrictEqual(
          yield* sql`SELECT org_id FROM kin_webhook_sources ORDER BY org_id, source_id`,
          [{ org_id: orgA }, { org_id: orgB }],
        );
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

import { assert, describe, it } from "@effect/vitest";
import { KinOrgId, KinTriggerFired } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";

const database = KinPersistence.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const layer = KinTriggerInbox.layer.pipe(Layer.provideMerge(database));
const orgA = Schema.decodeSync(KinOrgId)("org-a");
const orgB = Schema.decodeSync(KinOrgId)("org-b");
const timestamp = "2026-11-07T00:00:00.000Z";

const decodeFire = Schema.decodeUnknownSync(KinTriggerFired);

function event(deliveryId: string, orgId = orgA) {
  return decodeFire({
    fireId: `gh:${orgId}:${deliveryId}`,
    orgId,
    dueAt: timestamp,
    firedAt: timestamp,
    lateByMs: 0,
    payload: {
      kind: "github",
      sourceId: "source",
      scheduledTaskId: `task-${orgId}`,
      deliveryId,
    },
  });
}

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  for (const org of [orgA, orgB]) {
    yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${org}, 'Kin', ${timestamp})`;
    yield* sql`INSERT INTO kin_webhook_sources
      (source_id, org_id, repo, scheduled_task_id, inbox_thread_id, github_hook_id, bot_login, status)
      VALUES ('source', ${org}, 'org/repo', ${`task-${org}`}, 'inbox', NULL, 'kin', 'active')`;
  }
});

describe("KinTriggerInbox", () => {
  it.effect("deduplicates per org and replays pending rows until consumption commits", () =>
    Effect.gen(function* () {
      yield* seed;
      const inbox = yield* KinTriggerInbox.KinTriggerInbox;
      const sql = yield* SqlClient.SqlClient;
      const a = event("a");
      const b = event("b");
      const other = event("a", orgB);
      assert.isTrue(yield* inbox.put(b, 20));
      assert.isTrue(yield* inbox.put(a, 10));
      assert.isTrue(yield* inbox.put(other, 0));
      assert.isFalse(yield* inbox.put(a, 0));
      assert.deepStrictEqual(yield* inbox.listPending(orgA, 1), [a]);
      assert.deepStrictEqual(yield* inbox.listPending(orgA), [a, b]);
      assert.deepStrictEqual(yield* inbox.listPending(orgA), [a, b]);
      assert.deepStrictEqual(yield* inbox.listPending(orgB), [other]);
      const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
        SELECT payload_json FROM kin_trigger_inbox
        WHERE org_id = ${orgA} AND consumed_at IS NULL ORDER BY received_at, fire_id LIMIT 100`;
      assert.isTrue(plan.some((row) => row.detail.includes("idx_kin_trigger_inbox_pending")));
      assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
      yield* sql`CREATE TRIGGER reject_consume BEFORE UPDATE OF consumed_at ON kin_trigger_inbox
        WHEN NEW.fire_id = 'gh:org-a:b' BEGIN SELECT RAISE(ABORT, 'unavailable'); END`;
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(inbox.markConsumed(orgA, [a.fireId, b.fireId]))),
      );
      assert.deepStrictEqual(yield* inbox.listPending(orgA), [a, b]);
      yield* sql`DROP TRIGGER reject_consume`;
      yield* inbox.markConsumed(orgA, [a.fireId, b.fireId]);
      yield* inbox.markConsumed(orgA, [a.fireId]);
      assert.deepStrictEqual(yield* inbox.listPending(orgA), []);
      assert.deepStrictEqual(yield* inbox.listPending(orgB), [other]);
      assert.isFalse(yield* inbox.put(a, 100));
      const consumed = yield* sql<{
        consumed_at: number;
      }>`SELECT consumed_at FROM kin_trigger_inbox WHERE org_id = ${orgA}`;
      const at = consumed[0]!.consumed_at;
      const retention = 7 * 24 * 60 * 60 * 1000;
      assert.strictEqual(yield* inbox.pruneConsumed(at + retention), 0);
      assert.strictEqual(yield* inbox.pruneConsumed(at + retention + 1), 2);
      assert.deepStrictEqual(yield* inbox.listPending(orgB), [other]);
      const cleanupPlan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
        DELETE FROM kin_trigger_inbox WHERE consumed_at < ${at}`;
      assert.isTrue(
        cleanupPlan.some((row) => row.detail.includes("idx_kin_trigger_inbox_retention")),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects invalid numbers and SQL constraints rather than reporting duplicates", () =>
    Effect.gen(function* () {
      yield* seed;
      const inbox = yield* KinTriggerInbox.KinTriggerInbox;
      const sql = yield* SqlClient.SqlClient;
      const a = event("a");
      assert.isTrue(yield* inbox.put(a, 0));
      for (const [candidate, reason] of [
        [{ ...a, fireId: decodeFire({ ...a, fireId: "bogus" }).fireId }, "invalid_fire_id"],
        [{ ...a, fireId: event("a", orgB).fireId }, "invalid_fire_id"],
        [
          {
            ...a,
            payload: {
              kind: "time",
              triggerId: "trigger",
              subject: { type: "reminder", itemId: "item" },
            },
          },
          "identity_conflict",
        ],
        [
          {
            ...a,
            payload: {
              ...a.payload,
              kind: "github",
              sourceId: "source",
              scheduledTaskId: "task",
              deliveryId: "different",
            },
          },
          "identity_conflict",
        ],
        [
          {
            ...event("time"),
            payload: {
              kind: "time",
              triggerId: "trigger",
              subject: { type: "reminder", itemId: "item" },
            },
          },
          "not_github",
        ],
      ]) {
        const error = yield* Effect.flip(inbox.put(decodeFire(candidate), 0));
        assert.strictEqual(error._tag, "KinTriggerInboxConflict");
        assert.isTrue("reason" in error);
        if ("reason" in error) assert.strictEqual(error.reason, reason);
      }
      for (const payload of [
        { sourceId: "unknown", scheduledTaskId: "task-org-a" },
        { sourceId: "source", scheduledTaskId: "unknown" },
        { sourceId: "source", scheduledTaskId: "task-org-b" },
      ]) {
        const candidate = decodeFire({
          ...event("new"),
          payload: { ...event("new").payload, ...payload },
        });
        const error = yield* Effect.flip(inbox.put(candidate, 0));
        assert.strictEqual(error._tag, "KinTriggerInboxConflict");
        if ("reason" in error) assert.strictEqual(error.reason, "unknown_source");
      }
      const source = event("delivery:x");
      const recheck = (fireId: string, sourceFireId: string = source.fireId) =>
        decodeFire({
          ...source,
          fireId,
          payload: { kind: "github_recheck", repo: null, reason: "repo_unknown", sourceFireId },
        });
      const recheckId = KinTriggerInbox.recheckFireId(orgA, source.fireId);
      for (const [candidate, reason] of [
        [recheck(recheckId), "unknown_source"],
        [recheck(`${source.fireId}:recheck`), "invalid_fire_id"],
        [recheck(recheckId, event("delivery:x", orgB).fireId), "invalid_fire_id"],
      ] as const) {
        const error = yield* Effect.flip(inbox.put(candidate, 0));
        if ("reason" in error) assert.strictEqual(error.reason, reason);
      }
      assert.isTrue(yield* inbox.put(source, 0));
      assert.isTrue(yield* inbox.put(recheck(recheckId), 0));
      assert.isFalse(yield* inbox.put(recheck(recheckId), 0));
      assert.deepStrictEqual(yield* inbox.listPending(orgA, 100, undefined, ["github_recheck"]), [
        recheck(recheckId),
      ]);
      yield* sql`DELETE FROM kin_trigger_inbox WHERE org_id = ${orgA}`;
      for (const invalid of [NaN, 1.5, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(inbox.put(a, invalid))));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(inbox.pruneConsumed(invalid))));
      }
      assert.isTrue(Exit.isFailure(yield* Effect.exit(inbox.listPending(orgA, -1))));
      for (const invalid of [
        "1",
        "2026-11-07",
        "Nov 7 2026",
        "2026-11-07 00:00",
        "2026-11-07T00:00:00",
      ]) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(inbox.put({ ...a, dueAt: invalid }, 0))));
      }
      for (const query of [
        sql`CREATE TRIGGER reject_inbox BEFORE INSERT ON kin_trigger_inbox BEGIN
          INSERT INTO kin_trigger_inbox (org_id, fire_id, payload_json, received_at)
          VALUES (NEW.org_id, 'invalid', '{}', -1); END`,
        sql`CREATE TRIGGER reject_inbox BEFORE INSERT ON kin_trigger_inbox BEGIN
          INSERT INTO kin_trigger_inbox (org_id, fire_id, payload_json, received_at)
          VALUES (NEW.org_id, 'invalid', NULL, 0); END`,
      ]) {
        yield* query;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(inbox.put(a, 0))));
        assert.deepStrictEqual(yield* inbox.listPending(orgA), []);
        yield* sql`DROP TRIGGER reject_inbox`;
      }
    }).pipe(Effect.provide(layer)),
  );
});

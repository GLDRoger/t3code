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

const decodeFire = Schema.decodeSync(KinTriggerFired);

function event(fireId: string, orgId = orgA) {
  return decodeFire({
    fireId,
    orgId,
    dueAt: timestamp,
    firedAt: timestamp,
    lateByMs: 0,
    payload: {
      kind: "github",
      sourceId: "source",
      scheduledTaskId: "task",
      deliveryId: "delivery",
    },
  });
}

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  for (const org of [orgA, orgB]) {
    yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${org}, 'Kin', ${timestamp})`;
  }
});

describe("KinTriggerInbox", () => {
  it.effect(
    "deduplicates puts, claims in receipt order and isolates orgs across consume and recovery",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const inbox = yield* KinTriggerInbox.KinTriggerInbox;
        const sql = yield* SqlClient.SqlClient;
        const a = event("a");
        const b = event("b");
        const c = event("c");
        const other = event("other", orgB);
        assert.isTrue(yield* inbox.put(c, 30));
        assert.isTrue(yield* inbox.put(b, 10));
        assert.isTrue(yield* inbox.put(a, 10));
        assert.isTrue(yield* inbox.put(other, 0));
        assert.isFalse(yield* inbox.put({ ...a, lateByMs: 100 }, 0));
        assert.deepStrictEqual(yield* inbox.list(orgA), [a, b, c]);
        assert.deepStrictEqual(yield* inbox.list(orgB), [other]);
        assert.isFalse(yield* inbox.consume(orgA, a.fireId, 40));
        assert.deepStrictEqual(yield* inbox.claim(orgA, 40, 2), [a, b]);
        assert.deepStrictEqual(yield* inbox.claim(orgA, 41), [c]);
        assert.deepStrictEqual(yield* inbox.claim(orgA, 42), []);
        assert.isFalse(yield* inbox.consume(orgB, a.fireId, 50));
        assert.isTrue(yield* inbox.consume(orgA, a.fireId, 50));
        assert.isFalse(yield* inbox.consume(orgA, a.fireId, 51));
        assert.deepStrictEqual(yield* inbox.claim(orgB, 60), [other]);
        yield* inbox.requeue(orgA);
        assert.deepStrictEqual(yield* inbox.list(orgA), [b, c]);
        assert.deepStrictEqual(yield* inbox.list(orgB), []);
        assert.deepStrictEqual(yield* inbox.claim(orgB, 61), []);
        const claims = yield* Effect.all([inbox.claim(orgA, 70, 1), inbox.claim(orgA, 70, 1)], {
          concurrency: "unbounded",
        });
        assert.deepStrictEqual(
          claims
            .flat()
            .map((row) => String(row.fireId))
            .sort(),
          ["b", "c"],
        );
        assert.deepStrictEqual(
          yield* sql`
      SELECT fire_id, org_id, received_at, claimed_at, consumed_at FROM kin_trigger_inbox ORDER BY fire_id
    `,
          [
            { fire_id: "a", org_id: orgA, received_at: 10, claimed_at: 40, consumed_at: 50 },
            { fire_id: "b", org_id: orgA, received_at: 10, claimed_at: 70, consumed_at: null },
            { fire_id: "c", org_id: orgA, received_at: 30, claimed_at: 70, consumed_at: null },
            { fire_id: "other", org_id: orgB, received_at: 0, claimed_at: 60, consumed_at: null },
          ],
        );
        assert.isFalse(yield* inbox.put(a, 80));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(inbox.claim(orgA, 90, -1))));
      }).pipe(Effect.provide(layer)),
  );

  it.effect("rolls back every claim in the batch when an update fails", () =>
    Effect.gen(function* () {
      yield* seed;
      const inbox = yield* KinTriggerInbox.KinTriggerInbox;
      const sql = yield* SqlClient.SqlClient;
      const a = event("a");
      const b = event("b");
      yield* inbox.put(a, 1);
      yield* inbox.put(b, 2);
      yield* sql`
      CREATE TRIGGER reject_claim BEFORE UPDATE OF claimed_at ON kin_trigger_inbox
      WHEN NEW.fire_id = 'b'
      BEGIN SELECT RAISE(ABORT, 'claim unavailable'); END
    `;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(inbox.claim(orgA, 10))));
      assert.deepStrictEqual(yield* inbox.list(orgA), [a, b]);
      assert.deepStrictEqual(yield* sql`SELECT claimed_at FROM kin_trigger_inbox`, [
        { claimed_at: null },
        { claimed_at: null },
      ]);
    }).pipe(Effect.provide(layer)),
  );
});

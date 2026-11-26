import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { lastCompleteWeek, weekMeasure } from "./weekMeasure.ts";
import {
  from,
  measureLayer,
  mondayMorning,
  orgId,
  seedCompany,
  seedMeasuredWeek,
  until,
  zone,
} from "./weekMeasure.testkit.ts";

it.effect(
  "counts a helper’s result as asked and each timed commitment once in a company week that crosses DST",
  () =>
    Effect.gen(function* () {
      yield* seedCompany;
      yield* seedMeasuredWeek;
      const window = yield* lastCompleteWeek(orgId, mondayMorning);
      assert.deepStrictEqual(window, { from, until, zone });
      const counts = yield* weekMeasure({ orgId, ...window });
      assert.deepStrictEqual(counts, {
        unasked: 5,
        withCard: 4,
        acted: 1,
        changed: 1,
        dismissed: 1,
        left: 1,
        asked: 2,
        askedCorrected: 1,
        due: 3,
        kept: 1,
        late: 1,
        missed: 1,
      });
      assert.strictEqual(
        counts.acted + counts.changed + counts.dismissed + counts.left,
        counts.withCard,
      );
      const sql = yield* SqlClient.SqlClient;
      const end = DateTime.formatIso(DateTime.makeUnsafe(until));
      yield* sql`UPDATE kin_widgets SET state_json = json_set(state_json, '$.answer',
        json_object('optionId', 'yes', 'personId', 'rhea', 'answeredAt', ${end}))
      WHERE org_id = ${orgId} AND widget_id = 'widget-open'`;
      yield* sql`UPDATE kin_deferral_runs SET state = 'started', updated_at = ${until}
      WHERE org_id = ${orgId} AND item_id = 'missed'`;
      assert.deepStrictEqual(yield* weekMeasure({ orgId, ...window }), counts);
    }).pipe(Effect.provide(measureLayer)),
);

it.effect("a follow-up skipped for a held record is not counted as missed", () =>
  Effect.gen(function* () {
    yield* seedCompany;
    yield* seedMeasuredWeek;
    const sql = yield* SqlClient.SqlClient;
    const dueAt = from + 60 * 60_000;
    yield* sql`INSERT INTO kin_deferral_runs
      (org_id, item_id, state, due_at, on_due, snapshot_json, updated_at)
      VALUES (${orgId}, 'set-aside', 'undone', ${dueAt}, 'remind',
        json_object('skipped', json_object('record', 'INV-12', 'at', ${dueAt})), ${dueAt})`;
    const counts = yield* weekMeasure({ orgId, from, until, zone });
    assert.equal(counts.missed, 1);
    assert.equal(counts.due, 3);
  }).pipe(Effect.provide(measureLayer)),
);

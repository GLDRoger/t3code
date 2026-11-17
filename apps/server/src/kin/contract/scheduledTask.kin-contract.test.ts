import { assert, it } from "@effect/vitest";
import { ScheduledTaskUpsertSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { nextScheduledRunAt } from "../../scheduledTasks/Schedule.ts";
import { webhookInput, withScheduledTasks } from "./fixtures.ts";

it("pins the positional schedule members Kin reuses", () => {
  const [interval, fixedTime, once] = ScheduledTaskUpsertSchedule.members;
  const intervalShape = { type: "interval", everyMs: 60_000 };
  const fixedTimeShape = { type: "fixed_time", timeOfDay: "03:00" };
  const onceShape = { type: "once", runAt: "2026-11-08T00:00:00.000Z" };
  assert.deepEqual(Schema.decodeUnknownSync(interval)(intervalShape), intervalShape);
  assert.deepEqual(Schema.decodeUnknownSync(fixedTime)(fixedTimeShape), fixedTimeShape);
  assert.deepEqual(Schema.decodeUnknownSync(once)(onceShape), onceShape);
});

it.each([
  ["Asia/Kolkata", "2026-03-07T20:00:00Z", "2026-03-07T21:30:00.000Z"],
  ["America/New_York", "2026-03-07T17:00:00Z", "2026-03-08T07:00:00.000Z"],
  ["America/New_York", "2026-10-31T16:00:00Z", "2026-11-01T08:00:00.000Z"],
])("keeps 03:00 wall time in %s from %s", (timeZone, instant, expected) => {
  const from = DateTime.makeZonedUnsafe(instant, { timeZone });
  const next = nextScheduledRunAt({ type: "fixed_time", timeOfDay: "03:00" }, from);
  if (next === null) return assert.fail("No next run");
  assert.equal(DateTime.toParts(next).hour, 3);
  assert.equal(DateTime.toParts(next).minute, 0);
  assert.equal(DateTime.formatIso(next), expected);
});

it.effect("preserves the upstream database columns Kin reads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [table, columns] of [
      ["orchestration_v2_projection_runs", ["run_id", "thread_id", "status", "payload_json"]],
      ["orchestration_v2_projection_provider_turns", ["thread_id", "completed_at"]],
    ] as const) {
      const rows = yield* sql`PRAGMA table_info(${sql.literal(table)})`;
      assert.includeMembers(
        rows.map((row) => row.name),
        [...columns],
      );
    }
    const tasks = yield* sql`PRAGMA table_info(scheduled_tasks)`;
    assert.includeMembers(
      tasks.map((row) => row.name),
      [
        "task_id",
        "project_id",
        "thread_id",
        "thread_mode",
        "schedule_json",
        "enabled",
        "last_run_status",
      ],
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("passes scheduledTaskId to sendToThread for bound tasks", () =>
  withScheduledTasks(({ service, sends, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookInput({
          id: "bound-contract",
          threadId: "thread-contract",
          threadMode: "continue",
          schedule: { type: "interval", everyMs: 60_000 },
        }),
      );
      yield* service.runNow({ id: task.id });
      const sent = yield* Queue.take(sends);
      assert.equal(sent.scheduledTaskId, task.id);
      assert.equal(sent.threadId, "thread-contract");
      assert.equal(yield* Queue.size(launches), 0);
    }),
  ).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("names a Kin schedule's task and its time runs from Kin's command id", () =>
  withScheduledTasks(({ service, launches }) =>
    Effect.gen(function* () {
      const { id: _id, ...input } = yield* webhookInput({
        commandId: "kin:schedule:org-contract:sch-contract",
        prompt: "Check the invented report",
        schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5] },
      });
      const { task } = yield* service.upsert(input);
      // The sink and kin_schedules key a schedule by this id; its runs by the command id below.
      assert.equal(task.id, "scheduled-task:kin:schedule:org-contract:sch-contract");
      yield* service.runNow({ id: task.id });
      const launch = yield* Queue.take(launches);
      assert.match(launch.commandId, new RegExp(`^scheduled-task:${task.id}:\\d+:manual$`));
      assert.equal(launch.initialMessage?.scheduledTaskId, task.id);
      assert.equal(launch.initialMessage?.text, "Check the invented report");
      assert.equal(launch.projectId, "project-contract");
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{ prompt: string }>`SELECT prompt FROM scheduled_tasks
        WHERE task_id = ${task.id}`;
      assert.equal(row?.prompt, "Check the invented report");
    }),
  ).pipe(Effect.provide(Sqlite.layerMemory)),
);

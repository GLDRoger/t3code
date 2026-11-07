// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import {
  CanonicalUtcTimestamp,
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { nextScheduledRunAt } from "../../scheduledTasks/Schedule.ts";
import { webhookInput, withScheduledTasks } from "./fixtures.ts";

const decodeSchedule = Schema.decodeSync(ScheduledTaskUpsertSchedule);
const decodeReceivedAt = Schema.decodeUnknownEffect(CanonicalUtcTimestamp);

it("decodes Kin's signed GitHub schedule and preserves the offline delivery limit", () => {
  const schedule = {
    type: "webhook",
    signature: {
      header: "x-hub-signature-256",
      encoding: "hex",
      prefix: "sha256=",
      secret: "contract-secret",
    },
    dedupe: { replayKey: "{{headers.x-github-delivery}}" },
    maxDeliveryAgeMinutes: 1440,
    filters: [{ path: "headers.x-github-event", op: "equals", value: "pull_request" }],
  } satisfies typeof ScheduledTaskUpsertSchedule.Encoded;
  assert.deepEqual(decodeSchedule(schedule), schedule);
  assert.equal(MAX_WEBHOOK_DELIVERY_AGE_MINUTES, 1440);
});

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
    const deliveries = yield* sql`PRAGMA table_info(scheduled_task_webhook_deliveries)`;
    assert.includeMembers(
      tasks.map((row) => row.name),
      ["task_id", "project_id", "thread_id", "thread_mode", "schedule_json"],
    );
    assert.includeMembers(
      deliveries.map((row) => row.name),
      ["task_id", "delivery_id", "received_at"],
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "dispatches signed GitHub deliveries with Kin's provenance, span and replay identity",
  () =>
    withScheduledTasks(({ service, launches, sends, launchDeliveries }) =>
      Effect.gen(function* () {
        const finished = yield* Deferred.make<void>();
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (...args) => {
              end(...args);
              if (span.name === "ScheduledTaskService.runWebhookDelivery")
                Deferred.doneUnsafe(finished, Effect.void);
            };
            return span;
          },
        });
        const { task } = yield* service.upsert(
          yield* webhookInput({
            schedule: {
              type: "webhook",
              signature: {
                header: "x-hub-signature-256",
                encoding: "hex",
                prefix: "sha256=",
                secret: "contract-secret",
              },
              dedupe: { replayKey: "{{headers.x-github-delivery}}" },
            },
          }),
        );
        const bodyText = JSON.stringify({ action: "opened", number: 18 });
        const body = new TextEncoder().encode(bodyText);
        const request = {
          hookId: task.id,
          token: task.webhook?.path.split("/").at(-1) ?? "",
          method: "POST",
          path: `/api/hooks/${task.id}`,
          query: "",
          body,
          bodyText,
          headers: {
            "content-type": "application/json",
            "x-github-event": "pull_request",
            "x-github-delivery": "github-18",
            "x-hub-signature-256": `sha256=${NodeCrypto.createHmac("sha256", "contract-secret").update(body).digest("hex")}`,
          },
        };
        const accepted = yield* service.triggerWebhook(request).pipe(Effect.withTracer(tracer));
        if (accepted._tag !== "accepted") return assert.fail(`Unexpected ${accepted._tag}`);
        yield* Deferred.await(finished);
        const launch = yield* Queue.take(launches);
        const rows = yield* Queue.take(launchDeliveries);
        assert.lengthOf(rows, 1);
        const [row] = rows;
        if (row === undefined) return assert.fail("Delivery missing at launch");
        const receivedAt = yield* decodeReceivedAt(row.receivedAt);
        assert.equal(DateTime.formatIso(receivedAt), row.receivedAt);
        assert.equal(launch.initialMessage?.scheduledTaskId, task.id);
        assert.equal(launch.commandId, `scheduled-task:${task.id}:webhook:${accepted.deliveryId}`);
        const { delivery } = yield* service.getWebhookDelivery({
          id: task.id,
          deliveryId: accepted.deliveryId,
        });
        assert.equal(delivery.headers["x-github-event"], "pull_request");
        assert.equal(delivery.body, bodyText);
        assert.equal(delivery.outcome, "accepted");
        const replay = yield* service.triggerWebhook(request);
        assert.deepInclude(replay, { _tag: "accepted", outcome: "duplicate" });
        assert.equal(yield* Queue.size(launches), 0);
        assert.equal(yield* Queue.size(sends), 0);
      }),
    ).pipe(Effect.provide(Sqlite.layerMemory)),
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

import { KinTrigger, KinTriggerFired, KinTriggerSettings } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";
import { isSameSchedule, nextScheduledRunAt } from "../../scheduledTasks/Schedule.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";

export class KinTriggerScheduler extends Context.Service<
  KinTriggerScheduler,
  {
    readonly runDue: () => Effect.Effect<void>;
    readonly recompute: (
      settings: KinTriggerSettings,
    ) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
  }
>()("t3/kin/triggers/KinTriggerScheduler") {}

function nextRunAt(trigger: KinTrigger, now: number) {
  const next = nextScheduledRunAt(
    trigger.schedule,
    DateTime.makeZonedUnsafe(now, { timeZone: trigger.timeZone }),
  );
  return next === null ? null : DateTime.formatIso(next);
}

function routineSchedule(
  trigger: KinTrigger,
  settings: KinTriggerSettings,
): KinTrigger["schedule"] {
  if (trigger.subject.type !== "routine" || trigger.schedule.type !== "fixed_time")
    return trigger.schedule;
  switch (trigger.subject.routine) {
    case "morning_brief":
      return { type: "fixed_time", timeOfDay: settings.morningBrief };
    case "evening_summary":
      return { type: "fixed_time", timeOfDay: settings.eveningSummary, weekdays: [1, 2, 3, 4, 5] };
    case "dream":
      return { type: "fixed_time", timeOfDay: settings.dream };
    case "dream_full":
      return {
        type: "fixed_time",
        timeOfDay: settings.dream,
        weekdays: [settings.fullRebuildWeekday],
      };
    case "owner_check":
      return {
        type: "fixed_time",
        timeOfDay: settings.ownerCheck,
        weekdays: [settings.ownerCheckWeekday],
      };
  }
}

const decodeFire = Schema.decodeEffect(KinTriggerFired);
const decodeSettings = Schema.decodeEffect(KinTriggerSettings);
const isDecodeError = Schema.is(PersistenceDecodeError);
const isSqlError = Schema.is(PersistenceSqlError);

const make = Effect.gen(function* () {
  const store = yield* KinTriggerStore.KinTriggerStore;
  const scheduler = yield* Scheduler.Scheduler;
  const sql = yield* SqlClient.SqlClient;
  const fire = Effect.fn("KinTriggerScheduler.fire")(function* (trigger: KinTrigger, now: number) {
    if (trigger.nextRunAt === null) return;
    const dueAt = DateTime.toEpochMillis(DateTime.makeUnsafe(trigger.nextRunAt));
    const event = yield* decodeFire({
      fireId: `${trigger.id}:${dueAt}`,
      orgId: trigger.orgId,
      dueAt: trigger.nextRunAt,
      firedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      lateByMs: now - dueAt,
      payload: { kind: "time", triggerId: trigger.id, subject: trigger.subject },
    });
    yield* store.fire(event, (current) =>
      current.schedule.type === "once" ? null : nextRunAt(current, now),
    );
  });
  const runDue = Effect.fn("KinTriggerScheduler.runDue")(
    function* () {
      const now = yield* Clock.currentTimeMillis;
      const limit = 100;
      let after: KinTriggerStore.DueCursor | undefined;
      while (true) {
        const triggers = yield* store.listDue(now, limit, after);
        for (const trigger of triggers) {
          yield* fire(trigger, now).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("Kin trigger fire failed", {
                    orgId: trigger.orgId,
                    triggerId: trigger.id,
                    cause,
                  }),
            ),
          );
        }
        const last = triggers[triggers.length - 1];
        if (triggers.length < limit || last === undefined || last.nextRunAt === null) break;
        after = {
          nextRunAt: DateTime.toEpochMillis(DateTime.makeUnsafe(last.nextRunAt)),
          orgId: last.orgId,
          id: last.id,
        };
      }
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Kin trigger tick failed", { cause }),
    ),
  );
  const recompute = Effect.fn("KinTriggerScheduler.recompute")(function* (
    input: KinTriggerSettings,
  ) {
    const settings = yield* decodeSettings(input).pipe(
      Effect.mapError((cause) =>
        PersistenceDecodeError.fromSchemaError("KinTriggerScheduler.recompute", cause),
      ),
    );
    const timeZone = new Intl.DateTimeFormat("en-US", {
      timeZone: settings.timeZone,
    }).resolvedOptions().timeZone;
    const now = yield* Clock.currentTimeMillis;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const trigger of yield* store.list(settings.orgId)) {
            const updated = {
              ...trigger,
              timeZone,
              schedule: routineSchedule(trigger, settings),
            };
            const next = !updated.enabled
              ? null
              : updated.schedule.type === "interval"
                ? (trigger.nextRunAt ?? nextRunAt(updated, now))
                : updated.schedule.type === "once" ||
                    (trigger.nextRunAt !== null &&
                      DateTime.toEpochMillis(DateTime.makeUnsafe(trigger.nextRunAt)) <= now)
                  ? trigger.nextRunAt
                  : nextRunAt(updated, now);
            if (
              updated.timeZone === trigger.timeZone &&
              isSameSchedule(updated.schedule, trigger.schedule) &&
              next === trigger.nextRunAt
            )
              continue;
            yield* store.put({
              ...updated,
              nextRunAt: next,
              updatedAt: DateTime.formatIso(
                DateTime.makeUnsafe(
                  Math.max(now, DateTime.toEpochMillis(DateTime.makeUnsafe(trigger.updatedAt))),
                ),
              ),
            });
          }
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isDecodeError(cause) || isSqlError(cause)
            ? cause
            : toPersistenceSqlError("KinTriggerScheduler.recompute")(cause),
        ),
      );
  });
  yield* scheduler.register("kin-triggers", runDue());
  return KinTriggerScheduler.of({ runDue, recompute });
});

export const layer = Layer.effect(KinTriggerScheduler, make);

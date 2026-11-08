import {
  KinAgentId,
  KinEvent,
  KinEventId,
  KinLeadRoutine,
  KinOrgId,
  KinTriggerId,
  KinTriggerSettings,
  type KinTrigger,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { nextScheduledRunAt } from "../../scheduledTasks/Schedule.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";
import * as KinTriggerScheduler from "./KinTriggerScheduler.ts";
import * as OwnerCheck from "./ownerCheck.ts";

const routines = ["morning_brief", "evening_summary", "owner_check"] as const;
const iso = (now: number) => DateTime.formatIso(DateTime.makeUnsafe(now));
const decodeSettings = Schema.decodeUnknownEffect(KinTriggerSettings);
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const decodeQuietHours = Schema.decodeUnknownEffect(
  Schema.fromJsonString(KinTriggerSettings.fields.quietHours),
);
const encodeQuietHours = Schema.encodeEffect(
  Schema.fromJsonString(KinTriggerSettings.fields.quietHours),
);
const decodeRoutine = Schema.decodeUnknownEffect(KinLeadRoutine);

export function routineDisposition(
  routine: KinLeadRoutine,
  dueAt: string,
  now: string,
  settings: KinTriggerSettings,
) {
  if (routine === "owner_check") return "post";
  const due = DateTime.makeZonedUnsafe(dueAt, { timeZone: settings.timeZone });
  const [hour = 0, minute = 0] = (
    routine === "morning_brief" ? settings.eveningSummary : settings.dream
  )
    .split(":")
    .map(Number);
  let boundary = DateTime.setParts(due, { hour, minute, second: 0, millisecond: 0 });
  if (
    routine === "evening_summary" &&
    DateTime.toEpochMillis(boundary) <= DateTime.toEpochMillis(due)
  )
    boundary = DateTime.add(boundary, { days: 1 });
  return Date.parse(now) < DateTime.toEpochMillis(boundary) ? "post" : "fold";
}

function schedule(routine: KinLeadRoutine, settings: KinTriggerSettings): KinTrigger["schedule"] {
  switch (routine) {
    case "morning_brief":
      return { type: "fixed_time", timeOfDay: settings.morningBrief };
    case "evening_summary":
      return { type: "fixed_time", timeOfDay: settings.eveningSummary, weekdays: [1, 2, 3, 4, 5] };
    case "owner_check":
      return {
        type: "fixed_time",
        timeOfDay: settings.ownerCheck,
        weekdays: [settings.ownerCheckWeekday],
      };
  }
}

export class KinRoutinesError extends Schema.TaggedError<KinRoutinesError>()("KinRoutinesError", {
  orgId: KinOrgId,
  cause: Schema.Defect(),
}) {}
export class KinRoutines extends Context.Service<
  KinRoutines,
  {
    readonly isEnabled: (
      orgId: KinOrgId,
      routine: KinLeadRoutine,
    ) => Effect.Effect<boolean, KinRoutinesError>;
    readonly configure: (settings: KinTriggerSettings) => Effect.Effect<void, KinRoutinesError>;
    readonly setEnabled: (
      orgId: KinOrgId,
      routine: KinLeadRoutine,
      enabled: boolean,
    ) => Effect.Effect<void, KinRoutinesError>;
    readonly pauseAll: (orgId: KinOrgId) => Effect.Effect<void, KinRoutinesError>;
    readonly resumeAll: (orgId: KinOrgId) => Effect.Effect<void, KinRoutinesError>;
    readonly drain: (orgId: KinOrgId) => Effect.Effect<void, KinRoutinesError>;
  }
>()("t3/kin/triggers/routines/KinRoutines") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* KinTriggerStore.KinTriggerStore;
  const scheduler = yield* KinTriggerScheduler.KinTriggerScheduler;
  const inbox = yield* KinTriggerInbox.KinTriggerInbox;
  const queue = yield* KinEventQueue.KinEventQueue;
  const ownerCheck = yield* OwnerCheck.OwnerCheck;
  const ticks = yield* Scheduler.Scheduler;
  const settingsFor = Effect.fn("KinRoutines.settingsFor")(function* (orgId: KinOrgId) {
    const [row] = yield* sql<{
      time_zone: string;
      morning_brief: string;
      evening_summary: string;
      dream: string;
      full_rebuild_weekday: number;
      owner_check_weekday: number;
      owner_check: string;
      quiet_hours_json: string;
    }>`SELECT * FROM kin_trigger_settings WHERE org_id = ${orgId} ORDER BY org_id`;
    return yield* decodeSettings(
      row === undefined
        ? {
            orgId,
            timeZone: "UTC",
            morningBrief: "08:30",
            eveningSummary: "18:30",
            dream: "03:00",
            fullRebuildWeekday: 0,
            ownerCheckWeekday: 1,
            ownerCheck: "09:00",
            quietHours: { from: "21:00", to: "08:00" },
          }
        : {
            orgId,
            timeZone: row.time_zone,
            morningBrief: row.morning_brief,
            eveningSummary: row.evening_summary,
            dream: row.dream,
            fullRebuildWeekday: row.full_rebuild_weekday,
            ownerCheckWeekday: row.owner_check_weekday,
            ownerCheck: row.owner_check,
            quietHours: yield* decodeQuietHours(row.quiet_hours_json),
          },
    );
  });
  const reconcile = Effect.fn("KinRoutines.reconcile")(function* (settings: KinTriggerSettings) {
    const now = yield* Clock.currentTimeMillis;
    for (const routine of routines) {
      const id = KinTriggerId.make(`routine:${routine}`);
      const existing = yield* store.get(settings.orgId, id);
      yield* sql`INSERT INTO kin_routine_preferences (org_id, routine, enabled) VALUES (${settings.orgId}, ${routine}, ${existing?.enabled === false ? 0 : 1}) ON CONFLICT DO NOTHING RETURNING routine`;
      const [preference] = yield* sql<{
        enabled: number;
        paused: number;
      }>`SELECT enabled, paused FROM kin_routine_preferences WHERE org_id = ${settings.orgId} AND routine = ${routine} ORDER BY routine`;
      const enabled = preference?.enabled === 1 && preference.paused === 0;
      if (existing !== undefined && existing.enabled === enabled) continue;
      const timing = schedule(routine, settings);
      const next = enabled
        ? nextScheduledRunAt(timing, DateTime.makeZonedUnsafe(now, { timeZone: settings.timeZone }))
        : null;
      yield* store.put({
        id,
        orgId: settings.orgId,
        subject: { type: "routine", routine },
        schedule: timing,
        timeZone: settings.timeZone,
        enabled,
        nextRunAt: next === null ? null : DateTime.formatIso(next),
        createdAt: existing?.createdAt ?? iso(now),
        updatedAt: iso(Math.max(now, Date.parse(existing?.updatedAt ?? iso(now)))),
      });
    }
    yield* scheduler.recompute(settings);
  });
  const wrap = <A, E, R>(orgId: KinOrgId, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new KinRoutinesError({ orgId, cause })));
  const configure = Effect.fn("KinRoutines.configure")((input: KinTriggerSettings) =>
    wrap(
      input.orgId,
      sql
        .withTransaction(
          Effect.gen(function* () {
            const settings = yield* decodeSettings(input);
            yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary, dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
      VALUES (${settings.orgId}, ${settings.timeZone}, ${settings.morningBrief}, ${settings.eveningSummary}, ${settings.dream}, ${settings.fullRebuildWeekday}, ${settings.ownerCheckWeekday}, ${settings.ownerCheck}, ${yield* encodeQuietHours(settings.quietHours)})
      ON CONFLICT (org_id) DO UPDATE SET time_zone = excluded.time_zone, morning_brief = excluded.morning_brief, evening_summary = excluded.evening_summary, dream = excluded.dream, full_rebuild_weekday = excluded.full_rebuild_weekday, owner_check_weekday = excluded.owner_check_weekday, owner_check = excluded.owner_check, quiet_hours_json = excluded.quiet_hours_json RETURNING org_id`;
            yield* reconcile(settings);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isSqlError(cause) ? toPersistenceSqlError("KinRoutines.configure")(cause) : cause,
          ),
        ),
    ),
  );
  const toggle = Effect.fn("KinRoutines.toggle")(
    (orgId: KinOrgId, routine: KinLeadRoutine | null, value: boolean) =>
      wrap(
        orgId,
        sql
          .withTransaction(
            Effect.gen(function* () {
              const settings = yield* settingsFor(orgId);
              yield* reconcile(settings);
              if (routine === null)
                yield* sql`UPDATE kin_routine_preferences SET paused = ${value ? 1 : 0} WHERE org_id = ${orgId}`;
              else {
                yield* decodeRoutine(routine);
                yield* sql`UPDATE kin_routine_preferences SET enabled = ${value ? 1 : 0} WHERE org_id = ${orgId} AND routine = ${routine}`;
              }
              yield* reconcile(settings);
              if ((routine === null && value) || (routine !== null && !value)) {
                yield* sql`UPDATE kin_events SET state = 'expired' WHERE org_id = ${orgId} AND tag = 'routine' AND state = 'queued' AND (${routine} IS NULL OR json_extract(json, '$.routine') = ${routine})`;
                if (routine !== null)
                  yield* sql`DELETE FROM kin_routine_folds WHERE org_id = ${orgId} AND routine = ${routine}`;
              }
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              isSqlError(cause) ? toPersistenceSqlError("KinRoutines.toggle")(cause) : cause,
            ),
          ),
      ),
  );
  const drain = Effect.fn("KinRoutines.drain")((orgId: KinOrgId) =>
    wrap(
      orgId,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const pending = yield* inbox.listPending(orgId, 100, routines);
        for (const fire of pending.toSorted(
          (a, b) =>
            Date.parse(a.dueAt) - Date.parse(b.dueAt) ||
            (a.fireId < b.fireId ? -1 : a.fireId > b.fireId ? 1 : 0),
        )) {
          if (fire.payload.kind !== "time" || fire.payload.subject.type !== "routine") continue;
          const name = fire.payload.subject.routine;
          if (name !== "morning_brief" && name !== "evening_summary" && name !== "owner_check")
            continue;

          const items = name === "owner_check" ? yield* ownerCheck.select(orgId) : undefined;
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const settings = yield* settingsFor(orgId);
                const unconsumed =
                  yield* sql`SELECT fire_id FROM kin_trigger_inbox WHERE org_id = ${orgId} AND fire_id = ${fire.fireId} AND consumed_at IS NULL ORDER BY fire_id`;
                if (unconsumed.length === 0) return;
                const [lead] = yield* sql<{
                  agent_id: string;
                }>`SELECT l.agent_id FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id WHERE l.org_id = ${orgId} AND a.retired_at IS NULL ORDER BY l.agent_id LIMIT 1`;
                if (lead === undefined) return;
                const eventId = KinEventId.make(
                  `routine_${Array.from(new TextEncoder().encode(`${orgId.length}:${orgId}${fire.fireId}`), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
                );
                const previous =
                  yield* sql`SELECT event_id FROM kin_events WHERE org_id = ${orgId} AND event_id = ${eventId} ORDER BY event_id`;
                if (previous.length > 0) {
                  yield* inbox.markConsumed(orgId, [fire.fireId]);
                  return;
                }
                const [preference] = yield* sql<{
                  enabled: number;
                  paused: number;
                }>`SELECT enabled, paused FROM kin_routine_preferences WHERE org_id = ${orgId} AND routine = ${name} ORDER BY routine`;
                if (preference?.enabled !== 1 || preference.paused === 1) {
                  yield* inbox.markConsumed(orgId, [fire.fireId]);
                  return;
                }
                if (routineDisposition(name, fire.dueAt, iso(now), settings) === "fold") {
                  const target = name === "morning_brief" ? "evening_summary" : "morning_brief";
                  yield* sql`UPDATE kin_routine_folds SET fold_into = ${target} WHERE org_id = ${orgId} AND fold_into = ${name}`;
                  yield* sql`INSERT INTO kin_routine_folds (org_id, fire_id, routine, due_at, fold_into) VALUES (${orgId}, ${fire.fireId}, ${name}, ${Date.parse(fire.dueAt)}, ${target}) ON CONFLICT DO NOTHING RETURNING fire_id`;
                } else {
                  const folds = yield* sql<{
                    routine: string;
                    due_at: number;
                  }>`SELECT routine, due_at FROM kin_routine_folds WHERE org_id = ${orgId} AND fold_into = ${name} ORDER BY due_at, fire_id`;
                  const event = yield* decodeEvent({
                    _tag: "routine",
                    eventId,
                    orgId,
                    agentId: KinAgentId.make(lead.agent_id),
                    receivedAt: iso(now),
                    provenance: { _tag: "system" },
                    dedupeKey: `routine:${orgId}:${fire.fireId}`,
                    routine: name,
                    dueAt: fire.dueAt,
                    lateByMs: now - Date.parse(fire.dueAt),
                    foldedRoutines: folds.map((fold) => ({
                      routine: fold.routine,
                      dueAt: iso(fold.due_at),
                    })),
                    ...(items === undefined ? {} : { ownerCheckItems: items }),
                  });
                  yield* queue.enqueue(event);
                  yield* sql`DELETE FROM kin_routine_folds WHERE org_id = ${orgId} AND fold_into = ${name}`;
                }
                yield* inbox.markConsumed(orgId, [fire.fireId]);
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                isSqlError(cause) ? toPersistenceSqlError("KinRoutines.drain")(cause) : cause,
              ),
            );
        }
      }),
    ),
  );
  yield* ticks.register(
    "kin-routines",
    Effect.gen(function* () {
      const orgs = yield* sql<{
        org_id: string;
      }>`SELECT org_id FROM kin_leads WHERE org_id IN (SELECT org_id FROM kin_orgs) ORDER BY org_id`;
      for (const row of orgs) {
        const orgId = KinOrgId.make(row.org_id);
        yield* Effect.gen(function* () {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* reconcile(yield* settingsFor(orgId));
            }),
          );
          yield* drain(orgId);
        }).pipe(
          Effect.catch((cause) => Effect.logWarning("Kin routines tick failed", { orgId, cause })),
        );
      }
    }).pipe(Effect.catch((cause) => Effect.logWarning("Kin routines scan failed", { cause }))),
  );
  return KinRoutines.of({
    isEnabled: Effect.fn("KinRoutines.isEnabled")((orgId, routine) =>
      wrap(
        orgId,
        Effect.gen(function* () {
          const [row] = yield* sql<{
            enabled: number;
            paused: number;
          }>`SELECT enabled, paused FROM kin_routine_preferences WHERE org_id = ${orgId} AND routine = ${routine} ORDER BY routine`.pipe(
            Effect.mapError(toPersistenceSqlError("KinRoutines.isEnabled")),
          );
          return row === undefined || (row.enabled === 1 && row.paused === 0);
        }),
      ),
    ),
    configure,
    setEnabled: Effect.fn("KinRoutines.setEnabled")((orgId, routine, enabled) =>
      toggle(orgId, routine, enabled),
    ),
    pauseAll: Effect.fn("KinRoutines.pauseAll")((orgId) => toggle(orgId, null, true)),
    resumeAll: Effect.fn("KinRoutines.resumeAll")((orgId) => toggle(orgId, null, false)),
    drain,
  });
});
export const layer = Layer.effect(KinRoutines, make);

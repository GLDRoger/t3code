import { KinLeadRoutine, KinOrgId, KinTriggerSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as KinTriggerScheduler from "./KinTriggerScheduler.ts";
import { reholdEveryoneAfter } from "./quietHold.ts";
import { KIN_DEFAULT_QUIET_HOURS } from "./quietHours.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { keepAllDayDays } from "../work/allDayZone.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { ownerZone, unsetOwnerZone } from "../work/recordRows.ts";

/**
 * The company's clock and the retired routines' Stop hooks. The morning brief, evening summary
 * and owner check retired (K145): the check-ins (`pulse/checkInSeeds.ts`) carry the briefs.
 */
const decodeSettings = Schema.decodeUnknownEffect(KinTriggerSettings);
const decodeQuietHours = Schema.decodeUnknownEffect(
  Schema.fromJsonString(KinTriggerSettings.fields.quietHours),
);
const encodeQuietHours = Schema.encodeEffect(
  Schema.fromJsonString(KinTriggerSettings.fields.quietHours),
);

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
    /** Keeps the other settings, so an unconfigured org gets the defaults in the new zone. */
    readonly setTimeZone: (
      orgId: KinOrgId,
      timeZone: string,
    ) => Effect.Effect<void, KinRoutinesError>;
    readonly pauseAll: (orgId: KinOrgId) => Effect.Effect<void, KinRoutinesError>;
    readonly resumeAll: (orgId: KinOrgId) => Effect.Effect<void, KinRoutinesError>;
  }
>()("t3/kin/triggers/routines/KinRoutines") {}

const isRoutinesError = Schema.is(KinRoutinesError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const refresh = yield* KinRefreshObserver;
  const scheduler = yield* KinTriggerScheduler.KinTriggerScheduler;
  // Open Work screens read again once all-day days moved with the zone.
  const records = yield* Effect.serviceOption(KinRecords);
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
            timeZone: unsetOwnerZone(),
            morningBrief: "08:30",
            eveningSummary: "18:30",
            dream: "03:00",
            fullRebuildWeekday: 0,
            ownerCheckWeekday: 1,
            ownerCheck: "09:00",
            quietHours: KIN_DEFAULT_QUIET_HOURS,
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
  const wrap = <A, E, R>(orgId: KinOrgId, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new KinRoutinesError({ orgId, cause })));
  const configure = Effect.fn("KinRoutines.configure")((input: KinTriggerSettings) =>
    wrap(
      input.orgId,
      sql
        .withTransaction(
          Effect.gen(function* () {
            const settings = yield* decodeSettings(input);
            const before = yield* ownerZone(settings.orgId).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
            // Lines already held move with the company's clock, earlier when the new hours allow.
            yield* reholdEveryoneAfter(
              settings.orgId,
              sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary, dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
      VALUES (${settings.orgId}, ${settings.timeZone}, ${settings.morningBrief}, ${settings.eveningSummary}, ${settings.dream}, ${settings.fullRebuildWeekday}, ${settings.ownerCheckWeekday}, ${settings.ownerCheck}, ${yield* encodeQuietHours(settings.quietHours)})
      ON CONFLICT (org_id) DO UPDATE SET time_zone = excluded.time_zone, morning_brief = excluded.morning_brief, evening_summary = excluded.evening_summary, dream = excluded.dream, full_rebuild_weekday = excluded.full_rebuild_weekday, owner_check_weekday = excluded.owner_check_weekday, owner_check = excluded.owner_check, quiet_hours_json = excluded.quiet_hours_json RETURNING org_id`,
            ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
            // A day is a calendar day: each all-day date keeps its day in the new zone.
            const moved = yield* keepAllDayDays(settings.orgId, before, settings.timeZone).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
            if (moved > 0 && Option.isSome(records))
              yield* sql.afterCommit(
                records.value
                  .announce(settings.orgId)
                  .pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("Kin work refresh after a zone change failed", { cause }),
                    ),
                  ),
              );
            yield* refresh.touch(settings.orgId, "timeZone");
            // keepAllDayDays renamed due-keyed pulse facts and moved statements' undo days.
            if (before !== settings.timeZone) {
              yield* refresh.touch(settings.orgId, "pulse");
              yield* refresh.touch(settings.orgId, "moneyStatements");
            }
            yield* scheduler.recompute(settings);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isSqlError(cause) ? toPersistenceSqlError("KinRoutines.configure")(cause) : cause,
          ),
        ),
    ),
  );
  const setTimeZone = Effect.fn("KinRoutines.setTimeZone")((orgId: KinOrgId, timeZone: string) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const settings = yield* settingsFor(orgId);
          yield* configure({ ...settings, timeZone });
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isRoutinesError(cause) ? cause : new KinRoutinesError({ orgId, cause }),
        ),
      ),
  );
  const pause = Effect.fn("KinRoutines.pause")((orgId: KinOrgId, paused: boolean) =>
    wrap(
      orgId,
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE kin_routine_preferences SET paused = ${paused ? 1 : 0} WHERE org_id = ${orgId}`;
            if (paused)
              yield* sql`UPDATE kin_events SET state = 'expired' WHERE org_id = ${orgId} AND tag = 'routine' AND state = 'queued'`;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isSqlError(cause) ? toPersistenceSqlError("KinRoutines.pause")(cause) : cause,
          ),
        ),
    ),
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
          return row !== undefined && row.enabled === 1 && row.paused === 0;
        }),
      ),
    ),
    configure,
    setTimeZone,
    pauseAll: Effect.fn("KinRoutines.pauseAll")((orgId) => pause(orgId, true)),
    resumeAll: Effect.fn("KinRoutines.resumeAll")((orgId) => pause(orgId, false)),
  });
});
export const layer = Layer.effect(KinRoutines, make);

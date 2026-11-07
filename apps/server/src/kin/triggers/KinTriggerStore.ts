import {
  CanonicalUtcTimestamp,
  NonNegativeInt,
  KinOrgId,
  KinTrigger,
  KinTriggerFired,
  KinTriggerId,
  KinTriggerSchedule,
  KinTriggerSubject,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";

export class KinTriggerFireConflict extends Schema.TaggedError<KinTriggerFireConflict>()(
  "KinTriggerFireConflict",
  {
    orgId: KinOrgId,
    reason: Schema.Literals(["not_time", "not_due", "inbox_not_inserted", "invalid_fire_id"]),
  },
) {}

type StoreError = PersistenceSqlError | PersistenceDecodeError;
const TriggerRow = Schema.Struct({
  ...KinTrigger.fields,
  subject: Schema.fromJsonString(KinTriggerSubject),
  schedule: Schema.fromJsonString(KinTriggerSchedule),
  enabled: Schema.Literals([0, 1]),
  nextRunAt: Schema.NullOr(Schema.DateTimeUtcFromMillis),
  createdAt: Schema.DateTimeUtcFromMillis,
  updatedAt: Schema.DateTimeUtcFromMillis,
});
const Scope = Schema.Struct({ orgId: KinOrgId, id: KinTriggerId });

export class KinTriggerStore extends Context.Service<
  KinTriggerStore,
  {
    readonly put: (trigger: KinTrigger) => Effect.Effect<void, StoreError>;
    readonly get: (
      orgId: KinOrgId,
      id: KinTriggerId,
    ) => Effect.Effect<KinTrigger | undefined, StoreError>;
    readonly list: (orgId: KinOrgId) => Effect.Effect<ReadonlyArray<KinTrigger>, StoreError>;
    readonly delete: (orgId: KinOrgId, id: KinTriggerId) => Effect.Effect<void, StoreError>;
    readonly listDue: (
      now: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<KinTrigger>, StoreError>;
    readonly fire: (
      event: KinTriggerFired,
      nextRunAt: KinTrigger["nextRunAt"],
    ) => Effect.Effect<"fired" | "duplicate", StoreError | KinTriggerFireConflict>;
    readonly pruneFires: (now: number) => Effect.Effect<number, StoreError>;
  }
>()("t3/kin/triggers/KinTriggerStore") {}

const decodeTime = Schema.decodeEffect(CanonicalUtcTimestamp);
const decodeMillis = Schema.decodeEffect(NonNegativeInt);
const decodeLimit = Schema.decodeEffect(Schema.Int.check(Schema.isGreaterThan(0)));
const epoch = (value: string) =>
  decodeTime(value).pipe(Effect.map(DateTime.toEpochMillis), Effect.flatMap(decodeMillis));

const decodeRow = Schema.decodeUnknownEffect(TriggerRow);
const decodeTrigger = Schema.decodeEffect(KinTrigger);
const decodeFire = Schema.decodeEffect(KinTriggerFired);
const decodeNextRunAt = Schema.decodeEffect(KinTrigger.fields.nextRunAt);
const encodeSubject = Schema.encodeEffect(Schema.fromJsonString(KinTriggerSubject));
const encodeSchedule = Schema.encodeEffect(Schema.fromJsonString(KinTriggerSchedule));
const isFireConflict = Schema.is(KinTriggerFireConflict);
const isSqlError = Schema.is(PersistenceSqlError);
const isDecodeError = Schema.is(PersistenceDecodeError);

function toPersistenceOrDecodeError(operation: string) {
  return (cause: unknown): StoreError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : toPersistenceSqlError(operation)(cause);
}

function toStoreError(cause: unknown) {
  if (isFireConflict(cause) || isSqlError(cause) || isDecodeError(cause)) return cause;
  return toPersistenceOrDecodeError("KinTriggerStore.fire")(cause);
}

const decodeRows = Effect.fn("KinTriggerStore.decodeRows")(function* (
  rows: ReadonlyArray<typeof TriggerRow.Type>,
) {
  return yield* Effect.forEach(rows, (row) =>
    decodeTrigger({
      ...row,
      enabled: row.enabled === 1,
      nextRunAt: row.nextRunAt === null ? null : DateTime.formatIso(row.nextRunAt),
      createdAt: DateTime.formatIso(row.createdAt),
      updatedAt: DateTime.formatIso(row.updatedAt),
    }),
  );
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const inbox = yield* KinTriggerInbox.KinTriggerInbox;
  const columns = sql`
    trigger_id AS id, org_id AS "orgId", subject_json AS subject, schedule_json AS schedule,
    time_zone AS "timeZone", enabled, next_run_at AS "nextRunAt", last_fire_id AS "lastFireId",
    created_at AS "createdAt", updated_at AS "updatedAt"
  `;
  const getRows = SqlSchema.findAll({
    Request: Scope,
    Result: TriggerRow,
    execute: ({ orgId, id }) => sql`
      SELECT ${columns} FROM kin_triggers WHERE org_id = ${orgId} AND trigger_id = ${id}
    `,
  });
  const listRows = SqlSchema.findAll({
    Request: KinOrgId,
    Result: TriggerRow,
    execute: (orgId) => sql`
      SELECT ${columns} FROM kin_triggers WHERE org_id = ${orgId} ORDER BY trigger_id
    `,
  });
  return KinTriggerStore.of({
    put: Effect.fn("KinTriggerStore.put")(
      function* (trigger) {
        const value = yield* decodeTrigger(trigger);
        const subject = yield* encodeSubject(value.subject);
        const schedule = yield* encodeSchedule(value.schedule);
        const nextRunAt = value.nextRunAt === null ? null : yield* epoch(value.nextRunAt);
        const createdAt = yield* epoch(value.createdAt);
        const updatedAt = yield* epoch(value.updatedAt);
        yield* sql`
        INSERT INTO kin_triggers (
          trigger_id, org_id, subject_json, schedule_json, time_zone, enabled,
          next_run_at, last_fire_id, created_at, updated_at
        ) VALUES (
          ${value.id}, ${value.orgId}, ${subject}, ${schedule}, ${value.timeZone}, ${value.enabled ? 1 : 0},
          ${nextRunAt}, ${value.lastFireId},
          ${createdAt}, ${updatedAt}
        )
        ON CONFLICT (org_id, trigger_id) DO UPDATE SET
          subject_json = excluded.subject_json, schedule_json = excluded.schedule_json,
          time_zone = excluded.time_zone, enabled = excluded.enabled, next_run_at = excluded.next_run_at,
          last_fire_id = excluded.last_fire_id, updated_at = excluded.updated_at
      `;
      },
      Effect.mapError(toPersistenceOrDecodeError("KinTriggerStore.put")),
    ),
    get: Effect.fn("KinTriggerStore.get")(
      function* (orgId, id) {
        return (yield* decodeRows(
          yield* getRows({ orgId, id }).pipe(NodeSqliteClient.readOnly),
        ))[0];
      },
      Effect.mapError(toPersistenceOrDecodeError("KinTriggerStore.get")),
    ),
    list: Effect.fn("KinTriggerStore.list")(
      function* (orgId) {
        return yield* decodeRows(yield* listRows(orgId).pipe(NodeSqliteClient.readOnly));
      },
      Effect.mapError(toPersistenceOrDecodeError("KinTriggerStore.list")),
    ),
    delete: Effect.fn("KinTriggerStore.delete")(
      function* (orgId, id) {
        yield* sql`DELETE FROM kin_triggers WHERE org_id = ${orgId} AND trigger_id = ${id}`;
      },
      Effect.mapError(toPersistenceOrDecodeError("KinTriggerStore.delete")),
    ),
    listDue: Effect.fn("KinTriggerStore.listDue")(
      function* (now, limit) {
        const at = yield* decodeMillis(now);
        const count = yield* decodeLimit(limit);
        // Spans orgs for the scheduler tick; `fire` rechecks the org.
        const rows = yield* sql`
        SELECT ${columns} FROM kin_triggers
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ${at}
        ORDER BY next_run_at, trigger_id LIMIT ${count}
      `.pipe(NodeSqliteClient.readOnly);
        const triggers: KinTrigger[] = [];
        for (const row of rows) {
          const decoded = yield* Effect.result(
            decodeRow(row).pipe(Effect.flatMap((value) => decodeRows([value]))),
          );
          if (Result.isSuccess(decoded)) triggers.push(...decoded.success);
          else
            yield* Effect.logWarning("Skipping undecodable Kin trigger row", {
              cause: decoded.failure,
            });
        }
        return triggers;
      },
      Effect.mapError(toPersistenceOrDecodeError("KinTriggerStore.listDue")),
    ),
    fire: Effect.fn("KinTriggerStore.fire")(function* (event, nextRunAt) {
      const value = yield* decodeFire(event);
      const next = yield* decodeNextRunAt(nextRunAt);
      if (value.payload.kind !== "time") {
        return yield* new KinTriggerFireConflict({ orgId: value.orgId, reason: "not_time" });
      }
      const triggerId = value.payload.triggerId;
      const dueAt = yield* epoch(value.dueAt);
      if (value.fireId !== `${triggerId}:${dueAt}`) {
        return yield* new KinTriggerFireConflict({ orgId: value.orgId, reason: "invalid_fire_id" });
      }
      const firedAt = yield* epoch(value.firedAt);
      const nextAt = next === null ? null : yield* epoch(next);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          // Pending inbox rows deduplicate even after the 30-day fire ledger expires.
          const existing = yield* sql`
            SELECT fire_id FROM kin_trigger_inbox
            WHERE org_id = ${value.orgId} AND fire_id = ${value.fireId}
          `;
          let duplicate = existing.length !== 0;
          if (!duplicate) {
            const inserted = yield* sql`
              INSERT INTO kin_trigger_fires (fire_id, org_id, fired_at)
              VALUES (${value.fireId}, ${value.orgId}, ${firedAt})
              ON CONFLICT (org_id, fire_id) DO NOTHING RETURNING fire_id
            `;
            duplicate = inserted.length === 0;
            if (!duplicate && !(yield* inbox.put(value, firedAt))) {
              return yield* new KinTriggerFireConflict({
                orgId: value.orgId,
                reason: "inbox_not_inserted",
              });
            }
          }
          const updated = yield* sql`
          UPDATE kin_triggers SET
            next_run_at = CASE WHEN json_extract(schedule_json, '$.type') = 'once' THEN NULL
              ELSE ${nextAt} END,
            last_fire_id = ${value.fireId}, updated_at = ${firedAt}
          WHERE org_id = ${value.orgId} AND trigger_id = ${triggerId}
            AND enabled = 1 AND next_run_at = ${dueAt}
          RETURNING trigger_id
        `;
          if (!duplicate && updated.length !== 1) {
            return yield* new KinTriggerFireConflict({ orgId: value.orgId, reason: "not_due" });
          }
          return duplicate ? "duplicate" : "fired";
        }),
      );
    }, Effect.mapError(toStoreError)),
    pruneFires: Effect.fn("KinTriggerStore.pruneFires")(
      function* (now) {
        const at = yield* decodeMillis(now);
        const rows = yield* sql`
        DELETE FROM kin_trigger_fires WHERE fired_at < ${at - 30 * 24 * 60 * 60 * 1000}
        RETURNING fire_id
      `;
        return rows.length;
      },
      Effect.mapError(toPersistenceOrDecodeError("KinTriggerStore.pruneFires")),
    ),
  });
});

export const layer = Layer.effect(KinTriggerStore, make);

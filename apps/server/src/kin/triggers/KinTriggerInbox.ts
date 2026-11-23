import {
  KinOrgId,
  KinRoutine,
  KinTriggerFireId,
  KinTriggerFired,
  NonNegativeInt,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type * as Statement from "effect/sql/Statement";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";
import { scheduleTaskId } from "./kinSchedules.ts";

const encodeFire = Schema.encodeEffect(Schema.fromJsonString(KinTriggerFired));
const decodeMillis = Schema.decodeEffect(NonNegativeInt);
const decodeIds = Schema.decodeEffect(Schema.Array(KinTriggerFireId));
const decodeOrg = Schema.decodeEffect(KinOrgId);
export class KinTriggerInboxConflict extends Schema.TaggedError<KinTriggerInboxConflict>()(
  "KinTriggerInboxConflict",
  {
    orgId: KinOrgId,
    reason: Schema.Literals([
      "not_a_schedule_run",
      "invalid_fire_id",
      "identity_conflict",
      "unknown_source",
    ]),
  },
) {}

type InboxError = PersistenceSqlError | PersistenceDecodeError | KinTriggerInboxConflict;
const isInboxConflict = Schema.is(KinTriggerInboxConflict);
const FireKind = Schema.Literals(["time", "github", "github_recheck"]);
type FireKind = typeof FireKind.Type;
const PendingRequest = Schema.Struct({
  orgId: KinOrgId,
  limit: Schema.Int.check(Schema.isGreaterThan(0)),
  routines: Schema.optional(
    Schema.Union([Schema.Array(KinRoutine), Schema.Literals(["deferral", "scheduled_task"])]),
  ),
  kinds: Schema.optional(Schema.Array(FireKind)),
  after: Schema.optional(KinTriggerFireId),
});

/**
 * A pending fire whose timer retiring an agent held (`Retirement.retire`): it stays in the inbox,
 * unconsumed and unread, until the restore lifts the hold. `inbox` names the inbox row's table.
 */
const retirementHeld = (sql: SqlClient.SqlClient, inbox: Statement.Fragment) =>
  sql`EXISTS (SELECT 1 FROM kin_retirement_holds h WHERE h.org_id = ${inbox}.org_id
    AND h.kind = 'trigger' AND h.target_id = json_extract(${inbox}.payload_json, '$.payload.triggerId'))`;

/** In a consumer's write: the fire is still pending and no retirement holds it. */
export const fireOpen = (sql: SqlClient.SqlClient, orgId: KinOrgId, fireId: KinTriggerFireId) =>
  sql`SELECT fire_id FROM kin_trigger_inbox i WHERE i.org_id = ${orgId} AND i.fire_id = ${fireId}
    AND i.consumed_at IS NULL AND NOT ${retirementHeld(sql, sql`i`)}`.pipe(
    Effect.map((rows) => rows.length > 0),
  );

const InboxRow = Schema.Struct({ payload: Schema.fromJsonString(KinTriggerFired) });
const decodeInboxRow = Schema.decodeUnknownEffect(InboxRow);

export class KinTriggerInbox extends Context.Service<
  KinTriggerInbox,
  {
    readonly put: (
      event: KinTriggerFired,
      receivedAt: number,
    ) => Effect.Effect<boolean, InboxError>;
    /** `subjects` narrows to those routines, or to deferral or scheduled task fires. */
    readonly listPending: (
      orgId: KinOrgId,
      limit?: number,
      subjects?: ReadonlyArray<KinRoutine> | "deferral" | "scheduled_task",
      kinds?: ReadonlyArray<FireKind>,
      after?: KinTriggerFireId,
    ) => Effect.Effect<ReadonlyArray<KinTriggerFired>, InboxError>;
    readonly markConsumed: (
      orgId: KinOrgId,
      fireIds: ReadonlyArray<KinTriggerFireId>,
    ) => Effect.Effect<void, InboxError>;
    readonly pruneConsumed: (now: number) => Effect.Effect<number, InboxError>;
  }
>()("t3/kin/triggers/KinTriggerInbox") {}

function toInboxError(operation: string) {
  return (cause: unknown): InboxError =>
    isInboxConflict(cause)
      ? cause
      : Schema.isSchemaError(cause)
        ? PersistenceDecodeError.fromSchemaError(operation, cause)
        : toPersistenceSqlError(operation)(cause);
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pending = SqlSchema.findAll({
    Request: PendingRequest,
    Result: InboxRow,
    execute: ({ orgId, limit, routines, kinds, after }) => sql`
      SELECT payload_json AS payload FROM kin_trigger_inbox
      WHERE org_id = ${orgId} AND consumed_at IS NULL
        AND NOT ${retirementHeld(sql, sql`kin_trigger_inbox`)}
        ${
          routines === undefined
            ? sql``
            : routines === "deferral" || routines === "scheduled_task"
              ? sql`AND json_extract(payload_json, '$.payload.subject.type') = ${routines}`
              : sql`AND json_extract(payload_json, '$.payload.subject.routine') IN (${sql.join(",", false)(routines.map((routine) => sql`${routine}`))})`
        }
        ${
          kinds === undefined
            ? sql``
            : sql`AND json_extract(payload_json, '$.payload.kind') IN (${sql.join(",", false)(kinds.map((kind) => sql`${kind}`))})`
        }
        ${
          after === undefined
            ? sql``
            : sql`AND (received_at, fire_id) > (
          SELECT received_at, fire_id FROM kin_trigger_inbox
          WHERE org_id = ${orgId} AND fire_id = ${after}
        )`
        }
      ORDER BY received_at, fire_id LIMIT ${limit}
    `,
  });

  return KinTriggerInbox.of({
    put: Effect.fn("KinTriggerInbox.put")(
      function* (event, receivedAt) {
        const payload = yield* encodeFire(event);
        const at = yield* decodeMillis(receivedAt);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ payload: string }>`
            SELECT payload_json AS payload FROM kin_trigger_inbox
            WHERE org_id = ${event.orgId} AND fire_id = ${event.fireId}
          `;
            if (rows[0]) {
              const existing = yield* decodeInboxRow(rows[0]);
              const previous = existing.payload.payload;
              const incoming = event.payload;
              if (previous.kind !== incoming.kind) {
                return yield* new KinTriggerInboxConflict({
                  orgId: event.orgId,
                  reason: "identity_conflict",
                });
              }
            }
            const insert = sql`
              INSERT INTO kin_trigger_inbox (fire_id, org_id, payload_json, received_at)
              VALUES (${event.fireId}, ${event.orgId}, ${payload}, ${at})
              ON CONFLICT (org_id, fire_id) DO NOTHING RETURNING fire_id
            `.pipe(Effect.map((rows) => rows.length === 1));
            // A native schedule's run, which only the sink writes, for a schedule Kin has a row for.
            if (
              event.payload.kind === "time" &&
              event.payload.subject.type === "scheduled_task" &&
              event.payload.triggerId === `native:${event.payload.subject.itemId}`
            ) {
              const taskId = scheduleTaskId(event.orgId, event.payload.subject.itemId);
              if (!event.fireId.startsWith(`ns:${taskId}:`))
                return yield* new KinTriggerInboxConflict({
                  orgId: event.orgId,
                  reason: "invalid_fire_id",
                });
              const schedule = yield* sql`SELECT 1 FROM kin_schedules
                WHERE org_id = ${event.orgId} AND task_id = ${taskId}`;
              if (schedule.length === 0)
                return yield* new KinTriggerInboxConflict({
                  orgId: event.orgId,
                  reason: "unknown_source",
                });
              return yield* insert;
            }
            return yield* new KinTriggerInboxConflict({
              orgId: event.orgId,
              reason: "not_a_schedule_run",
            });
          }),
        );
      },
      Effect.mapError(toInboxError("KinTriggerInbox.put")),
    ),
    listPending: Effect.fn("KinTriggerInbox.listPending")(
      function* (orgId, limit = 100, routines, kinds, after) {
        return (yield* pending({
          orgId,
          limit,
          ...(routines === undefined ? {} : { routines }),
          ...(kinds === undefined ? {} : { kinds }),
          ...(after === undefined ? {} : { after }),
        }).pipe(NodeSqliteClient.readOnly)).map((row) => row.payload);
      },
      Effect.mapError(toInboxError("KinTriggerInbox.listPending")),
    ),
    markConsumed: Effect.fn("KinTriggerInbox.markConsumed")(
      function* (orgId, fireIds) {
        yield* decodeOrg(orgId);
        const ids = yield* decodeIds(fireIds);
        if (ids.length === 0) return;
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        yield* sql.withTransaction(sql`
        UPDATE kin_trigger_inbox SET consumed_at = ${now}
        WHERE org_id = ${orgId} AND ${sql.in("fire_id", ids)} AND consumed_at IS NULL
          AND NOT ${retirementHeld(sql, sql`kin_trigger_inbox`)}
      `);
      },
      Effect.mapError(toInboxError("KinTriggerInbox.markConsumed")),
    ),
    pruneConsumed: Effect.fn("KinTriggerInbox.pruneConsumed")(
      function* (now) {
        const at = yield* decodeMillis(now);
        const rows = yield* sql`
        DELETE FROM kin_trigger_inbox WHERE consumed_at < ${at - 7 * 24 * 60 * 60 * 1000}
        RETURNING fire_id
      `;
        return rows.length;
      },
      Effect.mapError(toInboxError("KinTriggerInbox.pruneConsumed")),
    ),
  });
});

export const layer = Layer.effect(KinTriggerInbox, make);

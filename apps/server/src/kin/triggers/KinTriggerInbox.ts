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

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";

const encodeFire = Schema.encodeEffect(Schema.fromJsonString(KinTriggerFired));
const decodeMillis = Schema.decodeEffect(NonNegativeInt);
const decodeIds = Schema.decodeEffect(Schema.Array(KinTriggerFireId));
const decodeOrg = Schema.decodeEffect(KinOrgId);
export class KinTriggerInboxConflict extends Schema.TaggedError<KinTriggerInboxConflict>()(
  "KinTriggerInboxConflict",
  {
    orgId: KinOrgId,
    reason: Schema.Literals([
      "not_github",
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
  routines: Schema.optional(Schema.Union([Schema.Array(KinRoutine), Schema.Literal("deferral")])),
  kinds: Schema.optional(Schema.Array(FireKind)),
});

/** The `github_recheck` request a `github` fire turns into: one per fire, in the webhook id space. */
export const recheckFireId = (orgId: KinOrgId, sourceFireId: KinTriggerFireId) =>
  KinTriggerFireId.make(`gh:${orgId}:recheck:${sourceFireId.slice(`gh:${orgId}:`.length)}`);
const InboxRow = Schema.Struct({ payload: Schema.fromJsonString(KinTriggerFired) });
const decodeInboxRow = Schema.decodeUnknownEffect(InboxRow);

export class KinTriggerInbox extends Context.Service<
  KinTriggerInbox,
  {
    readonly put: (
      event: KinTriggerFired,
      receivedAt: number,
    ) => Effect.Effect<boolean, InboxError>;
    /** `subjects` narrows to those routines, or to deferral fires. */
    readonly listPending: (
      orgId: KinOrgId,
      limit?: number,
      subjects?: ReadonlyArray<KinRoutine> | "deferral",
      kinds?: ReadonlyArray<FireKind>,
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
    execute: ({ orgId, limit, routines, kinds }) => sql`
      SELECT payload_json AS payload FROM kin_trigger_inbox
      WHERE org_id = ${orgId} AND consumed_at IS NULL
        ${
          routines === undefined
            ? sql``
            : routines === "deferral"
              ? sql`AND json_extract(payload_json, '$.payload.subject.type') = 'deferral'`
              : sql`AND json_extract(payload_json, '$.payload.subject.routine') IN (${sql.join(",", false)(routines.map((routine) => sql`${routine}`))})`
        }
        ${
          kinds === undefined
            ? sql``
            : sql`AND json_extract(payload_json, '$.payload.kind') IN (${sql.join(",", false)(kinds.map((kind) => sql`${kind}`))})`
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
              if (
                previous.kind !== incoming.kind ||
                (previous.kind === "github" &&
                  incoming.kind === "github" &&
                  (previous.deliveryId !== incoming.deliveryId ||
                    previous.sourceId !== incoming.sourceId ||
                    previous.scheduledTaskId !== incoming.scheduledTaskId)) ||
                (previous.kind === "github_recheck" &&
                  incoming.kind === "github_recheck" &&
                  previous.sourceFireId !== incoming.sourceFireId)
              ) {
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
            if (event.payload.kind === "github_recheck") {
              if (
                !event.payload.sourceFireId.startsWith(`gh:${event.orgId}:delivery:`) ||
                event.fireId !== recheckFireId(event.orgId, event.payload.sourceFireId)
              ) {
                return yield* new KinTriggerInboxConflict({
                  orgId: event.orgId,
                  reason: "invalid_fire_id",
                });
              }
              const origin = yield* sql`
                SELECT fire_id FROM kin_trigger_inbox
                WHERE org_id = ${event.orgId} AND fire_id = ${event.payload.sourceFireId}
              `;
              if (origin.length === 0) {
                return yield* new KinTriggerInboxConflict({
                  orgId: event.orgId,
                  reason: "unknown_source",
                });
              }
              return yield* insert;
            }
            if (event.payload.kind !== "github") {
              return yield* new KinTriggerInboxConflict({
                orgId: event.orgId,
                reason: "not_github",
              });
            }
            if (event.fireId !== `gh:${event.orgId}:${event.payload.deliveryId}`) {
              return yield* new KinTriggerInboxConflict({
                orgId: event.orgId,
                reason: "invalid_fire_id",
              });
            }
            const source = yield* sql`
              SELECT source_id FROM kin_webhook_sources
              WHERE org_id = ${event.orgId} AND source_id = ${event.payload.sourceId}
                AND scheduled_task_id = ${event.payload.scheduledTaskId}
            `;
            if (source.length === 0) {
              return yield* new KinTriggerInboxConflict({
                orgId: event.orgId,
                reason: "unknown_source",
              });
            }
            return yield* insert;
          }),
        );
      },
      Effect.mapError(toInboxError("KinTriggerInbox.put")),
    ),
    listPending: Effect.fn("KinTriggerInbox.listPending")(
      function* (orgId, limit = 100, routines, kinds) {
        return (yield* pending({
          orgId,
          limit,
          ...(routines === undefined ? {} : { routines }),
          ...(kinds === undefined ? {} : { kinds }),
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

import { KinOrgId, KinTriggerFireId, KinTriggerFired } from "@t3tools/contracts";
import * as Context from "effect/Context";
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

type InboxError = PersistenceSqlError | PersistenceDecodeError;
const PendingRequest = Schema.Struct({
  orgId: KinOrgId,
  limit: Schema.Int.check(Schema.isGreaterThan(0)),
});
const InboxRow = Schema.Struct({ payload: Schema.fromJsonString(KinTriggerFired) });

export class KinTriggerInbox extends Context.Service<
  KinTriggerInbox,
  {
    readonly put: (
      event: KinTriggerFired,
      receivedAt: number,
    ) => Effect.Effect<boolean, InboxError>;
    readonly list: (
      orgId: KinOrgId,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<KinTriggerFired>, InboxError>;
    readonly claim: (
      orgId: KinOrgId,
      now: number,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<KinTriggerFired>, InboxError>;
    readonly consume: (
      orgId: KinOrgId,
      fireId: KinTriggerFireId,
      now: number,
    ) => Effect.Effect<boolean, InboxError>;
    readonly requeue: (orgId: KinOrgId) => Effect.Effect<void, InboxError>;
  }
>()("t3/kin/triggers/KinTriggerInbox") {}

function toInboxError(cause: unknown): InboxError {
  return Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError("KinTriggerInbox.decode", cause)
    : toPersistenceSqlError("KinTriggerInbox.query")(cause);
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pending = SqlSchema.findAll({
    Request: PendingRequest,
    Result: InboxRow,
    execute: ({ orgId, limit }) => sql`
      SELECT payload_json AS payload FROM kin_trigger_inbox
      WHERE org_id = ${orgId} AND consumed_at IS NULL AND claimed_at IS NULL
      ORDER BY received_at, fire_id LIMIT ${limit}
    `,
  });

  return KinTriggerInbox.of({
    put: Effect.fn("KinTriggerInbox.put")(function* (event, receivedAt) {
      const payload = yield* encodeFire(event);
      const inserted = yield* sql`
        INSERT OR IGNORE INTO kin_trigger_inbox (fire_id, org_id, payload_json, received_at)
        VALUES (${event.fireId}, ${event.orgId}, ${payload}, ${receivedAt}) RETURNING fire_id
      `;
      return inserted.length === 1;
    }, Effect.mapError(toInboxError)),
    list: Effect.fn("KinTriggerInbox.list")(function* (orgId, limit = 100) {
      return (yield* pending({ orgId, limit })).map((row) => row.payload);
    }, Effect.mapError(toInboxError)),
    claim: Effect.fn("KinTriggerInbox.claim")(function* (orgId, now, limit = 100) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* pending({ orgId, limit });
          for (const { payload } of rows) {
            yield* sql`
            UPDATE kin_trigger_inbox SET claimed_at = ${now}
            WHERE org_id = ${orgId} AND fire_id = ${payload.fireId}
              AND consumed_at IS NULL AND claimed_at IS NULL
          `;
          }
          return rows.map((row) => row.payload);
        }),
      );
    }, Effect.mapError(toInboxError)),
    consume: Effect.fn("KinTriggerInbox.consume")(function* (orgId, fireId, now) {
      const rows = yield* sql`
        UPDATE kin_trigger_inbox SET consumed_at = ${now}
        WHERE org_id = ${orgId} AND fire_id = ${fireId}
          AND consumed_at IS NULL AND claimed_at IS NOT NULL
        RETURNING fire_id
      `;
      return rows.length === 1;
    }, Effect.mapError(toInboxError)),
    requeue: Effect.fn("KinTriggerInbox.requeue")(function* (orgId) {
      yield* sql`
        UPDATE kin_trigger_inbox SET claimed_at = NULL
        WHERE org_id = ${orgId} AND consumed_at IS NULL AND claimed_at IS NOT NULL
      `;
    }, Effect.mapError(toInboxError)),
  });
});

export const layer = Layer.effect(KinTriggerInbox, make);

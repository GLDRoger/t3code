// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Digest is effectful; the sink compares in one synchronous step.
import * as NodeCrypto from "node:crypto";

import {
  CanonicalUtcTimestamp,
  CommandId,
  KIN_GITHUB_APP_SOURCE,
  canonicalTimeZone,
  NonNegativeInt,
  KinOrgId,
  KinWebhookSource,
  KinWebhookSourceId,
  ScheduledTaskId,
  KinTrigger,
  KinTriggerFired,
  KinTriggerId,
  KinTriggerSchedule,
  KinTriggerSubject,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";
import { KIN_COMMAND_PREFIX, KIN_TASK_PREFIX } from "./taskIds.ts";

export class KinTriggerFireConflict extends Schema.TaggedError<KinTriggerFireConflict>()(
  "KinTriggerFireConflict",
  {
    orgId: KinOrgId,
    reason: Schema.Literals([
      "not_time",
      "not_due",
      "inbox_not_inserted",
      "invalid_fire_id",
      "invalid_next_run",
      "identity_conflict",
    ]),
  },
) {}

export class KinWebhookSourceConflict extends Schema.TaggedError<KinWebhookSourceConflict>()(
  "KinWebhookSourceConflict",
  {
    orgId: KinOrgId,
    reason: Schema.Literals([
      "unknown_source",
      "identity_conflict",
      "task_active",
      "app_source_taken",
    ]),
  },
) {}

const sourceColumns = `source_id AS id, org_id AS "orgId", repo,
  scheduled_task_id AS "scheduledTaskId", inbox_thread_id AS "inboxThreadId",
  github_hook_id AS "githubHookId", bot_login AS "botLogin", status`;
const decodeSource = Schema.decodeUnknownEffect(KinWebhookSource);
const isSourceConflict = Schema.is(KinWebhookSourceConflict);

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
const DueCursor = Schema.Struct({ nextRunAt: NonNegativeInt, orgId: KinOrgId, id: KinTriggerId });
export type DueCursor = typeof DueCursor.Type;
const decodeCursor = Schema.decodeUnknownEffect(DueCursor);
const PutTrigger = KinTrigger.check(
  Schema.makeFilter((value) => !value.id.startsWith("gh:") || "Reserved webhook prefix."),
);
const decodePutTrigger = Schema.decodeEffect(PutTrigger);
const decodeInboxRow = Schema.decodeUnknownEffect(
  Schema.Struct({ payload: Schema.fromJsonString(KinTriggerFired) }),
);
const Scope = Schema.Struct({ orgId: KinOrgId, id: KinTriggerId });

export const githubAppCommandId = (orgId: KinOrgId) =>
  CommandId.make(`${KIN_COMMAND_PREFIX}webhook:${orgId}:${KIN_GITHUB_APP_SOURCE}`);
// Upstream names a task created by commandId `scheduled-task:${commandId}`.
export const githubAppTaskId = (orgId: KinOrgId) =>
  ScheduledTaskId.make(`scheduled-task:${githubAppCommandId(orgId)}`);
export const KIN_WEBHOOK_TASK_PREFIX = `${KIN_TASK_PREFIX}webhook:`;
export const GITHUB_REPLAY_KEY = "{{headers.x-github-delivery}}";
// Exactly this, no coalesce window: a held delivery would outlive a re-key.
export const GITHUB_DEDUPE = { replayKey: GITHUB_REPLAY_KEY };
export const GITHUB_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "issues",
  "check_suite",
  "workflow_run",
  "push",
];

const secretDigest = (secret: Redacted.Redacted<string>) =>
  NodeCrypto.createHash("sha256").update(Redacted.value(secret)).digest();

// Cross-org on purpose: one GitHub App has one hook config, so its source is host-wide.
export const appSourceHeldElsewhere = (sql: SqlClient.SqlClient, orgId: KinOrgId) =>
  sql`SELECT 1 FROM kin_webhook_sources WHERE repo = ${KIN_GITHUB_APP_SOURCE}
    AND org_id <> ${orgId} LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0));

// Shared with the upstream contract test: a direct delivery marks its task running and a
// queued one holds a pending row until its launch returns.
export const inFlightDeliveries = (sql: SqlClient.SqlClient, taskId: string) =>
  sql`SELECT 1 FROM scheduled_tasks WHERE task_id = ${taskId} AND last_run_status = 'running'
    UNION ALL SELECT 1 FROM scheduled_task_webhook_pending
    WHERE task_id = ${taskId} AND state IN ('dispatching', 'running')`;

export class KinTriggerStore extends Context.Service<
  KinTriggerStore,
  {
    readonly registerSource: (
      source: KinWebhookSource,
    ) => Effect.Effect<KinWebhookSource, StoreError | KinWebhookSourceConflict>;
    /** Refuses while the upstream task is enabled or a delivery is dispatching, so none falls through to a real launch. */
    readonly unregisterSource: (
      orgId: KinOrgId,
      id: KinWebhookSourceId,
    ) => Effect.Effect<void, StoreError | KinWebhookSourceConflict>;
    /** Binds the source to the secret Kin just saved upstream and to the time of this bind. */
    readonly bindSecret: (
      orgId: KinOrgId,
      id: KinWebhookSourceId,
      secret: Redacted.Redacted<string>,
    ) => Effect.Effect<void, StoreError>;
    /**
     * True only for the bound secret and a delivery received after the bind, so one verified
     * against an earlier secret refuses. False when nothing is bound, as before K019.
     */
    readonly acceptsDelivery: (
      orgId: KinOrgId,
      id: KinWebhookSourceId,
      delivery: { readonly secret: Redacted.Redacted<string>; readonly receivedAt: number },
    ) => Effect.Effect<boolean, StoreError>;
    readonly getSource: (
      orgId: KinOrgId,
      id: KinWebhookSourceId,
    ) => Effect.Effect<KinWebhookSource | undefined, StoreError>;
    readonly sourceByTaskId: (
      id: ScheduledTaskId,
    ) => Effect.Effect<KinWebhookSource | undefined, StoreError>;
    readonly listSources: (
      orgId: KinOrgId,
    ) => Effect.Effect<ReadonlyArray<KinWebhookSource>, StoreError>;
    /** Records what `trigger_reconcile` saw; false when the status was no longer `from`. */
    readonly setSourceStatus: (
      orgId: KinOrgId,
      id: KinWebhookSourceId,
      from: KinWebhookSource["status"],
      to: KinWebhookSource["status"],
    ) => Effect.Effect<boolean, StoreError>;
    /** True when the task's current secret is the one bound to the source. */
    readonly secretMatchesTask: (
      orgId: KinOrgId,
      id: KinWebhookSourceId,
    ) => Effect.Effect<boolean, StoreError>;
    readonly put: (trigger: Omit<KinTrigger, "lastFireId">) => Effect.Effect<void, StoreError>;
    readonly get: (
      orgId: KinOrgId,
      id: KinTriggerId,
    ) => Effect.Effect<KinTrigger | undefined, StoreError>;
    readonly list: (orgId: KinOrgId) => Effect.Effect<ReadonlyArray<KinTrigger>, StoreError>;
    readonly delete: (orgId: KinOrgId, id: KinTriggerId) => Effect.Effect<void, StoreError>;
    readonly listDue: (
      now: number,
      limit: number,
      after?: DueCursor,
    ) => Effect.Effect<ReadonlyArray<KinTrigger>, StoreError>;
    readonly fire: (
      event: KinTriggerFired,
      nextRunAt: (trigger: KinTrigger) => KinTrigger["nextRunAt"],
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
const encodeFire = Schema.encodeEffect(Schema.fromJsonString(KinTriggerFired));
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
  const threads = yield* ThreadManagementService.ThreadManagementService;
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
    registerSource: Effect.fn("KinTriggerStore.registerSource")(
      function* (source) {
        const value = yield* decodeSource(source);
        const projection = yield* threads
          .getThreadProjection(value.inboxThreadId)
          .pipe(
            Effect.mapError(
              () => new KinWebhookSourceConflict({ orgId: value.orgId, reason: "unknown_source" }),
            ),
          );
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            if (
              value.repo === KIN_GITHUB_APP_SOURCE &&
              (yield* appSourceHeldElsewhere(sql, value.orgId))
            )
              return yield* new KinWebhookSourceConflict({
                orgId: value.orgId,
                reason: "app_source_taken",
              });
            const owned = yield* sql`
            SELECT t.task_id FROM scheduled_tasks t
            WHERE t.task_id = ${value.scheduledTaskId}
              AND t.project_id = ${projection.thread.projectId}
              AND t.thread_id IS NULL AND t.thread_mode = 'new_thread'
              AND json_extract(t.schedule_json, '$.type') = 'webhook'
              AND EXISTS (SELECT 1 FROM kin_orgs WHERE org_id = ${value.orgId})
              AND NOT EXISTS (SELECT 1 FROM kin_agent_threads WHERE thread_id = ${value.inboxThreadId})
              AND NOT EXISTS (
                SELECT 1 FROM kin_webhook_sources
                WHERE org_id <> ${value.orgId}
                  AND (scheduled_task_id = ${value.scheduledTaskId} OR inbox_thread_id = ${value.inboxThreadId})
              )
          `;
            if (owned.length === 0 || projection.thread.deletedAt !== null)
              return yield* new KinWebhookSourceConflict({
                orgId: value.orgId,
                reason: "unknown_source",
              });
            const inserted = yield* sql`
            INSERT INTO kin_webhook_sources
              (org_id, source_id, repo, scheduled_task_id, inbox_thread_id, github_hook_id, bot_login, status)
            VALUES (${value.orgId}, ${value.id}, ${value.repo}, ${value.scheduledTaskId},
              ${value.inboxThreadId}, ${value.githubHookId}, ${value.botLogin}, ${value.status})
            ON CONFLICT DO NOTHING RETURNING source_id
          `;
            if (inserted.length === 1) return value;
            const [row] = yield* sql`
            SELECT ${sql.literal(sourceColumns)} FROM kin_webhook_sources
            WHERE org_id = ${value.orgId} AND source_id = ${value.id}
          `;
            if (row === undefined)
              return yield* new KinWebhookSourceConflict({
                orgId: value.orgId,
                reason: "unknown_source",
              });
            const stored = yield* decodeSource(row);
            if (
              stored.repo !== value.repo ||
              stored.scheduledTaskId !== value.scheduledTaskId ||
              stored.inboxThreadId !== value.inboxThreadId ||
              stored.githubHookId !== value.githubHookId ||
              stored.botLogin !== value.botLogin ||
              stored.status !== value.status
            ) {
              return yield* new KinWebhookSourceConflict({
                orgId: value.orgId,
                reason: "identity_conflict",
              });
            }
            return stored;
          }),
        );
      },
      Effect.mapError((cause) =>
        isSourceConflict(cause)
          ? cause
          : toPersistenceOrDecodeError("KinTriggerStore.registerSource")(cause),
      ),
    ),
    unregisterSource: Effect.fn("KinTriggerStore.unregisterSource")(
      function* (orgId, id) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const [source] = yield* sql<{
              readonly taskId: string;
              readonly enabled: number | null;
            }>`
              SELECT s.scheduled_task_id AS "taskId", t.enabled FROM kin_webhook_sources s
              LEFT JOIN scheduled_tasks t ON t.task_id = s.scheduled_task_id
              WHERE s.org_id = ${orgId} AND s.source_id = ${id}
            `;
            if (source === undefined) return;
            if (source.enabled === 1 || (yield* inFlightDeliveries(sql, source.taskId)).length > 0)
              return yield* new KinWebhookSourceConflict({ orgId, reason: "task_active" });
            yield* sql`DELETE FROM kin_webhook_sources WHERE org_id = ${orgId} AND source_id = ${id}`;
          }),
        );
      },
      Effect.mapError((cause) =>
        isSourceConflict(cause)
          ? cause
          : toPersistenceOrDecodeError("KinTriggerStore.unregisterSource")(cause),
      ),
    ),
    bindSecret: Effect.fn("KinTriggerStore.bindSecret")(
      function* (orgId, id, secret) {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE kin_webhook_sources
          SET secret_sha256 = ${secretDigest(secret).toString("hex")}, secret_bound_at = ${now}
          WHERE org_id = ${orgId} AND source_id = ${id}`;
      },
      Effect.mapError(toPersistenceSqlError("KinTriggerStore.bindSecret")),
    ),
    acceptsDelivery: Effect.fn("KinTriggerStore.acceptsDelivery")(
      function* (orgId, id, delivery) {
        const [row] = yield* sql<{
          readonly hash: string | null;
          readonly boundAt: number | null;
        }>`
          SELECT secret_sha256 AS hash, secret_bound_at AS "boundAt" FROM kin_webhook_sources
          WHERE org_id = ${orgId} AND source_id = ${id}`.pipe(NodeSqliteClient.readOnly);
        // Same millisecond refuses too: it may have been verified just before the save.
        if (row?.hash == null || row.boundAt == null || delivery.receivedAt <= row.boundAt)
          return false;
        const bound = Buffer.from(row.hash, "hex");
        const given = secretDigest(delivery.secret);
        return bound.length === given.length && NodeCrypto.timingSafeEqual(bound, given);
      },
      Effect.mapError(toPersistenceSqlError("KinTriggerStore.acceptsDelivery")),
    ),
    getSource: Effect.fn("KinTriggerStore.getSource")(
      function* (orgId, id) {
        const [row] = yield* sql`SELECT ${sql.literal(sourceColumns)} FROM kin_webhook_sources
          WHERE org_id = ${orgId} AND source_id = ${id}`.pipe(NodeSqliteClient.readOnly);
        return row === undefined ? undefined : yield* decodeSource(row);
      },
      Effect.mapError(toPersistenceOrDecodeError("KinTriggerStore.getSource")),
    ),
    sourceByTaskId: Effect.fn("KinTriggerStore.sourceByTaskId")(
      function* (id) {
        // The dispatch boundary has only a task id; its unique source determines the org.
        const [row] = yield* sql`SELECT ${sql.literal(sourceColumns)} FROM kin_webhook_sources
          WHERE scheduled_task_id = ${id}`.pipe(NodeSqliteClient.readOnly);
        return row === undefined ? undefined : yield* decodeSource(row);
      },
      Effect.mapError(toPersistenceOrDecodeError("KinTriggerStore.sourceByTaskId")),
    ),
    listSources: Effect.fn("KinTriggerStore.listSources")(
      function* (orgId) {
        const rows = yield* sql`SELECT ${sql.literal(sourceColumns)} FROM kin_webhook_sources
          WHERE org_id = ${orgId} ORDER BY source_id`.pipe(NodeSqliteClient.readOnly);
        return yield* Effect.forEach(rows, (row) => decodeSource(row));
      },
      Effect.mapError(toPersistenceOrDecodeError("KinTriggerStore.listSources")),
    ),
    setSourceStatus: Effect.fn("KinTriggerStore.setSourceStatus")(
      function* (orgId, id, from, to) {
        const rows = yield* sql`UPDATE kin_webhook_sources SET status = ${to}
          WHERE org_id = ${orgId} AND source_id = ${id} AND status = ${from}
          RETURNING source_id`;
        return rows.length === 1;
      },
      Effect.mapError(toPersistenceSqlError("KinTriggerStore.setSourceStatus")),
    ),
    secretMatchesTask: Effect.fn("KinTriggerStore.secretMatchesTask")(
      function* (orgId, id) {
        const [row] = yield* sql<{
          readonly hash: string | null;
          readonly secret: string | null;
        }>`SELECT s.secret_sha256 AS hash, t.webhook_secret AS secret FROM kin_webhook_sources s
          JOIN scheduled_tasks t ON t.task_id = s.scheduled_task_id
          WHERE s.org_id = ${orgId} AND s.source_id = ${id}`.pipe(NodeSqliteClient.readOnly);
        if (row?.hash == null || row.secret == null) return false;
        const bound = Buffer.from(row.hash, "hex");
        const given = secretDigest(Redacted.make(row.secret));
        return bound.length === given.length && NodeCrypto.timingSafeEqual(bound, given);
      },
      Effect.mapError(toPersistenceSqlError("KinTriggerStore.secretMatchesTask")),
    ),
    put: Effect.fn("KinTriggerStore.put")(
      function* (trigger) {
        const value = yield* decodePutTrigger({ ...trigger, lastFireId: null });
        const timeZone = canonicalTimeZone(value.timeZone);
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
          ${value.id}, ${value.orgId}, ${subject}, ${schedule}, ${timeZone}, ${value.enabled ? 1 : 0},
          ${nextRunAt}, NULL,
          ${createdAt}, ${updatedAt}
        )
        ON CONFLICT (org_id, trigger_id) DO UPDATE SET
          subject_json = excluded.subject_json, schedule_json = excluded.schedule_json,
          time_zone = excluded.time_zone, enabled = excluded.enabled, next_run_at = excluded.next_run_at,
          updated_at = excluded.updated_at
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
      function* (now, limit, after) {
        const at = yield* decodeMillis(now);
        const count = yield* decodeLimit(limit);
        const triggers: KinTrigger[] = [];
        let cursor = after === undefined ? undefined : yield* decodeCursor(after);
        while (triggers.length < count) {
          // Spans orgs for the scheduler tick; `fire` rechecks the org.
          const rows = yield* sql<DueCursor>`
            SELECT ${columns} FROM kin_triggers
            WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ${at}
            ${cursor === undefined ? sql`` : sql`AND (next_run_at, org_id, trigger_id) > (${cursor.nextRunAt}, ${cursor.orgId}, ${cursor.id})`}
            ORDER BY next_run_at, org_id, trigger_id LIMIT ${count}
          `.pipe(NodeSqliteClient.readOnly);
          for (const row of rows) {
            const decoded = yield* Effect.result(
              decodeRow(row).pipe(Effect.flatMap((value) => decodeRows([value]))),
            );
            if (Result.isSuccess(decoded)) triggers.push(...decoded.success);
            else
              yield* Effect.logWarning("Skipping undecodable Kin trigger row", {
                cause: decoded.failure,
              });
            if (triggers.length === count) break;
          }
          if (rows.length < count) break;
          cursor = yield* decodeCursor(rows[rows.length - 1]);
        }
        return triggers;
      },
      Effect.mapError(toPersistenceOrDecodeError("KinTriggerStore.listDue")),
    ),
    fire: Effect.fn("KinTriggerStore.fire")(function* (event, nextRunAt) {
      const value = yield* decodeFire(event);
      if (value.payload.kind !== "time") {
        return yield* new KinTriggerFireConflict({ orgId: value.orgId, reason: "not_time" });
      }
      const triggerId = value.payload.triggerId;
      const dueAt = yield* epoch(value.dueAt);
      if (value.fireId !== `${triggerId}:${dueAt}`) {
        return yield* new KinTriggerFireConflict({ orgId: value.orgId, reason: "invalid_fire_id" });
      }
      const firedAt = yield* epoch(value.firedAt);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          // Pending inbox rows deduplicate even after the 30-day fire ledger expires.
          const existing = yield* sql`
            SELECT payload_json AS payload FROM kin_trigger_inbox
            WHERE org_id = ${value.orgId} AND fire_id = ${value.fireId}
          `;
          if (existing[0]) {
            const previous = yield* decodeInboxRow(existing[0]);
            if (
              previous.payload.payload.kind !== "time" ||
              previous.payload.payload.triggerId !== triggerId
            ) {
              return yield* new KinTriggerFireConflict({
                orgId: value.orgId,
                reason: "identity_conflict",
              });
            }
          }
          let duplicate = existing.length !== 0;
          if (!duplicate) {
            const inserted = yield* sql`
              INSERT INTO kin_trigger_fires (fire_id, org_id, fired_at)
              VALUES (${value.fireId}, ${value.orgId}, ${firedAt})
              ON CONFLICT (org_id, fire_id) DO NOTHING RETURNING fire_id
            `;
            duplicate = inserted.length === 0;
            const payload = yield* encodeFire(value);
            const inboxRows = duplicate
              ? []
              : yield* sql`
              INSERT INTO kin_trigger_inbox (fire_id, org_id, payload_json, received_at)
              VALUES (${value.fireId}, ${value.orgId}, ${payload}, ${firedAt})
              ON CONFLICT (org_id, fire_id) DO NOTHING RETURNING fire_id
            `;
            if (!duplicate && inboxRows.length !== 1) {
              return yield* new KinTriggerFireConflict({
                orgId: value.orgId,
                reason: "inbox_not_inserted",
              });
            }
          }
          const [trigger] = yield* decodeRows(
            yield* getRows({ orgId: value.orgId, id: triggerId }),
          );
          if (
            trigger === undefined ||
            !trigger.enabled ||
            trigger.nextRunAt === null ||
            (yield* epoch(trigger.nextRunAt)) !== dueAt
          ) {
            if (duplicate) return "duplicate";
            return yield* new KinTriggerFireConflict({ orgId: value.orgId, reason: "not_due" });
          }
          const next = yield* decodeNextRunAt(nextRunAt(trigger));
          const nextAt = next === null ? null : yield* epoch(next);
          if (nextAt !== null && nextAt <= dueAt) {
            return yield* new KinTriggerFireConflict({
              orgId: value.orgId,
              reason: "invalid_next_run",
            });
          }
          const updated = yield* sql`
          UPDATE kin_triggers SET
            next_run_at = CASE WHEN json_extract(schedule_json, '$.type') = 'once' THEN NULL
              ELSE ${nextAt} END,
            last_fire_id = ${value.fireId}, updated_at = max(updated_at, ${firedAt})
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

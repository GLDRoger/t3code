// @effect-diagnostics nodeBuiltinImport:off -- a synchronous SHA-256 for the idempotency key.
import * as NodeCrypto from "node:crypto";

import {
  KinActionId,
  KinActionKind,
  KinActionTarget,
  KinAgentId,
  KinEventId,
  KinGrant,
  KinOrgId,
  KinPendingAction,
  KinPersonId,
  KinProvenance,
  KinResolvedTarget,
  ThreadId,
  type AuthSessionId,
  type Hex64,
  type KinKeyThumbprint,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PersistenceDecodeError,
  type PersistenceSqlError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";
import { KinAudit } from "./Audit.ts";

const AWAITING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A grant lapses at min(exp, acceptedAt + 15 min) (approvals spec section 5).
const GRANT_ACCEPTED_TTL_MS = 15 * 60 * 1000;

const CreateInput = Schema.Struct({
  orgId: KinOrgId,
  kind: KinActionKind,
  target: KinActionTarget,
  resolved: KinResolvedTarget,
  targetDigest: KinPendingAction.fields.targetDigest,
  reason: KinPendingAction.fields.reason,
  requestedBy: Schema.Struct({ agentId: KinAgentId, threadId: ThreadId }),
  provenance: KinProvenance,
  source: KinEventId,
});
export type KinPendingActionCreateInput = typeof CreateInput.Type;
const decodeCreateInput = Schema.decodeEffect(CreateInput);
const StoredAction = Schema.Struct({
  ...KinPendingAction.fields,
  target: Schema.fromJsonString(KinActionTarget),
  resolved: Schema.fromJsonString(KinResolvedTarget),
  provenance: Schema.fromJsonString(KinProvenance),
  requiredApprovers: Schema.fromJsonString(KinPendingAction.fields.requiredApprovers),
});
const decodeAction = Schema.decodeUnknownEffect(StoredAction);
const encodeTarget = Schema.encodeEffect(StoredAction.fields.target);
const encodeResolved = Schema.encodeEffect(StoredAction.fields.resolved);
const encodeProvenance = Schema.encodeEffect(StoredAction.fields.provenance);
const encodeApprovers = Schema.encodeEffect(StoredAction.fields.requiredApprovers);
const decodeGrant = Schema.decodeUnknownEffect(KinGrant);
const decodeActionId = Schema.decodeEffect(KinActionId);

type ActionRef = { readonly orgId: KinOrgId; readonly actionId: KinActionId };
type RevisionRef = ActionRef & { readonly revision: number };

export type KinApproveResult =
  | { readonly _tag: "approved"; readonly grant: KinGrant }
  | { readonly _tag: "replayed" }
  | { readonly _tag: "stale" };

type Errors = PersistenceSqlError | PersistenceDecodeError;

/** Spec section 7: one action per (org, kind, target, triggering event), whatever retries. */
export const kinIdempotencyKey = (input: {
  readonly orgId: KinOrgId;
  readonly kind: KinActionKind;
  readonly target: KinActionTarget;
  readonly source: KinEventId;
}): Hex64 =>
  NodeCrypto.createHash("sha256")
    .update(
      stableStringify({
        orgId: input.orgId,
        kind: input.kind,
        target: input.target,
        source: input.source,
      }),
    )
    .digest("hex");

const newNonce = () => Base64Url.encode(SecureRandom.randomBytesUnsafe(32));
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

type ActionRow = {
  readonly action_id: string;
  readonly org_id: string;
  readonly idempotency_key: string;
  readonly kind: string;
  readonly target_json: string;
  readonly resolved_json: string;
  readonly target_digest: string;
  readonly nonce: string;
  readonly revision: number;
  readonly reason: string;
  readonly requested_by_agent_id: string;
  readonly requested_by_thread_id: string;
  readonly provenance_json: string;
  readonly required_approvers_json: string;
  readonly state: string;
  readonly state_reason: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly expires_at: number;
};

const toAction = (row: ActionRow) =>
  decodeAction({
    id: row.action_id,
    orgId: row.org_id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    target: row.target_json,
    resolved: row.resolved_json,
    targetDigest: row.target_digest,
    nonce: row.nonce,
    revision: row.revision,
    reason: row.reason,
    requestedBy: { agentId: row.requested_by_agent_id, threadId: row.requested_by_thread_id },
    provenance: row.provenance_json,
    requiredApprovers: row.required_approvers_json,
    state: row.state,
    ...(row.state_reason === null ? {} : { stateReason: row.state_reason }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at),
  });

type FactsRow = { action_id: string; kind: string; resolved_json: string };
const decodeFacts = Schema.decodeUnknownEffect(
  Schema.Struct({
    actionId: KinActionId,
    kind: KinActionKind,
    resolved: StoredAction.fields.resolved,
  }),
);
// What every audit entry about an action carries, read from the row the statement touched.
const auditFacts = (row: FactsRow) =>
  decodeFacts({ actionId: row.action_id, kind: row.kind, resolved: row.resolved_json }).pipe(
    Effect.map(({ actionId, kind, resolved }) => ({
      actionId,
      kind,
      ...(resolved._tag === "none" ? {} : { headSha: resolved.headSha }),
    })),
  );

class Rollback extends Schema.TaggedError<Rollback>()("Rollback", {}) {}

export class KinPendingActions extends Context.Service<
  KinPendingActions,
  {
    /** Inserts, or returns the action an identical earlier request created. */
    readonly create: (
      input: KinPendingActionCreateInput,
    ) => Effect.Effect<{ readonly action: KinPendingAction; readonly created: boolean }, Errors>;
    readonly get: (ref: ActionRef) => Effect.Effect<Option.Option<KinPendingAction>, Errors>;
    /** New PR facts: bumps the revision and rotates the nonce, so older grants go stale. */
    readonly refresh: (
      input: RevisionRef & {
        readonly resolved: KinResolvedTarget;
        readonly targetDigest: Hex64;
      },
    ) => Effect.Effect<Option.Option<KinPendingAction>, Errors>;
    /** Terminal moves without execution. False means another writer won the race. */
    readonly transition: (
      input: RevisionRef & {
        readonly to: "rejected" | "cancelled" | "expired" | "voided";
        readonly reason?: string;
        readonly sessionId?: AuthSessionId;
      },
    ) => Effect.Effect<boolean, Errors>;
    /** Check 10: the grant row and `awaiting_approval → approved` in one transaction. */
    readonly approve: (
      input: RevisionRef & {
        readonly nonce: string;
        readonly jti: string;
        readonly approverHumanId: KinPersonId;
        readonly keyThumbprint: KinKeyThumbprint;
        readonly compact: string;
        readonly iat: number;
        readonly exp: number;
        readonly sessionId?: AuthSessionId;
        readonly deviceLabel?: string;
      },
    ) => Effect.Effect<KinApproveResult, Errors>;
    /** The executor's single claim: the `kin_executions` insert plus `approved → executing`. */
    readonly claim: (
      input: RevisionRef & { readonly grantId: KinGrant["id"] },
    ) => Effect.Effect<boolean, Errors>;
    readonly finish: (
      input: ActionRef & {
        readonly outcome: "succeeded" | "failed" | "interrupted";
        readonly githubRequestId?: string;
        readonly mergeCommitSha?: string;
        readonly error?: string;
        /** Startup reconciliation decided the outcome, not a live run. */
        readonly reconciled?: boolean;
      },
    ) => Effect.Effect<boolean, Errors>;
    /** Expires unapproved actions past `expiresAt` and voids approvals whose grant lapsed. */
    readonly sweep: () => Effect.Effect<
      { readonly expired: ReadonlyArray<ActionRef>; readonly voided: ReadonlyArray<ActionRef> },
      Errors
    >;
  }
>()("t3/kin/approvals/PendingActions/KinPendingActions") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const audit = yield* KinAudit;

  const select = (ref: ActionRef) =>
    sql<ActionRow>`SELECT * FROM kin_pending_actions
      WHERE org_id = ${ref.orgId} AND action_id = ${ref.actionId}`;

  const get = Effect.fn("KinPendingActions.get")(
    function* (ref: ActionRef) {
      const [row] = yield* select(ref);
      return row === undefined ? Option.none() : Option.some(yield* toAction(row));
    },
    Effect.mapError(toError("KinPendingActions.get")),
  );

  const create = Effect.fn("KinPendingActions.create")(
    function* (raw: KinPendingActionCreateInput) {
      const input = yield* decodeCreateInput(raw);
      const now = yield* Clock.currentTimeMillis;
      const idempotencyKey = kinIdempotencyKey(input);
      const id = yield* decodeActionId(`act_${SecureRandom.ulidUnsafe()}`);
      const row = {
        action_id: id,
        org_id: input.orgId,
        idempotency_key: idempotencyKey,
        kind: input.kind,
        target_json: yield* encodeTarget(input.target),
        resolved_json: yield* encodeResolved(input.resolved),
        target_digest: input.targetDigest,
        nonce: newNonce(),
        revision: 0,
        reason: input.reason,
        requested_by_agent_id: input.requestedBy.agentId,
        requested_by_thread_id: input.requestedBy.threadId,
        provenance_json: yield* encodeProvenance(input.provenance),
        required_approvers_json: yield* encodeApprovers([{ role: "owner" }]),
        state: "awaiting_approval",
        state_reason: null,
        created_at: now,
        updated_at: now,
        expires_at: now + AWAITING_TTL_MS,
      };
      // Decoding the full record validates it before it reaches the table.
      const action = yield* toAction(row);
      const created = yield* sql.withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql`
            INSERT INTO kin_pending_actions ${sql.insert(row)}
            ON CONFLICT (org_id, idempotency_key) DO NOTHING
            RETURNING action_id`;
          if (inserted.length === 0) return false;
          yield* audit.append({
            orgId: action.orgId,
            event: "action_requested",
            ...(yield* auditFacts(row)),
            target: action.target,
            provenance: action.provenance,
          });
          return true;
        }),
      );
      if (created) return { action, created: true };
      const [existing] = yield* sql<ActionRow>`SELECT * FROM kin_pending_actions
        WHERE org_id = ${input.orgId} AND idempotency_key = ${idempotencyKey}`;
      if (existing === undefined) {
        return yield* new PersistenceDecodeError({
          operation: "KinPendingActions.create",
          issue: "idempotency conflict without a stored action",
        });
      }
      return { action: yield* toAction(existing), created: false };
    },
    Effect.mapError(toError("KinPendingActions.create")),
  );

  const refresh = Effect.fn("KinPendingActions.refresh")(
    function* (
      input: RevisionRef & { readonly resolved: KinResolvedTarget; readonly targetDigest: Hex64 },
    ) {
      const now = yield* Clock.currentTimeMillis;
      const resolvedJson = yield* encodeResolved(input.resolved);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<ActionRow>`UPDATE kin_pending_actions
            SET resolved_json = ${resolvedJson}, target_digest = ${input.targetDigest},
              nonce = ${newNonce()}, revision = revision + 1, updated_at = ${now}
            WHERE org_id = ${input.orgId} AND action_id = ${input.actionId}
              AND state = 'awaiting_approval' AND revision = ${input.revision}
              AND expires_at > ${now}
            RETURNING *`;
          if (row === undefined) return Option.none();
          yield* audit.append({
            orgId: input.orgId,
            event: "action_refreshed",
            ...(yield* auditFacts(row)),
          });
          return Option.some(yield* toAction(row));
        }),
      );
    },
    Effect.mapError(toError("KinPendingActions.refresh")),
  );

  const transition = Effect.fn("KinPendingActions.transition")(
    function* (
      input: RevisionRef & {
        readonly to: "rejected" | "cancelled" | "expired" | "voided";
        readonly reason?: string;
        readonly sessionId?: AuthSessionId;
      },
    ) {
      const from = input.to === "voided" ? "approved" : "awaiting_approval";
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<FactsRow>`UPDATE kin_pending_actions
            SET state = ${input.to}, state_reason = ${input.reason ?? null}, updated_at = ${now}
            WHERE org_id = ${input.orgId} AND action_id = ${input.actionId}
              AND state = ${from} AND revision = ${input.revision}
              AND (${input.to} != 'expired' OR expires_at <= ${now})
            RETURNING action_id, kind, resolved_json`;
          if (row === undefined) return false;
          yield* audit.append({
            orgId: input.orgId,
            event: `action_${input.to}`,
            ...(yield* auditFacts(row)),
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            ...(input.reason === undefined ? {} : { result: input.reason }),
          });
          return true;
        }),
      );
    },
    Effect.mapError(toError("KinPendingActions.transition")),
  );

  const approve = Effect.fn("KinPendingActions.approve")(
    function* (
      input: RevisionRef & {
        readonly nonce: string;
        readonly jti: string;
        readonly approverHumanId: KinPersonId;
        readonly keyThumbprint: KinKeyThumbprint;
        readonly compact: string;
        readonly iat: number;
        readonly exp: number;
        readonly sessionId?: AuthSessionId;
        readonly deviceLabel?: string;
      },
    ) {
      const now = yield* Clock.currentTimeMillis;
      const grantId = `grt_${SecureRandom.ulidUnsafe()}`;
      const who = {
        grantJti: input.jti,
        keyThumbprint: input.keyThumbprint,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.deviceLabel === undefined ? {} : { deviceLabel: input.deviceLabel }),
      };
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const [inserted] = yield* sql`
              INSERT INTO kin_grants (grant_id, org_id, action_id, revision, jti, approver_human_id,
                key_thumbprint, compact, iat_s, exp_s, accepted_at)
              SELECT ${grantId}, org_id, action_id, ${input.revision}, ${input.jti},
                ${input.approverHumanId}, ${input.keyThumbprint}, ${input.compact}, ${input.iat},
                ${input.exp}, ${now}
              FROM kin_pending_actions WHERE org_id = ${input.orgId} AND action_id = ${input.actionId}
              ON CONFLICT DO NOTHING
              RETURNING grant_id`;
            if (inserted === undefined) {
              const [seen] = yield* sql`SELECT 1 FROM kin_grants
                WHERE org_id = ${input.orgId} AND (jti = ${input.jti} OR (action_id = ${input.actionId}
                  AND approver_human_id = ${input.approverHumanId}))`;
              return seen === undefined
                ? { _tag: "stale" as const }
                : { _tag: "replayed" as const };
            }
            const [won] = yield* sql<FactsRow>`UPDATE kin_pending_actions
              SET state = 'approved', updated_at = ${now}
              WHERE org_id = ${input.orgId} AND action_id = ${input.actionId}
                AND state = 'awaiting_approval' AND revision = ${input.revision}
                AND nonce = ${input.nonce} AND expires_at > ${now} AND ${input.exp} * 1000 > ${now}
              RETURNING action_id, kind, resolved_json`;
            if (won === undefined) return yield* new Rollback();
            yield* audit.append({
              orgId: input.orgId,
              event: "grant_accepted",
              ...(yield* auditFacts(won)),
              ...who,
            });
            const grant = yield* decodeGrant({
              id: grantId,
              orgId: input.orgId,
              actionId: input.actionId,
              revision: input.revision,
              jti: input.jti,
              approverHumanId: input.approverHumanId,
              keyThumbprint: input.keyThumbprint,
              compact: input.compact,
              iat: input.iat,
              exp: input.exp,
              acceptedAt: iso(now),
              consumedAt: null,
            });
            return { _tag: "approved" as const, grant };
          }),
        )
        .pipe(Effect.catchTags({ Rollback: () => Effect.succeed({ _tag: "stale" as const }) }));
      // A refused grant still leaves a trace (spec section 11), but only on the chain of the org
      // that owns the action: an unknown org or action stays `stale` and writes nothing.
      if (result._tag !== "approved") {
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const [owned] = yield* sql`SELECT 1 FROM kin_pending_actions
              WHERE org_id = ${input.orgId} AND action_id = ${input.actionId}`;
              if (owned === undefined) return;
              yield* audit.append({
                orgId: input.orgId,
                event: "grant_rejected",
                actionId: input.actionId,
                ...who,
                result: result._tag,
              });
            }),
          )
          .pipe(
            // The refusal is already decided; a lost trace must not turn it into an error.
            Effect.catch((error) =>
              Effect.logWarning("Kin audit: grant_rejected not written", error),
            ),
          );
      }
      return result;
    },
    Effect.mapError(toError("KinPendingActions.approve")),
  );

  const claim = Effect.fn("KinPendingActions.claim")(
    function* (input: RevisionRef & { readonly grantId: KinGrant["id"] }) {
      const now = yield* Clock.currentTimeMillis;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const claimed = yield* sql`
              INSERT INTO kin_executions (action_id, org_id, grant_id, started_at)
              SELECT action_id, org_id, grant_id, ${now} FROM kin_grants
              WHERE grant_id = ${input.grantId} AND org_id = ${input.orgId}
                AND action_id = ${input.actionId} AND revision = ${input.revision}
                AND consumed_at IS NULL
                AND MIN(exp_s * 1000, accepted_at + ${GRANT_ACCEPTED_TTL_MS}) > ${now}
              ON CONFLICT DO NOTHING
              RETURNING action_id`;
            if (claimed.length === 0) return false;
            const [won] = yield* sql<FactsRow>`UPDATE kin_pending_actions
              SET state = 'executing', updated_at = ${now}
              WHERE org_id = ${input.orgId} AND action_id = ${input.actionId}
                AND state = 'approved' AND revision = ${input.revision}
              RETURNING action_id, kind, resolved_json`;
            if (won === undefined) return yield* new Rollback();
            const [grant] = yield* sql<{ jti: string; key_thumbprint: KinKeyThumbprint }>`
              UPDATE kin_grants SET consumed_at = ${now} WHERE grant_id = ${input.grantId}
              RETURNING jti, key_thumbprint`;
            if (grant === undefined) return yield* new Rollback();
            yield* audit.append({
              orgId: input.orgId,
              event: "execution_started",
              ...(yield* auditFacts(won)),
              grantJti: grant.jti,
              keyThumbprint: grant.key_thumbprint,
            });
            return true;
          }),
        )
        .pipe(Effect.catchTags({ Rollback: () => Effect.succeed(false) }));
    },
    Effect.mapError(toError("KinPendingActions.claim")),
  );

  const finish = Effect.fn("KinPendingActions.finish")(
    function* (
      input: ActionRef & {
        readonly outcome: "succeeded" | "failed" | "interrupted";
        readonly githubRequestId?: string;
        readonly mergeCommitSha?: string;
        readonly error?: string;
        readonly reconciled?: boolean;
      },
    ) {
      const now = yield* Clock.currentTimeMillis;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const [won] = yield* sql<FactsRow>`UPDATE kin_pending_actions
              SET state = ${input.outcome}, state_reason = ${input.error ?? null}, updated_at = ${now}
              WHERE org_id = ${input.orgId} AND action_id = ${input.actionId} AND state = 'executing'
              RETURNING action_id, kind, resolved_json`;
            if (won === undefined) return false;
            const recorded = yield* sql`UPDATE kin_executions
              SET finished_at = ${now}, outcome = ${input.outcome},
                github_request_id = ${input.githubRequestId ?? null},
                merge_commit_sha = ${input.mergeCommitSha ?? null}, error = ${input.error ?? null}
              WHERE org_id = ${input.orgId} AND action_id = ${input.actionId} AND finished_at IS NULL
              RETURNING action_id`;
            if (recorded.length === 0) return yield* new Rollback();
            yield* audit.append({
              orgId: input.orgId,
              event: input.reconciled === true ? "execution_reconciled" : "execution_finished",
              ...(yield* auditFacts(won)),
              result:
                input.outcome === "succeeded"
                  ? (input.mergeCommitSha ?? "succeeded")
                  : `${input.outcome}: ${input.error ?? "no reason given"}`,
            });
            return true;
          }),
        )
        .pipe(Effect.catchTags({ Rollback: () => Effect.succeed(false) }));
    },
    Effect.mapError(toError("KinPendingActions.finish")),
  );

  const sweep = Effect.fn("KinPendingActions.sweep")(
    function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          type SweptRow = FactsRow & { org_id: KinOrgId; action_id: KinActionId };
          const expired = yield* sql<SweptRow>`
            UPDATE kin_pending_actions SET state = 'expired', state_reason = 'expired',
              updated_at = ${now}
            WHERE state = 'awaiting_approval' AND expires_at <= ${now}
            RETURNING org_id, action_id, kind, resolved_json`;
          const voided = yield* sql<SweptRow>`
            UPDATE kin_pending_actions SET state = 'voided', state_reason = 'grant_expired',
              updated_at = ${now}
            WHERE state = 'approved' AND EXISTS (
              SELECT 1 FROM kin_grants g
              WHERE g.action_id = kin_pending_actions.action_id
                AND g.revision = kin_pending_actions.revision AND g.consumed_at IS NULL
                AND MIN(g.exp_s * 1000, g.accepted_at + ${GRANT_ACCEPTED_TTL_MS}) <= ${now})
            RETURNING org_id, action_id, kind, resolved_json`;
          const record = (event: "action_expired" | "action_voided", result: string) =>
            Effect.forEach(
              event === "action_expired" ? expired : voided,
              (row) =>
                auditFacts(row).pipe(
                  Effect.flatMap((facts) =>
                    audit.append({ orgId: row.org_id, event, ...facts, result }),
                  ),
                ),
              { discard: true },
            );
          yield* record("action_expired", "expired");
          yield* record("action_voided", "grant_expired");
          const refs = (rows: ReadonlyArray<SweptRow>) =>
            rows.map((row) => ({ orgId: row.org_id, actionId: row.action_id }));
          return { expired: refs(expired), voided: refs(voided) };
        }),
      );
    },
    Effect.mapError(toError("KinPendingActions.sweep")),
  );

  return KinPendingActions.of({ create, get, refresh, transition, approve, claim, finish, sweep });
});

const isDecodeError = Schema.is(PersistenceDecodeError);
function toError(operation: string) {
  return (cause: unknown): Errors =>
    isDecodeError(cause)
      ? cause
      : Schema.isSchemaError(cause)
        ? PersistenceDecodeError.fromSchemaError(operation, cause)
        : toPersistenceSqlError(operation)(cause);
}

export const layer = Layer.effect(KinPendingActions, make);

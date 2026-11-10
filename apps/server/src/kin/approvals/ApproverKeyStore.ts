// @effect-diagnostics nodeBuiltinImport:off -- synchronous SHA-256 for the confirmation's challenge.
import * as NodeCrypto from "node:crypto";

import {
  KinApprovalError,
  KinApproverKey,
  type KinKeyThumbprint,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { revokedBySession } from "../auth/ProofKeySessions.ts";
import { KinKeySeal } from "./KeySeal.ts";

/** How long the phone's code works, and how many tries it gets (spec section 4). */
const CONFIRM_TTL_MS = 10 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;

export type KeyRef = { readonly orgId: KinOrgId; readonly thumbprint: KinKeyThumbprint };

export type KeyRow = {
  readonly thumbprint: string;
  readonly org_id: string;
  readonly public_jwk_json: string;
  readonly human_id: string;
  readonly device_label: string;
  readonly platform: string;
  readonly hardware: string;
  readonly attested: number;
  readonly session_id: string | null;
  readonly proof_key_thumbprint: string | null;
  readonly state: string;
  readonly created_at: number;
  readonly confirmed_at: number | null;
  readonly revoked_at: number | null;
  readonly seal: string | null;
};

export type ConfirmationRow = {
  readonly org_id: string;
  readonly thumbprint: string;
  readonly session_id: string;
  readonly challenge_sha256: string;
  readonly verifier: string;
  readonly attempts: number;
  readonly created_at: number;
  readonly expires_at: number;
};

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const decodeKey = Schema.decodeUnknownEffect(KinApproverKey);
const isKinApprovalError = Schema.is(KinApprovalError);

const challengeSha256 = (challenge: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(challenge).digest("hex");

export const sealFields = (row: KeyRow) => ({
  orgId: row.org_id,
  thumbprint: row.thumbprint,
  publicJwkJson: row.public_jwk_json,
  humanId: row.human_id,
  hardware: row.hardware,
});

/** `attested` holds for an active key only while the seal written at activation verifies. */
const toKeyWith = (row: KeyRow, sealed: boolean) =>
  decodeKey({
    orgId: row.org_id,
    thumbprint: row.thumbprint,
    publicJwk: JSON.parse(row.public_jwk_json),
    humanId: row.human_id,
    deviceLabel: row.device_label,
    platform: row.platform,
    hardware: row.hardware,
    attested: row.attested === 1 && (row.state !== "active" || sealed),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    state: row.state,
    createdAt: iso(row.created_at),
    ...(row.confirmed_at === null ? {} : { confirmedAt: iso(row.confirmed_at) }),
    ...(row.revoked_at === null ? {} : { revokedAt: iso(row.revoked_at) }),
  });

/** Callers see a plain refusal; the cause is logged through the persistence error shape. */
export const internal = (operation: string) => (cause: unknown) =>
  isKinApprovalError(cause)
    ? Effect.fail(cause)
    : Effect.logWarning(`${operation} failed`, toPersistenceSqlError(operation)(cause)).pipe(
        Effect.andThen(
          Effect.fail(
            new KinApprovalError({ reason: "unavailable", message: `${operation} failed.` }),
          ),
        ),
      );

/**
 * The key rows' SQL, shared by the server's `ApproverKeys` and the host's `kin approvals` CLI,
 * which opens the same database from another process. Nothing here is cached in memory.
 */
export const makeKeyStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const seal = yield* KinKeySeal;

  const toKey = Effect.fn("ApproverKeyStore.toKey")(function* (row: KeyRow) {
    if (row.state !== "active" || row.attested !== 1) return yield* toKeyWith(row, false);
    const sealed = seal.verify(sealFields(row), row.seal);
    // Only a write that skipped the server, such as one straight into SQLite, leaves this.
    if (!sealed)
      yield* Effect.logWarning("Kin approver key's seal doesn't verify; it can't sign.", {
        orgId: row.org_id,
        thumbprint: row.thumbprint,
      });
    return yield* toKeyWith(row, sealed);
  });

  const select = (ref: KeyRef) =>
    sql<KeyRow>`SELECT * FROM kin_approver_keys
      WHERE org_id = ${ref.orgId} AND thumbprint = ${ref.thumbprint}`.pipe(
      Effect.map((rows) => rows[0]),
    );

  const hasActiveKey = (orgId: KinOrgId) =>
    sql`SELECT 1 FROM kin_approver_keys WHERE org_id = ${orgId} AND state = 'active' LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  const deleteConfirmation = (ref: { readonly orgId: string; readonly thumbprint: string }) =>
    sql`DELETE FROM kin_approver_key_confirmations
      WHERE org_id = ${ref.orgId} AND thumbprint = ${ref.thumbprint}`;

  /** The UPDATE that makes a pending attested key active, sealing exactly the row it read. */
  const activate = Effect.fn("ApproverKeyStore.activate")(function* (
    row: KeyRow,
    now: number,
    onlyFirst: boolean,
  ) {
    const [active] = yield* sql<KeyRow>`UPDATE kin_approver_keys
        SET state = 'active', confirmed_at = ${now}, seal = ${seal.seal(sealFields(row))}
        WHERE org_id = ${row.org_id} AND thumbprint = ${row.thumbprint}
          AND state = 'pending' AND attested = 1
          AND public_jwk_json = ${row.public_jwk_json} AND human_id = ${row.human_id}
          AND hardware = ${row.hardware}
          AND ${
            onlyFirst
              ? sql`NOT EXISTS (SELECT 1 FROM kin_approver_keys
                  WHERE org_id = ${row.org_id} AND state = 'active')`
              : sql`1 = 1`
          }
        RETURNING *`;
    if (active !== undefined)
      yield* deleteConfirmation({ orgId: row.org_id, thumbprint: row.thumbprint });
    return active;
  });

  /** Stored with the pending key, so the host CLI can check the phone's code later. */
  const saveConfirmation = (input: {
    readonly row: KeyRow;
    readonly sessionId: string;
    readonly challenge: Uint8Array;
    readonly code: string;
    readonly now: number;
  }) => {
    const hash = challengeSha256(input.challenge);
    const verifier = seal.confirmation({
      ...sealFields(input.row),
      sessionId: input.sessionId,
      challengeSha256: hash,
      code: input.code,
    });
    return sql`INSERT INTO kin_approver_key_confirmations ${sql.insert({
      org_id: input.row.org_id,
      thumbprint: input.row.thumbprint,
      session_id: input.sessionId,
      challenge_sha256: hash,
      verifier,
      attempts: 0,
      created_at: input.now,
      expires_at: input.now + CONFIRM_TTL_MS,
    })}`;
  };

  /** Sets `revoked`, voids approved actions this key signed, cancels its pending registration. */
  const revokeRow = (ref: KeyRef, reason: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const [row] = yield* sql<KeyRow>`UPDATE kin_approver_keys
          SET state = 'revoked', revoked_at = ${now}, seal = NULL
          WHERE org_id = ${ref.orgId} AND thumbprint = ${ref.thumbprint} AND state != 'revoked'
          RETURNING *`;
        if (row === undefined) return undefined;
        yield* sql`UPDATE kin_pending_actions
          SET state = 'voided', state_reason = ${reason}, updated_at = ${now}
          WHERE org_id = ${ref.orgId} AND state = 'approved' AND EXISTS (
            SELECT 1 FROM kin_grants g
            WHERE g.action_id = kin_pending_actions.action_id
              AND g.revision = kin_pending_actions.revision
              AND g.key_thumbprint = ${ref.thumbprint} AND g.consumed_at IS NULL)`;
        yield* cancelEnrolment(ref, reason, now);
        yield* deleteConfirmation(ref);
        return row;
      }),
    );

  /** Ends a key's pending `register_approver_key` action; its card closes on the next pass. */
  const cancelEnrolment = (ref: KeyRef, reason: string, now: number) =>
    sql`UPDATE kin_pending_actions
      SET state = 'cancelled', state_reason = ${reason}, updated_at = ${now}
      WHERE org_id = ${ref.orgId} AND kind = 'register_approver_key'
        AND state = 'awaiting_approval'
        AND json_extract(target_json, '$.thumbprint') = ${ref.thumbprint}`;

  // T3 revokes sessions in SessionStore (revokeClient, revokeOtherClients, managed policy).
  // Reading its table here keeps auth free of Kin hooks, and runs before every key is trusted.
  // Relay sessions renew under new ids, so the DPoP key's own revocations count too (spec section 4).
  const reconcileSessions = Effect.fn("ApproverKeyStore.reconcileSessions")(function* (
    orgId: KinOrgId | undefined,
  ) {
    const rows = yield* sql<{ org_id: KinOrgId; thumbprint: KinKeyThumbprint }>`
      SELECT k.org_id, k.thumbprint FROM kin_approver_keys k
      WHERE k.state != 'revoked' AND ${orgId === undefined ? sql`1 = 1` : sql`k.org_id = ${orgId}`}
        AND ${revokedBySession(
          sql,
          { sessionId: sql`k.session_id`, proofKey: sql`k.proof_key_thumbprint` },
          { since: sql`k.created_at` },
        )}
      ORDER BY k.org_id, k.thumbprint`;
    for (const row of rows) {
      yield* revokeRow({ orgId: row.org_id, thumbprint: row.thumbprint }, "session_revoked");
    }
    return rows.length;
  });

  return {
    sql,
    seal,
    toKey,
    select,
    hasActiveKey,
    activate,
    saveConfirmation,
    deleteConfirmation,
    revokeRow,
    cancelEnrolment,
    reconcileSessions,
  };
});

export type KeyStore = Effect.Success<typeof makeKeyStore>;

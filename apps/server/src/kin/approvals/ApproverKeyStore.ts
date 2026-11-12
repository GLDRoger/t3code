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
import { KinAudit } from "./Audit.ts";
import { KinKeySeal } from "./KeySeal.ts";
import { KinPendingActions } from "./PendingActions.ts";

/** Phones that can approve at once in one org; past it, the owner removes one first. */
export const MAX_ACTIVE_KEYS = 10;

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

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const decodeKey = Schema.decodeUnknownEffect(KinApproverKey);
const isKinApprovalError = Schema.is(KinApprovalError);

export const sealFields = (row: KeyRow) => ({
  orgId: row.org_id,
  thumbprint: row.thumbprint,
  publicJwkJson: row.public_jwk_json,
  humanId: row.human_id,
  hardware: row.hardware,
  createdAt: row.created_at,
});

/** `attested` holds for an active key only while its seal verifies. */
const toKeyWith = (row: KeyRow, sealed: boolean, lastUsedAt: number | null) =>
  decodeKey({
    orgId: row.org_id,
    thumbprint: row.thumbprint,
    publicJwk: JSON.parse(row.public_jwk_json),
    humanId: row.human_id,
    deviceLabel: row.device_label,
    platform: row.platform,
    hardware: row.hardware,
    attested: row.attested === 1 && (row.state === "revoked" || sealed),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    state: row.state,
    createdAt: iso(row.created_at),
    ...(row.confirmed_at === null ? {} : { confirmedAt: iso(row.confirmed_at) }),
    ...(row.revoked_at === null ? {} : { revokedAt: iso(row.revoked_at) }),
    ...(lastUsedAt === null ? {} : { lastUsedAt: iso(lastUsedAt) }),
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

/** The key rows' SQL. Nothing here is cached in memory. */
export const makeKeyStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const seal = yield* KinKeySeal;
  const actions = yield* KinPendingActions;
  const audit = yield* KinAudit;

  const toKey = Effect.fn("ApproverKeyStore.toKey")(function* (
    row: KeyRow,
    lastUsedAt: number | null = null,
  ) {
    if (row.state === "revoked" || row.attested !== 1)
      return yield* toKeyWith(row, false, lastUsedAt);
    const sealed = seal.verify(sealFields(row), row.seal);
    // Only a write that skipped the server, such as one straight into SQLite, leaves this.
    if (!sealed)
      yield* Effect.logWarning("Kin approver key's seal doesn't verify; it can't sign.", {
        orgId: row.org_id,
        thumbprint: row.thumbprint,
      });
    return yield* toKeyWith(row, sealed, lastUsedAt);
  });

  /** Rows from the old allow-from-Settings flow that never activated are closed at start. */
  const select = (ref: KeyRef) =>
    sql<KeyRow>`SELECT * FROM kin_approver_keys
      WHERE org_id = ${ref.orgId} AND thumbprint = ${ref.thumbprint} AND state != 'pending'`.pipe(
      Effect.map((rows) => rows[0]),
    );

  const activeCount = (orgId: KinOrgId) =>
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_approver_keys
      WHERE org_id = ${orgId} AND state = 'active'`.pipe(Effect.map((rows) => rows[0]?.n ?? 0));

  /** Sets `revoked` and voids what this key signed that hasn't started writing, in one transaction. */
  const revokeRow = (ref: KeyRef, reason: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const [row] = yield* sql<KeyRow>`UPDATE kin_approver_keys
          SET state = 'revoked', revoked_at = ${now}, seal = NULL
          WHERE org_id = ${ref.orgId} AND thumbprint = ${ref.thumbprint} AND state != 'revoked'
          RETURNING *`;
        if (row === undefined) return undefined;
        yield* actions.voidKeyClaims({ orgId: ref.orgId, thumbprint: ref.thumbprint, reason });
        return row;
      }),
    );

  // T3 revokes sessions in SessionStore (revokeClient, revokeOtherClients, managed policy).
  // Reading its table here keeps auth free of Kin hooks, and runs before every key is trusted.
  // Relay sessions renew under new ids, so the DPoP key's own revocations count too (spec section 4).
  const reconcileSessions = Effect.fn("ApproverKeyStore.reconcileSessions")(function* (
    orgId: KinOrgId | undefined,
  ) {
    const rows = yield* sql<{ org_id: KinOrgId; thumbprint: KinKeyThumbprint }>`
      SELECT k.org_id, k.thumbprint FROM kin_approver_keys k
      WHERE k.state = 'active' AND ${orgId === undefined ? sql`1 = 1` : sql`k.org_id = ${orgId}`}
        AND ${revokedBySession(
          sql,
          { sessionId: sql`k.session_id`, proofKey: sql`k.proof_key_thumbprint` },
          { since: sql`k.created_at` },
        )}
      ORDER BY k.org_id, k.thumbprint`;
    for (const row of rows) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const ref = { orgId: row.org_id, thumbprint: row.thumbprint };
          const revoked = yield* revokeRow(ref, "session_revoked");
          if (revoked === undefined) return;
          yield* audit.append({
            orgId: row.org_id,
            event: "key_revoked",
            keyThumbprint: row.thumbprint,
            deviceLabel: revoked.device_label,
            result: "the session it was set up from was signed out",
          });
        }),
      );
    }
    return rows.length;
  });

  return { sql, seal, toKey, select, activeCount, revokeRow, reconcileSessions };
});

export type KeyStore = Effect.Success<typeof makeKeyStore>;

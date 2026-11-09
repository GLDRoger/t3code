import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Context from "effect/Context";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import type { AuthSessionId } from "@t3tools/contracts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as Ref from "effect/Ref";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as KinEnabled from "../KinEnabled.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { SessionHooks } from "./sessionHooks.ts";

type Column = Statement.Fragment | string | number;
/**
 * Repaired revocations don't count, except ones at or after `since` (epoch ms): a repair re-trusts
 * a proof key, never an approver key registered before the revocation (approvals spec section 4).
 */
type RevocationOptions = { readonly since?: Column };

// `individually_revoked`: 0 none; 1 blocks only if `revoked_at <= expires_at`; 2 blocks unconditionally
// (bulk sign-out, or a revoke that killed an active session).
const GUARDED_BLOCK = 1;
const UNCONDITIONAL_BLOCK = 2;

// `auth_sessions` stores ISO-8601 UTC text; Kin stores integer milliseconds.
const epochMillis = (sql: SqlClient.SqlClient, iso: Statement.Fragment) =>
  sql`CAST(ROUND((julianday(${iso}) - 2440587.5) * 86400000) AS INTEGER)`;

const unrepaired = (sql: SqlClient.SqlClient, options: RevocationOptions) =>
  options.since === undefined
    ? sql`m.repaired_at IS NULL`
    : sql`(m.repaired_at IS NULL OR ${epochMillis(sql, sql`s.revoked_at`)} >= ${options.since})`;

// Readers of `individually_revoked` test `!= 0` and apply the expiry guard only to 1.
const marked = (sql: SqlClient.SqlClient, options: RevocationOptions) =>
  sql`m.individually_revoked != 0 AND ${unrepaired(sql, options)}
      AND (m.individually_revoked != ${GUARDED_BLOCK} OR s.revoked_at <= s.expires_at)`;

/**
 * A revocation reaches a proof key when its mapping is marked (bulk sign-out never marks the
 * caller's own key), passes the expiry guard for 1, and isn't repaired (see `RevocationOptions`).
 */
export const proofKeyRevoked = (
  sql: SqlClient.SqlClient,
  proofKey: Column,
  options: RevocationOptions = {},
) =>
  sql`EXISTS (SELECT 1 FROM kin_auth_session_keys m JOIN auth_sessions s ON s.session_id = m.session_id
    WHERE m.proof_key_thumbprint = ${proofKey} AND s.revoked_at IS NOT NULL AND ${marked(sql, options)})`;

/**
 * Whether a revocation reached something registered from `sessionId` under `proofKey`: that
 * session's own (an unmapped one counts unless after expiry), or any of its proof key's.
 */
export const revokedBySession = (
  sql: SqlClient.SqlClient,
  row: { readonly sessionId: Column; readonly proofKey: Column },
  options: RevocationOptions = {},
) =>
  sql`(EXISTS (SELECT 1 FROM auth_sessions s LEFT JOIN kin_auth_session_keys m ON m.session_id = s.session_id
    WHERE s.session_id = ${row.sessionId} AND s.revoked_at IS NOT NULL
      AND ((m.session_id IS NULL AND s.revoked_at <= s.expires_at) OR (${marked(sql, options)})))
    OR ${proofKeyRevoked(sql, row.proofKey, options)})`;

const enabled = Layer.effect(
  SessionHooks,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const blocked = Effect.fn("ProofKeySessions.blocked")(
      function* (thumbprint: string) {
        const [row] = yield* sql<{
          blocked: number;
        }>`SELECT ${proofKeyRevoked(sql, thumbprint)} AS blocked`;
        return row?.blocked === 1;
      },
      Effect.mapError(toPersistenceSqlError("ProofKeySessions.blocked")),
    );
    const hooks = {
      recordRepair: Effect.fn("ProofKeySessions.recordRepair")(
        function* (thumbprint: string, linkId: string) {
          const now = yield* DateTime.now;
          yield* sql`INSERT INTO kin_auth_key_repairs (thumbprint, pairing_link_id, created_at) VALUES (${thumbprint}, ${linkId}, ${now.epochMilliseconds}) ON CONFLICT(pairing_link_id) DO NOTHING RETURNING pairing_link_id`;
        },
        Effect.mapError(toPersistenceSqlError("ProofKeySessions.recordRepair")),
      ),
      onIssue: Effect.fn("ProofKeySessions.onIssue")(
        function* (sessionId: AuthSessionId, thumbprint: string) {
          const now = yield* DateTime.now;
          yield* sql`INSERT INTO kin_auth_session_keys (session_id, proof_key_thumbprint, created_at)
        VALUES (${sessionId}, ${thumbprint}, ${now.epochMilliseconds})
        ON CONFLICT(session_id) DO NOTHING RETURNING session_id`;
        },
        (effect, sessionId) =>
          effect.pipe(
            Effect.mapError(toPersistenceSqlError("ProofKeySessions.onIssue")),
            Effect.mapError(
              (cause) => new SessionStore.SessionCredentialIssueError({ sessionId, cause }),
            ),
          ),
      ),
      afterIssue: Effect.fn("ProofKeySessions.afterIssue")(
        function* (sessionId: AuthSessionId, thumbprint: string) {
          // Serializing the check with revocation covers either ordering of the session insert.
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              if (yield* blocked(thumbprint)) {
                const now = yield* DateTime.now;
                yield* sql`UPDATE auth_sessions SET revoked_at = ${DateTime.formatIso(now)}
            WHERE session_id = ${sessionId} AND revoked_at IS NULL`;
                return true;
              }
              return false;
            }),
          );
        },
        (effect, sessionId) =>
          effect.pipe(
            Effect.mapError(toPersistenceSqlError("ProofKeySessions.afterIssue")),
            Effect.mapError(
              (cause) => new SessionStore.SessionCredentialIssueError({ sessionId, cause }),
            ),
          ),
      ),
      checkExchange: Effect.fn("ProofKeySessions.checkExchange")(function* (
        thumbprint: string | undefined,
        grant: Parameters<Context.Service.Shape<typeof SessionHooks>["checkExchange"]>[1],
      ) {
        if (!thumbprint) return true;
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (
                grant.method === "one-time-token" &&
                grant.proofKeyThumbprint === thumbprint &&
                grant.pairingLinkId
              ) {
                const now = yield* DateTime.now;
                const repairs =
                  yield* sql`UPDATE kin_auth_key_repairs SET consumed_at = ${now.epochMilliseconds}
            WHERE thumbprint = ${thumbprint} AND pairing_link_id = ${grant.pairingLinkId}
              AND consumed_at IS NULL RETURNING pairing_link_id`;
                if (repairs.length > 0)
                  yield* sql`UPDATE kin_auth_session_keys SET repaired_at = ${now.epochMilliseconds}
            WHERE proof_key_thumbprint = ${thumbprint} AND individually_revoked != 0
              AND session_id IN (SELECT session_id FROM auth_sessions WHERE revoked_at IS NOT NULL)`;
              }
              return !(yield* blocked(thumbprint));
            }),
          )
          .pipe(Effect.mapError(toPersistenceSqlError("ProofKeySessions.checkExchange")));
      }),
    };
    return SessionHooks.of({
      recordRepair: hooks.recordRepair,
      checkExchange: hooks.checkExchange,
      wrap: (notifications) => (store) => {
        const removed = (sessionId: AuthSessionId) =>
          Ref.update(notifications.connectedSessionsRef, (current) => {
            const next = new Map(current);
            next.delete(sessionId);
            return next;
          }).pipe(Effect.andThen(notifications.emitRemoved(sessionId)));
        const revoke = (sessionId: AuthSessionId, bulk: boolean, callerSessionId?: AuthSessionId) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const now = yield* DateTime.now;
                // Upstream keeps an expired session active while it stays connected.
                const connected = sql.in([
                  ...(yield* Ref.get(notifications.connectedSessionsRef)).keys(),
                ]);
                const active = sql`SELECT session_id FROM auth_sessions WHERE expires_at >= ${DateTime.formatIso(now)} OR session_id IN ${connected}`;
                const keyOf = (id: AuthSessionId | null) =>
                  sql`SELECT proof_key_thumbprint FROM kin_auth_session_keys WHERE session_id = ${id}`;
                const caller = bulk ? sessionId : (callerSessionId ?? null);
                // A caller never signs itself out or blocks the key it is signed in with.
                const notCallerKey = sql`proof_key_thumbprint IS NOT (${keyOf(caller)})`;
                const selected = bulk
                  ? sql<{
                      session_id: AuthSessionId;
                    }>`SELECT session_id FROM auth_sessions WHERE session_id != ${sessionId} AND revoked_at IS NULL`
                  : sql<{
                      session_id: AuthSessionId;
                    }>`SELECT s.session_id FROM auth_sessions s LEFT JOIN kin_auth_session_keys m ON m.session_id = s.session_id
              WHERE s.revoked_at IS NULL AND s.session_id IS NOT ${caller} AND (s.session_id = ${sessionId}
                OR (m.proof_key_thumbprint = (${keyOf(sessionId)}) AND s.session_id IN (${active})))`;
                const blockedKeys = bulk
                  ? sql`SELECT proof_key_thumbprint FROM kin_auth_session_keys
              WHERE session_id != ${sessionId} AND ${notCallerKey}`
                  : sql`SELECT proof_key_thumbprint FROM kin_auth_session_keys
              WHERE session_id IN (${selected}) AND individually_revoked = ${UNCONDITIONAL_BLOCK} AND ${notCallerKey}`;
                if (bulk) {
                  yield* sql`UPDATE kin_auth_session_keys SET individually_revoked = ${UNCONDITIONAL_BLOCK}, repaired_at = NULL
              WHERE proof_key_thumbprint IN (${blockedKeys})`;
                } else {
                  yield* sql`UPDATE kin_auth_session_keys SET individually_revoked =
                CASE WHEN session_id IN (${active}) THEN ${UNCONDITIONAL_BLOCK} ELSE ${GUARDED_BLOCK} END
              WHERE session_id IN (${selected}) AND ${notCallerKey}`;
                }
                // A repair link issued before this block must not lift it.
                yield* sql`UPDATE kin_auth_key_repairs SET consumed_at = ${now.epochMilliseconds}
              WHERE consumed_at IS NULL AND thumbprint IN (${blockedKeys})`;
                return yield* sql<{
                  session_id: AuthSessionId;
                }>`UPDATE auth_sessions SET revoked_at = ${DateTime.formatIso(now)} WHERE session_id IN (${selected}) AND revoked_at IS NULL RETURNING session_id`;
              }),
            )
            .pipe(
              Effect.tap((ids) =>
                Effect.forEach(ids, (row) => removed(row.session_id), { discard: true }),
              ),
              Effect.uninterruptible,
            );
        return {
          ...store,
          issue: Effect.fn("ProofKeySessions.issue")(function* (input) {
            return yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const issued = yield* store.issue(input);
                  let revoked = false;
                  if (input?.proofKeyThumbprint) {
                    yield* hooks.onIssue(issued.sessionId, input.proofKeyThumbprint);
                    revoked = yield* hooks.afterIssue(issued.sessionId, input.proofKeyThumbprint);
                  }
                  return { issued, revoked };
                }),
              )
              .pipe(
                Effect.tap(({ issued, revoked }) =>
                  revoked ? removed(issued.sessionId) : Effect.void,
                ),
                Effect.flatMap(({ issued, revoked }) =>
                  revoked
                    ? Effect.fail(
                        new SessionStore.SessionCredentialIssueError({
                          sessionId: issued.sessionId,
                          cause: new Error("Proof key is revoked"),
                        }),
                      )
                    : Effect.succeed(issued),
                ),
                Effect.uninterruptible,
                Effect.mapError((cause) =>
                  cause._tag === "SessionCredentialIssueError"
                    ? cause
                    : new SessionStore.SessionCredentialIssueError({
                        cause: toPersistenceSqlError("ProofKeySessions.issue")(cause),
                      }),
                ),
              );
          }),
          revoke: Effect.fn("ProofKeySessions.revoke")((sessionId, callerSessionId) =>
            revoke(sessionId, false, callerSessionId).pipe(
              Effect.map((ids) => ids.some((row) => row.session_id === sessionId)),
              Effect.mapError(
                (cause) =>
                  new SessionStore.SessionRevocationError({
                    sessionId,
                    cause: toPersistenceSqlError("ProofKeySessions.revoke")(cause),
                  }),
              ),
            ),
          ),
          revokeAllExcept: Effect.fn("ProofKeySessions.revokeAllExcept")((sessionId) =>
            revoke(sessionId, true).pipe(
              Effect.map((ids) => ids.length),
              Effect.mapError(
                (cause) =>
                  new SessionStore.OtherSessionsRevocationError({
                    currentSessionId: sessionId,
                    cause: toPersistenceSqlError("ProofKeySessions.revokeAllExcept")(cause),
                  }),
              ),
            ),
          ),
        };
      },
    });
  }),
);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* KinEnabled.KinEnabled;
    // A failed enabled store must fail layer construction, never select the no-op reference.
    return config.enabled ? enabled.pipe(Layer.provide(KinPersistence.layer)) : Layer.empty;
  }),
).pipe(Layer.provide(KinEnabled.layer));

export const layerCli = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* KinEnabled.KinEnabled;
    if (config.enabled) return enabled.pipe(Layer.provide(KinPersistence.layer));
    const sql = yield* SqlClient.SqlClient;
    const tables =
      yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kin_auth_session_keys' LIMIT 1`;
    return tables.length > 0 ? enabled : Layer.empty;
  }),
).pipe(Layer.provide(KinEnabled.layer));

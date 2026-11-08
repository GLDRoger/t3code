import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Context from "effect/Context";
import * as SqlClient from "effect/sql/SqlClient";
import type { AuthSessionId } from "@t3tools/contracts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as KinEnabled from "../KinEnabled.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { SessionHooks } from "./sessionHooks.ts";

const enabled = Layer.effect(
  SessionHooks,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const blocked = Effect.fn("ProofKeySessions.blocked")(
      function* (thumbprint: string) {
        const rows =
          yield* sql`SELECT 1 FROM kin_auth_session_keys m JOIN auth_sessions s ON s.session_id = m.session_id
      WHERE m.proof_key_thumbprint = ${thumbprint} AND m.individually_revoked = 1 AND m.repaired_at IS NULL
        AND s.revoked_at IS NOT NULL AND s.revoked_at <= s.expires_at LIMIT 1`;
        return rows.length > 0;
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
          yield* sql.withTransaction(
            Effect.gen(function* () {
              if (yield* blocked(thumbprint)) {
                const now = yield* DateTime.now;
                yield* sql`UPDATE auth_sessions SET revoked_at = ${DateTime.formatIso(now)}
            WHERE session_id = ${sessionId} AND revoked_at IS NULL`;
              }
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
      revoke: (original: SessionStore.SessionStore["Service"]["revoke"]) =>
        Effect.fn("ProofKeySessions.revoke")(function* (sessionId: AuthSessionId) {
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const mapped = yield* sql<{
                  proof_key_thumbprint: string;
                }>`SELECT proof_key_thumbprint FROM kin_auth_session_keys WHERE session_id = ${sessionId}`;
                if (!mapped[0]) return yield* original(sessionId);
                yield* sql`UPDATE kin_auth_session_keys SET individually_revoked = 1
          WHERE session_id = ${sessionId} AND EXISTS (SELECT 1 FROM auth_sessions
            WHERE session_id = ${sessionId} AND revoked_at IS NULL)`;
                const now = yield* DateTime.now;
                const ids = yield* sql<{
                  session_id: AuthSessionId;
                }>`SELECT s.session_id FROM auth_sessions s
          JOIN kin_auth_session_keys m ON s.session_id = m.session_id
          WHERE m.proof_key_thumbprint = ${mapped[0].proof_key_thumbprint} AND s.revoked_at IS NULL
            AND s.expires_at > ${DateTime.formatIso(now)}`;
                const revoked = yield* original(sessionId);
                yield* Effect.forEach(
                  ids.filter((row) => row.session_id !== sessionId),
                  (row) => original(row.session_id),
                  { discard: true },
                );
                return revoked;
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                cause._tag === "SessionRevocationError"
                  ? cause
                  : new SessionStore.SessionRevocationError({
                      sessionId,
                      cause: toPersistenceSqlError("ProofKeySessions.revoke")(cause),
                    }),
              ),
            );
        }),
      checkExchange: Effect.fn("ProofKeySessions.checkExchange")(function* (
        thumbprint: string | undefined,
        grant: Parameters<Context.Service.Shape<typeof SessionHooks>["checkExchange"]>[1],
      ) {
        if (!thumbprint) return;
        const allowed = yield* sql
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
            WHERE proof_key_thumbprint = ${thumbprint} AND individually_revoked = 1
              AND session_id IN (SELECT session_id FROM auth_sessions WHERE revoked_at IS NOT NULL)`;
              }
              return !(yield* blocked(thumbprint));
            }),
          )
          .pipe(
            Effect.mapError(toPersistenceSqlError("ProofKeySessions.checkExchange")),
            Effect.mapError(
              (cause) =>
                new EnvironmentAuth.ServerAuthAuthenticatedAccessTokenIssueError({ cause }),
            ),
          );
        if (!allowed) return yield* new EnvironmentAuth.ServerAuthInvalidCredentialError({});
      }),
    };
    return SessionHooks.of({
      recordRepair: hooks.recordRepair,
      checkExchange: hooks.checkExchange,
      wrap: (store) => ({
        ...store,
        issue: Effect.fn("ProofKeySessions.issue")(function* (input) {
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const issued = yield* store.issue(input);
                if (input?.proofKeyThumbprint) {
                  yield* hooks.onIssue(issued.sessionId, input.proofKeyThumbprint);
                  yield* hooks.afterIssue(issued.sessionId, input.proofKeyThumbprint);
                }
                return issued;
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                cause._tag === "SessionCredentialIssueError"
                  ? cause
                  : new SessionStore.SessionCredentialIssueError({
                      cause: toPersistenceSqlError("ProofKeySessions.issue")(cause),
                    }),
              ),
            );
        }),
        revoke: hooks.revoke(store.revoke),
      }),
    });
  }),
).pipe(Layer.provide(KinPersistence.layer));

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* KinEnabled.KinEnabled;
    // A failed enabled store must fail layer construction, never select the no-op reference.
    return config.enabled ? enabled : Layer.empty;
  }),
).pipe(Layer.provide(KinEnabled.layer));

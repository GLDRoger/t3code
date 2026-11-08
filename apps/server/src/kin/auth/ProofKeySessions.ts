import type { AuthSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as KinPersistence from "../persistence/KinPersistence.ts";

export class ProofKeyStoreError extends Schema.TaggedError<ProofKeyStoreError>()(
  "ProofKeyStoreError",
  { cause: Schema.Defect() },
) {}

export class ProofKeySessions extends Context.Reference<{
  readonly onIssue: (
    sessionId: AuthSessionId,
    thumbprint: string,
  ) => Effect.Effect<void, ProofKeyStoreError>;
  readonly allowExchange: (
    thumbprint: string | undefined,
    grant: {
      readonly method: string;
      readonly subject: string;
      readonly proofKeyThumbprint?: string;
    },
  ) => Effect.Effect<boolean, ProofKeyStoreError>;
}>("kin/auth/ProofKeySessions", {
  defaultValue: () => ({ onIssue: () => Effect.void, allowExchange: () => Effect.succeed(true) }),
}) {}

export const layer = Layer.effect(
  ProofKeySessions,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return ProofKeySessions.of({
      onIssue: Effect.fn("ProofKeySessions.onIssue")(
        function* (sessionId, thumbprint) {
          const now = yield* DateTime.now;
          yield* sql`INSERT INTO kin_auth_session_keys (session_id, proof_key_thumbprint, created_at)
        VALUES (${sessionId}, ${thumbprint}, ${now.epochMilliseconds})`;
        },
        Effect.mapError((cause) => new ProofKeyStoreError({ cause })),
      ),
      allowExchange: Effect.fn("ProofKeySessions.allowExchange")(
        function* (thumbprint, grant) {
          if (!thumbprint) return true;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              // Only an owner-issued, key-bound repair grant can acknowledge previous revocations.
              if (
                grant.method === "one-time-token" &&
                grant.subject === "kin-owner-repair" &&
                grant.proofKeyThumbprint === thumbprint
              ) {
                yield* sql`INSERT OR IGNORE INTO kin_auth_key_repairs (session_id)
            SELECT m.session_id FROM kin_auth_session_keys m
            JOIN auth_sessions s ON s.session_id = m.session_id
            WHERE m.proof_key_thumbprint = ${thumbprint} AND s.revoked_at IS NOT NULL`;
              }
              const revoked = yield* sql`SELECT 1 FROM kin_auth_session_keys m
          JOIN auth_sessions s ON s.session_id = m.session_id
          LEFT JOIN kin_auth_key_repairs r ON r.session_id = m.session_id
          WHERE m.proof_key_thumbprint = ${thumbprint} AND s.revoked_at IS NOT NULL
            AND r.session_id IS NULL LIMIT 1`;
              return revoked.length === 0;
            }),
          );
        },
        Effect.mapError((cause) => new ProofKeyStoreError({ cause })),
      ),
    });
  }),
).pipe(Layer.provide(KinPersistence.layer));

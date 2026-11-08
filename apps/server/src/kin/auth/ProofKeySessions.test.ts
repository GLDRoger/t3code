import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ProofKeySessions from "./ProofKeySessions.ts";

const layer = EnvironmentAuth.layer.pipe(
  Layer.provide(ProofKeySessions.layer),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "kin-auth-keys-" })),
);
const metadata = { deviceType: "mobile" } as const;

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Kin proof key sessions", (it) => {
  it.effect(
    "finds a renewed revoked device without revoking another device or mapping unbound sessions",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE kin_approver_keys (org_id TEXT, thumbprint TEXT, proof_key_thumbprint TEXT, state TEXT)`;
        yield* sql`INSERT INTO kin_approver_keys VALUES ('org', 'signing-key', 'device', 'active'), ('org', 'other-signing-key', 'other', 'active')`;
        const original = yield* sessions.issue({
          proofKeyThumbprint: "device",
          ttl: Duration.hours(1),
        });
        const other = yield* sessions.issue({
          proofKeyThumbprint: "other",
          ttl: Duration.hours(2),
        });
        const unbound = yield* sessions.issue();
        yield* TestClock.adjust(Duration.minutes(59));
        const renewed = yield* sessions.issue({ proofKeyThumbprint: "device" });
        yield* TestClock.adjust(Duration.minutes(2));
        yield* sessions.revoke(renewed.sessionId);
        expect(
          yield* sql`SELECT DISTINCT k.org_id, k.thumbprint FROM kin_approver_keys k
        JOIN kin_auth_session_keys m ON m.proof_key_thumbprint = k.proof_key_thumbprint
        JOIN auth_sessions s ON s.session_id = m.session_id
        WHERE k.state != 'revoked' AND s.revoked_at IS NOT NULL`,
        ).toEqual([{ org_id: "org", thumbprint: "signing-key" }]);
        expect(
          yield* sql`SELECT * FROM kin_auth_session_keys WHERE session_id = ${unbound.sessionId}`,
        ).toEqual([]);
        expect(
          yield* sql`SELECT revoked_at FROM auth_sessions WHERE session_id = ${original.sessionId}`,
        ).toEqual([{ revoked_at: null }]);
        expect((yield* sessions.verify(other.token)).sessionId).toBe(other.sessionId);
        yield* sql`CREATE TRIGGER reject_key_mapping BEFORE INSERT ON kin_auth_session_keys
        BEGIN SELECT RAISE(ABORT, 'mapping unavailable'); END`;
        expect(
          (yield* sessions.issue({ proofKeyThumbprint: "failed-mapping" }).pipe(Effect.flip))._tag,
        ).toBe("SessionCredentialIssueError");
        expect(
          yield* sql`SELECT * FROM auth_sessions WHERE session_id NOT IN (SELECT session_id FROM kin_auth_session_keys) AND session_id != ${unbound.sessionId}`,
        ).toEqual([]);
        yield* sql`DROP TRIGGER reject_key_mapping`;
        yield* sql`CREATE TRIGGER reject_session BEFORE INSERT ON auth_sessions
        BEGIN SELECT RAISE(ABORT, 'session unavailable'); END`;
        expect(
          (yield* sessions.issue({ proofKeyThumbprint: "orphan" }).pipe(Effect.flip))._tag,
        ).toBe("SessionCredentialIssueError");
        expect(
          yield* sql`SELECT proof_key_thumbprint FROM kin_auth_session_keys m
        LEFT JOIN auth_sessions s ON s.session_id = m.session_id WHERE s.session_id IS NULL`,
        ).toEqual([{ proof_key_thumbprint: "orphan" }]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "blocks fresh cloud mints after revoke until an owner uses a bound repair pairing",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const mint = (subject = "cloud-connect", bound = "device") =>
          auth.createPairingLink({ subject, proofKeyThumbprint: bound });
        const exchange = (credential: string, thumbprint = "device") =>
          auth.exchangeBootstrapCredentialForAccessToken(credential, undefined, metadata, {
            proofKeyThumbprint: thumbprint,
          });
        const first = yield* exchange((yield* mint()).credential);
        const issued = yield* sessions.verify(first.access_token);
        yield* sessions.revoke(issued.sessionId);
        const denied = yield* exchange((yield* mint()).credential).pipe(Effect.exit);
        expect(Exit.isFailure(denied)).toBe(true);
        const unboundRepair = yield* auth.createPairingLink({ subject: "kin-owner-repair" });
        expect((yield* exchange(unboundRepair.credential).pipe(Effect.flip))._tag).toBe(
          "ServerAuthInvalidCredentialError",
        );
        const other = yield* exchange((yield* mint("cloud-connect", "other")).credential, "other");
        expect((yield* sessions.verify(other.access_token)).proofKeyThumbprint).toBe("other");
        const repaired = yield* exchange((yield* mint("kin-owner-repair")).credential);
        expect((yield* sessions.verify(repaired.access_token)).proofKeyThumbprint).toBe("device");
        yield* exchange((yield* mint()).credential);
        yield* sessions.revoke((yield* sessions.verify(repaired.access_token)).sessionId);
        expect((yield* exchange((yield* mint()).credential).pipe(Effect.flip))._tag).toBe(
          "ServerAuthInvalidCredentialError",
        );
      }).pipe(Effect.provide(layer)),
  );
});

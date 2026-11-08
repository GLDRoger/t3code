import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import * as RepairPairing from "./repairPairing.ts";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import { SessionHooks } from "./sessionHooks.ts";
import * as ProofKeySessions from "./ProofKeySessions.ts";

const makeLayer = (enabled: boolean) =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(ProofKeySessions.layer),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { KIN_ENABLED: String(enabled) } }),
      ),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "kin-auth-keys-" })),
  );
const layer = makeLayer(true);
const metadata = { deviceType: "mobile" } as const;

const recordRepair = (thumbprint: string, linkId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_auth_key_repairs (thumbprint, pairing_link_id, created_at) VALUES (${thumbprint}, ${linkId}, 0)`;
  });

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Kin proof key sessions", (it) => {
  it.effect("rejects invalid repair thumbprints before issuing a pairing link", () =>
    Effect.gen(function* () {
      const command = Command.make("repair", RepairPairing.flags).pipe(
        Command.withHandler(() => Effect.void),
      );
      for (const [thumbprint, valid] of [
        ["A".repeat(43), true],
        ["A".repeat(42), false],
        ["A".repeat(44), false],
        ["A".repeat(42) + "B", false],
        ["A".repeat(42) + "=", false],
        ["+".repeat(43), false],
      ] as const) {
        const exit = yield* Command.runWith(command, { version: "0" })([
          "--repair-proof-key",
          thumbprint,
        ]).pipe(Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(valid);
      }
    }),
  );

  it.effect("enabled store initialization failure cannot select allow-all hooks", () =>
    Effect.gen(function* () {
      const brokenSql = Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE kin_orgs (bad_schema TEXT)`;
        }),
      ).pipe(Layer.provideMerge(Sqlite.layerMemory));
      const exit = yield* Effect.gen(function* () {
        yield* (yield* SessionHooks).checkExchange("device", { method: "one-time-token" });
      }).pipe(
        Effect.provide(
          ProofKeySessions.layer.pipe(
            Layer.provide(brokenSql),
            Layer.provide(
              Layer.succeed(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromEnv({ env: { KIN_ENABLED: "true" } }),
              ),
            ),
          ),
        ),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("Kin disabled neither migrates nor blocks revoked keys", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const exchange = () =>
        auth.createPairingLink({ proofKeyThumbprint: "device" }).pipe(
          Effect.flatMap((link) =>
            auth.exchangeBootstrapCredentialForAccessToken(link.credential, undefined, metadata, {
              proofKeyThumbprint: "device",
            }),
          ),
        );
      expect(
        Exit.isFailure(
          yield* RepairPairing.create(auth, { repairProofKey: Option.some("device") }, {}).pipe(
            Effect.exit,
          ),
        ),
      ).toBe(true);
      expect(yield* auth.listPairingLinks()).toEqual([]);
      const first = yield* exchange();
      yield* sessions.revoke((yield* sessions.verify(first.access_token)).sessionId);
      yield* exchange();
      expect(yield* sql`SELECT name FROM sqlite_master WHERE name GLOB 'kin_*'`).toEqual([]);
    }).pipe(Effect.provide(makeLayer(false))),
  );

  it.effect.each([
    "other-devices",
    "other-devices-live",
    "other-key",
    "expired-revocation",
    "individual",
    "insert-race",
  ] as const)("%s", (action) =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const exchange = () =>
        auth.createPairingLink({ subject: "one-time-token", proofKeyThumbprint: "device" }).pipe(
          Effect.flatMap((link) =>
            auth.exchangeBootstrapCredentialForAccessToken(link.credential, undefined, metadata, {
              proofKeyThumbprint: "device",
            }),
          ),
        );
      const first = yield* exchange();
      const original = yield* sessions.verify(first.access_token);
      if (action === "other-key") {
        const other = yield* sessions.issue({ proofKeyThumbprint: "other" });
        yield* auth.revokeOtherClientSessions(original.sessionId);
        const link = yield* auth.createPairingLink({ proofKeyThumbprint: "other" });
        expect(
          (yield* auth
            .exchangeBootstrapCredentialForAccessToken(link.credential, undefined, metadata, {
              proofKeyThumbprint: "other",
            })
            .pipe(Effect.flip))._tag,
        ).toBe("ServerAuthInvalidCredentialError");
        expect(Exit.isFailure(yield* sessions.verify(other.token).pipe(Effect.exit))).toBe(true);
        yield* exchange();
      } else if (action === "other-devices" || action === "other-devices-live") {
        if (action === "other-devices") yield* TestClock.adjust(Duration.minutes(61));
        const current = yield* sessions.verify((yield* exchange()).access_token);
        yield* auth.revokeOtherClientSessions(current.sessionId);
        expect((yield* sessions.verify((yield* exchange()).access_token)).proofKeyThumbprint).toBe(
          "device",
        );
      } else if (action === "expired-revocation") {
        yield* TestClock.adjust(Duration.minutes(61));
        yield* sessions.revoke(original.sessionId);
        yield* exchange();
      } else if (action === "individual") {
        const sibling = yield* exchange();
        yield* sessions.revoke(original.sessionId);
        expect(Exit.isFailure(yield* sessions.verify(sibling.access_token).pipe(Effect.exit))).toBe(
          true,
        );
      } else {
        yield* (yield* SessionHooks).checkExchange("device", { method: "one-time-token" });
        yield* sessions.revoke(original.sessionId);
        const control = yield* sessions.issue();
        const changes = yield* Queue.unbounded<SessionStore.SessionCredentialChange>();
        yield* sessions.streamChanges.pipe(
          Stream.runForEach((change) => Queue.offer(changes, change)),
          Effect.forkScoped({ startImmediately: true }),
        );
        const late = yield* sessions.issue({ proofKeyThumbprint: "device" });
        yield* sessions.markConnected(control.sessionId);
        expect((yield* Queue.take(changes)).type).toBe("clientUpserted");
        expect(yield* Queue.take(changes)).toEqual({
          type: "clientRemoved",
          sessionId: late.sessionId,
        });
        expect(Exit.isFailure(yield* sessions.verify(late.token).pipe(Effect.exit))).toBe(true);
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect.each(["wrong-link", "spent"] as const)("repair guard: %s", (guard) =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const hooks = yield* SessionHooks.pipe(
        Effect.provide(
          ProofKeySessions.layer.pipe(
            Layer.provide(
              Layer.succeed(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromEnv({ env: { KIN_ENABLED: "true" } }),
              ),
            ),
          ),
        ),
      );
      const first = yield* sessions.issue({ proofKeyThumbprint: "device" });
      yield* sessions.revoke(first.sessionId);
      yield* hooks.recordRepair("device", "A");
      const grant = { method: "one-time-token", proofKeyThumbprint: "device", pairingLinkId: "A" };
      if (guard === "spent") {
        expect(yield* hooks.checkExchange("device", grant)).toBe(true);
        const next = yield* sessions.issue({ proofKeyThumbprint: "device" });
        yield* sessions.revoke(next.sessionId);
      }
      expect(
        yield* hooks.checkExchange("device", {
          ...grant,
          pairingLinkId: guard === "wrong-link" ? "B" : "A",
        }),
      ).toBe(false);
      if (guard === "wrong-link")
        expect(
          yield* sql`SELECT consumed_at FROM kin_auth_key_repairs WHERE pairing_link_id = 'A'`,
        ).toEqual([{ consumed_at: null }]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "failed revocation rolls back without publishing removals or disconnecting clients",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* sessions.issue({ proofKeyThumbprint: "device" });
        const sibling = yield* sessions.issue({ proofKeyThumbprint: "device" });
        yield* sessions.markConnected(first.sessionId);
        const changes = yield* Queue.unbounded<SessionStore.SessionCredentialChange>();
        yield* sessions.streamChanges.pipe(
          Stream.runForEach((change) => Queue.offer(changes, change)),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* sql`CREATE TABLE reject_revoke_ids (session_id TEXT)`;
        yield* sql`INSERT INTO reject_revoke_ids VALUES (${sibling.sessionId})`;
        yield* sql`CREATE TRIGGER reject_revoke BEFORE UPDATE ON auth_sessions WHEN NEW.session_id IN (SELECT session_id FROM reject_revoke_ids) BEGIN SELECT RAISE(ABORT, 'cannot revoke'); END`;
        expect(Exit.isFailure(yield* sessions.revoke(first.sessionId).pipe(Effect.exit))).toBe(
          true,
        );
        expect(yield* Queue.size(changes)).toBe(0);
        expect(
          (yield* sessions.listActive()).find((session) => session.sessionId === first.sessionId)
            ?.connected,
        ).toBe(true);
        expect((yield* sessions.verify(first.token)).sessionId).toBe(first.sessionId);
        yield* sql`DROP TRIGGER reject_revoke`;
        yield* sessions.revoke(first.sessionId);
        const removed = [yield* Queue.take(changes), yield* Queue.take(changes)];
        expect(removed).toEqual(
          expect.arrayContaining([
            { type: "clientRemoved", sessionId: first.sessionId },
            { type: "clientRemoved", sessionId: sibling.sessionId },
          ]),
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

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
        ).toEqual([]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "blocks fresh cloud mints after revoke until an owner uses a bound repair pairing",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const mint = (subject = "cloud-connect", bound = "device") =>
          Effect.gen(function* () {
            const link = yield* auth.createPairingLink({
              subject: subject === "repair" ? "one-time-token" : subject,
              proofKeyThumbprint: bound,
            });
            if (subject === "repair") yield* recordRepair(bound, link.id);
            return link;
          });
        const exchange = (credential: string, thumbprint = "device") =>
          auth.exchangeBootstrapCredentialForAccessToken(credential, undefined, metadata, {
            proofKeyThumbprint: thumbprint,
          });
        const first = yield* exchange((yield* mint()).credential);
        const issued = yield* sessions.verify(first.access_token);
        yield* sessions.revoke(issued.sessionId);
        const denied = yield* exchange((yield* mint()).credential).pipe(Effect.exit);
        expect(Exit.isFailure(denied)).toBe(true);
        const unboundRepair = yield* auth.createPairingLink({ subject: "one-time-token" });
        yield* recordRepair("device", unboundRepair.id);
        expect((yield* exchange(unboundRepair.credential).pipe(Effect.flip))._tag).toBe(
          "ServerAuthInvalidCredentialError",
        );
        const other = yield* exchange((yield* mint("cloud-connect", "other")).credential, "other");
        expect((yield* sessions.verify(other.access_token)).proofKeyThumbprint).toBe("other");
        const repair = yield* mint("repair");
        expect(Exit.isFailure(yield* exchange(repair.credential, "other").pipe(Effect.exit))).toBe(
          true,
        );
        const sql = yield* SqlClient.SqlClient;
        const wrongLink = yield* mint("one-time-token");
        expect((yield* exchange(wrongLink.credential).pipe(Effect.flip))._tag).toBe(
          "ServerAuthInvalidCredentialError",
        );
        expect(
          yield* sql`SELECT consumed_at FROM kin_auth_key_repairs WHERE pairing_link_id = ${repair.id}`,
        ).toEqual([{ consumed_at: null }]);
        const repaired = yield* exchange(repair.credential);
        expect((yield* sessions.verify(repaired.access_token)).subject).toBe("one-time-token");
        expect(Exit.isFailure(yield* exchange(repair.credential).pipe(Effect.exit))).toBe(true);
        expect(
          yield* sql`SELECT thumbprint, pairing_link_id, typeof(created_at) AS created_type, typeof(consumed_at) AS consumed_type FROM kin_auth_key_repairs WHERE pairing_link_id = ${repair.id}`,
        ).toEqual([
          {
            thumbprint: "device",
            pairing_link_id: repair.id,
            created_type: "integer",
            consumed_type: "integer",
          },
        ]);
        expect((yield* sessions.verify(repaired.access_token)).proofKeyThumbprint).toBe("device");
        yield* exchange((yield* mint()).credential);
        yield* sessions.revoke((yield* sessions.verify(repaired.access_token)).sessionId);
        // A spent repair cannot acknowledge a subsequent revocation, even without grant replay protection.
        const retryHooks = yield* SessionHooks.pipe(
          Effect.provide(
            ProofKeySessions.layer.pipe(
              Layer.provide(
                Layer.succeed(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromEnv({ env: { KIN_ENABLED: "true" } }),
                ),
              ),
            ),
          ),
        );
        expect(
          yield* retryHooks.checkExchange("device", {
            method: "one-time-token",
            proofKeyThumbprint: "device",
            pairingLinkId: repair.id,
          }),
        ).toBe(false);
        expect((yield* exchange((yield* mint()).credential).pipe(Effect.flip))._tag).toBe(
          "ServerAuthInvalidCredentialError",
        );
      }).pipe(Effect.provide(layer)),
  );
});

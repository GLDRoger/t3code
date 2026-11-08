import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  KinEventId,
  KinOrgId,
  KinPersonId,
  type KinApprovalError,
  type KinApprovalsRegisterKeyInput,
  type KinPendingAction,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SessionStore from "../../auth/SessionStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { layerKinAuthTest, repairProofKey } from "../auth/ProofKeySessions.testkit.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import {
  ApproverKeys,
  kinKeyConfirmationCode,
  layer as approverKeysLayer,
  type KinKeyCaller,
  type KinKeyConnection,
} from "./ApproverKeys.ts";
import { KinAttestationTrust } from "./attestation/AttestationTrust.ts";
import { androidChain, makeTrustFixture } from "./attestation/testFixtures.ts";
import { makeRegisterApproverKeyHandler } from "./handlers/registerApproverKey.ts";
import {
  KinPendingActions,
  layer as pendingActionsLayer,
  type KinPendingActionCreateInput,
} from "./PendingActions.ts";

const NOW = Date.parse("2026-11-08T00:00:00Z");
const fixture = makeTrustFixture();
const trustLayer = Layer.succeed(KinAttestationTrust, {
  load: () => Effect.succeed(fixture.trust),
});
const database = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);
const layer = approverKeysLayer.pipe(
  Layer.provideMerge(pendingActionsLayer),
  Layer.provide(trustLayer),
  Layer.provideMerge(database),
);

// Real T3 auth with Kin's proof key hooks, so revocations write what #54 writes.
const relayLayer = approverKeysLayer.pipe(
  Layer.provideMerge(pendingActionsLayer),
  Layer.provide(trustLayer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(layerKinAuthTest("kin-approver-keys-")),
);

const orgId = Schema.decodeSync(KinOrgId)("org_01");
const owner = Schema.decodeSync(KinPersonId)("h_owner");
const sessionId = Schema.decodeSync(AuthSessionId);
const decodeEventId = Schema.decodeSync(KinEventId);
const loopback: KinKeyConnection = { remoteAddress: "127.0.0.1", headers: {} };

const caller = (id: string, subject: string, connection?: KinKeyConnection): KinKeyCaller => ({
  session: { sessionId: sessionId(id), subject, method: "bearer-access-token", scopes: [] },
  people: [{ _tag: "person", orgId, personId: owner }],
  connection: Option.fromUndefinedOr(connection),
});
const phone = caller("sess-phone", "phone", { remoteAddress: "192.168.1.20", headers: {} });
const desktop = caller("sess-desktop", "desktop-bootstrap", loopback);

const seed = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
    VALUES ('org_01', 'Kin', '2026-11-07T00:00:00.000Z')`;
  for (const [id, subject, ip] of [
    ["sess-phone", "phone", "192.168.1.20"],
    ["sess-desktop", "desktop-bootstrap", "127.0.0.1"],
    ["sess-desktop-remote", "desktop-bootstrap", "100.101.102.103"],
    // A browser, or a tunnel's local process, on the Kin host itself.
    ["sess-local-browser", "browser", "127.0.0.1"],
  ] as const) {
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, client_ip_address,
        issued_at, expires_at)
      VALUES (${id}, ${subject}, '[]', 'bearer-access-token', ${ip},
        '2026-11-07T00:00:00.000Z', '2026-12-07T00:00:00.000Z')`;
  }
  return { keys: yield* ApproverKeys, actions: yield* KinPendingActions, sql };
});

/** A relay phone: a DPoP session that renews hourly under a new id with the same proof key. */
const relayPhone = (id: AuthSessionId, proofKeyThumbprint: string): KinKeyCaller => ({
  session: {
    sessionId: id,
    subject: "phone",
    method: "dpop-access-token",
    scopes: [],
    proofKeyThumbprint,
  },
  people: [{ _tag: "person", orgId, personId: owner }],
  connection: Option.some({ remoteAddress: "100.64.0.9", headers: {} }),
});

const seedRelay = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
    VALUES ('org_01', 'Kin', '2026-11-07T00:00:00.000Z')`;
  const sessions = yield* SessionStore.SessionStore;
  const relay = (proofKey: string) =>
    sessions
      .issue({ proofKeyThumbprint: proofKey, ttl: Duration.hours(1) })
      .pipe(Effect.map((issued) => relayPhone(issued.sessionId, proofKey)));
  return { keys: yield* ApproverKeys, sessions, relay };
});

const registerAndroid = (
  keys: ApproverKeys["Service"],
  from: KinKeyCaller = phone,
  spec: Partial<Parameters<typeof androidChain>[1]> = {},
) =>
  Effect.gen(function* () {
    const { challenge } = yield* keys.keyChallenge(from);
    const bytes = new Uint8Array(Buffer.from(challenge, "base64url"));
    const chain = androidChain(fixture, { challenge: bytes, ...spec });
    const input = {
      orgId,
      publicJwk: chain.publicJwk,
      platform: "android",
      challenge,
      attestation: { format: "android-key", certificateChain: chain.certificateChain },
      deviceLabel: "Pixel 9",
    } satisfies KinApprovalsRegisterKeyInput;
    return { ...(yield* keys.registerKey(from, input)), input };
  });

const reasonOf = <A>(exit: Exit.Exit<A, KinApprovalError>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? (exit.cause.reasons[0].error as KinApprovalError).reason
    : "success";

const mergeRequest = (source: string) =>
  ({
    orgId: "org_01",
    kind: "merge_pull_request",
    target: {
      _tag: "pull_request",
      host: "github.com",
      repo: "GLDRoger/t3code",
      number: 212,
      mergeMethod: "squash",
      deleteBranchAfter: false,
    },
    resolved: {
      _tag: "pull_request",
      headSha: "a".repeat(40),
      base: "main",
      head: "kin/fix-212",
      title: "Fix 212",
      additions: 3,
      deletions: 1,
      files: 1,
      checks: [],
    },
    targetDigest: "1".repeat(64),
    reason: "CI is green.",
    requestedBy: { agentId: "lead", threadId: "thread-lead" },
    provenance: { startedBy: "github", startedByRole: "none", chain: [] },
    source: decodeEventId(source),
  }) as unknown as KinPendingActionCreateInput;

const approveWith = (
  actions: KinPendingActions["Service"],
  action: KinPendingAction,
  thumbprint: KinPendingAction["targetDigest"],
  jti: string,
) =>
  actions.approve({
    orgId: action.orgId,
    actionId: action.id,
    revision: action.revision,
    nonce: action.nonce,
    jti,
    approverHumanId: owner,
    keyThumbprint: thumbprint as never,
    compact: `compact-${jti}`,
    iat: NOW / 1000,
    exp: NOW / 1000 + 600,
  });

const confirmFirst = (keys: ApproverKeys["Service"]) =>
  Effect.gen(function* () {
    const registered = yield* registerAndroid(keys);
    yield* keys.confirmKey(desktop, {
      orgId,
      thumbprint: registered.key.thumbprint,
      code: registered.code,
    });
    return registered;
  });

describe("ApproverKeys", () => {
  it.effect("the first approver key can't be confirmed from a remote session", () =>
    Effect.gen(function* () {
      const { keys } = yield* seed;
      const { key, code } = yield* registerAndroid(keys);
      assert.strictEqual(key.state, "pending");
      assert.strictEqual(key.hardware, "strongbox");
      assert.isTrue(key.attested);
      const input = { orgId, thumbprint: key.thumbprint, code };
      const remote: ReadonlyArray<KinKeyCaller> = [
        phone,
        caller("sess-phone", "phone", loopback),
        caller("sess-local-browser", "browser", loopback),
        caller("sess-desktop", "desktop-bootstrap", { remoteAddress: "100.64.0.9", headers: {} }),
        caller("sess-desktop", "desktop-bootstrap", {
          remoteAddress: "127.0.0.1",
          headers: { "x-forwarded-for": "100.64.0.9" },
        }),
        caller("sess-desktop", "desktop-bootstrap", {
          remoteAddress: "127.0.0.1",
          headers: { "tailscale-user-login": "someone@example.com" },
        }),
        caller("sess-desktop", "desktop-bootstrap"),
        caller("sess-desktop-remote", "desktop-bootstrap", loopback),
      ];
      for (const from of remote) {
        assert.strictEqual(reasonOf(yield* Effect.exit(keys.confirmKey(from, input))), "not_local");
      }
      const wrong = code === "000000" ? "000001" : "000000";
      assert.strictEqual(
        reasonOf(yield* Effect.exit(keys.confirmKey(desktop, { ...input, code: wrong }))),
        "bad_code",
      );
      const confirmed = yield* keys.confirmKey(desktop, input);
      assert.strictEqual(confirmed.state, "active");
      assert.deepStrictEqual(yield* keys.requireActive(key), confirmed);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a grant signed by a revoked key is rejected, and revoking voids approved actions it signed",
    () =>
      Effect.gen(function* () {
        const { keys, actions } = yield* seed;
        const { key } = yield* confirmFirst(keys);
        const signed = (yield* actions.create(mergeRequest("evt-1"))).action;
        const waiting = (yield* actions.create(mergeRequest("evt-2"))).action;
        assert.strictEqual(
          (yield* approveWith(actions, signed, key.thumbprint, "jti-1"))._tag,
          "approved",
        );

        const revoked = yield* keys.revokeKey(phone, key);
        assert.strictEqual(revoked.state, "revoked");
        assert.strictEqual(reasonOf(yield* Effect.exit(keys.requireActive(key))), "revoked_key");
        const voided = yield* actions.get({ orgId, actionId: signed.id });
        assert.strictEqual(Option.getOrThrow(voided).state, "voided");
        assert.strictEqual(Option.getOrThrow(voided).stateReason, "key_revoked");
        const untouched = yield* actions.get({ orgId, actionId: waiting.id });
        assert.strictEqual(Option.getOrThrow(untouched).state, "awaiting_approval");
        // Revoking is idempotent and never brings a key back.
        assert.strictEqual((yield* keys.revokeKey(phone, key)).state, "revoked");
      }).pipe(Effect.provide(layer)),
  );

  it.effect("revoking the T3 session a key was registered from revokes the key", () =>
    Effect.gen(function* () {
      const { keys, actions, sql } = yield* seed;
      const { key } = yield* confirmFirst(keys);
      const signed = (yield* actions.create(mergeRequest("evt-1"))).action;
      yield* approveWith(actions, signed, key.thumbprint, "jti-1");
      yield* sql`UPDATE auth_sessions SET revoked_at = '2026-11-08T00:00:00.000Z'
        WHERE session_id = 'sess-phone'`;

      assert.strictEqual(reasonOf(yield* Effect.exit(keys.requireActive(key))), "revoked_key");
      const { keys: listed } = yield* keys.listKeys(desktop, { orgId });
      assert.deepStrictEqual(
        listed.map((listedKey) => listedKey.state),
        ["revoked"],
      );
      const voided = Option.getOrThrow(yield* actions.get({ orgId, actionId: signed.id }));
      assert.strictEqual(voided.stateReason, "session_revoked");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "revoking a renewed relay session revokes the key registered under an earlier one",
    () =>
      Effect.gen(function* () {
        const { keys, sessions, relay } = yield* seedRelay;
        const { key } = yield* registerAndroid(keys, yield* relay("phone-a"));
        yield* TestClock.adjust(Duration.minutes(61));
        const renewed = yield* relay("phone-a");
        yield* sessions.revoke(renewed.session.sessionId);
        assert.strictEqual(Option.getOrThrow(yield* keys.get(key)).state, "revoked");
      }).pipe(Effect.provide(relayLayer)),
  );

  it.effect("signing out other devices from a phone keeps its own key and revokes the others", () =>
    Effect.gen(function* () {
      const { keys, sessions, relay } = yield* seedRelay;
      const own = yield* registerAndroid(keys, yield* relay("phone-a"));
      const other = yield* registerAndroid(keys, yield* relay("phone-b"));
      yield* TestClock.adjust(Duration.minutes(30));
      // Both renew early; the phone's first session is still live when it signs the others out.
      const current = yield* relay("phone-a");
      yield* relay("phone-b");
      yield* sessions.revokeAllExcept(current.session.sessionId);
      assert.strictEqual(Option.getOrThrow(yield* keys.get(own.key)).state, "pending");
      assert.strictEqual(Option.getOrThrow(yield* keys.get(other.key)).state, "revoked");
    }).pipe(Effect.provide(relayLayer)),
  );

  it.effect("signing out other devices revokes a phone whose sessions had all expired", () =>
    Effect.gen(function* () {
      const { keys, sessions, relay } = yield* seedRelay;
      const other = yield* registerAndroid(keys, yield* relay("phone-b"));
      yield* TestClock.adjust(Duration.minutes(61));
      const current = yield* relay("phone-a");
      yield* sessions.revokeAllExcept(current.session.sessionId);
      assert.strictEqual(Option.getOrThrow(yield* keys.get(other.key)).state, "revoked");
    }).pipe(Effect.provide(relayLayer)),
  );

  it.effect("revoking a session after it expired leaves its key alone", () =>
    Effect.gen(function* () {
      const { keys, sessions, relay } = yield* seedRelay;
      const phoneA = yield* relay("phone-a");
      const { key } = yield* registerAndroid(keys, phoneA);
      yield* TestClock.adjust(Duration.minutes(61));
      yield* sessions.revoke(phoneA.session.sessionId);
      assert.strictEqual(Option.getOrThrow(yield* keys.get(key)).state, "pending");
    }).pipe(Effect.provide(relayLayer)),
  );

  it.effect("a proof key registers an approver key once every revocation of it is repaired", () =>
    Effect.gen(function* () {
      const { keys, sessions, relay } = yield* seedRelay;
      const signedOut = yield* relay("phone-a");
      yield* sessions.revoke(signedOut.session.sessionId);
      // A call that authenticated just before the revocation landed.
      assert.strictEqual(
        reasonOf(yield* Effect.exit(registerAndroid(keys, signedOut))),
        "invalid_state",
      );
      const repaired = yield* repairProofKey("phone-a");
      yield* TestClock.adjust(Duration.minutes(1));
      const { key } = yield* registerAndroid(keys, relayPhone(repaired.sessionId, "phone-a"));
      // Reconcile doesn't count the repaired revocation from before the key existed.
      assert.strictEqual(Option.getOrThrow(yield* keys.get(key)).state, "pending");
    }).pipe(Effect.provide(relayLayer)),
  );

  it.effect("a revocation after a key registered revokes it for good, even once repaired", () =>
    Effect.gen(function* () {
      const { keys, sessions, relay } = yield* seedRelay;
      const phoneA = yield* relay("phone-a");
      const first = yield* registerAndroid(keys, phoneA);
      yield* TestClock.adjust(Duration.minutes(1));
      // No key read between the revocation and the repair, so only `created_at` can catch it.
      yield* sessions.revoke(phoneA.session.sessionId);
      const repaired = yield* repairProofKey("phone-a");
      yield* TestClock.adjust(Duration.minutes(1));
      assert.strictEqual(Option.getOrThrow(yield* keys.get(first.key)).state, "revoked");
      const second = yield* registerAndroid(keys, relayPhone(repaired.sessionId, "phone-a"));
      assert.strictEqual(Option.getOrThrow(yield* keys.get(second.key)).state, "pending");
      assert.strictEqual(Option.getOrThrow(yield* keys.get(first.key)).state, "revoked");
    }).pipe(Effect.provide(relayLayer)),
  );

  it.effect("the server never activates an unattested key", () =>
    Effect.gen(function* () {
      const { keys } = yield* seed;
      const { challenge } = yield* keys.keyChallenge(phone);
      const ios = yield* keys.registerKey(phone, {
        orgId,
        publicJwk: androidChain(fixture, { challenge: new Uint8Array(32) }).publicJwk,
        platform: "ios",
        challenge,
        deviceLabel: "iPhone",
      });
      assert.strictEqual(ios.key.attested, false);
      assert.strictEqual(ios.key.hardware, "software");
      const failed = yield* registerAndroid(keys, phone, { deviceLocked: false });
      assert.strictEqual(failed.key.attested, false);
      // Re-registering an attested key's public key without attestation can't downgrade it.
      const attested = yield* registerAndroid(keys);
      const replay = yield* keys.keyChallenge(phone);
      const downgrade = yield* Effect.exit(
        keys.registerKey(phone, {
          orgId,
          publicJwk: attested.input.publicJwk,
          platform: "ios",
          challenge: replay.challenge,
          deviceLabel: "iPhone",
        }),
      );
      assert.strictEqual(reasonOf(downgrade), "invalid_state");
      assert.isTrue(Option.getOrThrow(yield* keys.get(attested.key)).attested);
      for (const { key, code } of [ios, failed]) {
        const exit = yield* Effect.exit(
          keys.confirmKey(desktop, { orgId, thumbprint: key.thumbprint, code }),
        );
        assert.strictEqual(reasonOf(exit), "unattested");
        assert.isFalse(yield* keys.activateByGrant(key));
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a key challenge is single-use, bound to its session and expires in 5 minutes", () =>
    Effect.gen(function* () {
      const { keys } = yield* seed;
      const { challenge } = yield* keys.keyChallenge(desktop);
      const other = yield* Effect.exit(registerAndroidWith(keys, phone, challenge));
      assert.strictEqual(reasonOf(other), "bad_challenge");

      const first = yield* keys.keyChallenge(phone);
      yield* registerAndroidWith(keys, phone, first.challenge);
      const reused = yield* Effect.exit(registerAndroidWith(keys, phone, first.challenge));
      assert.strictEqual(reasonOf(reused), "bad_challenge");

      const late = yield* keys.keyChallenge(phone);
      yield* TestClock.adjust("5 minutes");
      const expired = yield* Effect.exit(registerAndroidWith(keys, phone, late.challenge));
      assert.strictEqual(reasonOf(expired), "bad_challenge");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("five wrong codes end the confirmation", () =>
    Effect.gen(function* () {
      const { keys } = yield* seed;
      const { key, code, input } = yield* registerAndroid(keys);
      assert.strictEqual(
        code,
        kinKeyConfirmationCode(
          key.thumbprint,
          new Uint8Array(Buffer.from(input.challenge, "base64url")),
        ),
      );
      const wrong = code === "000000" ? "000001" : "000000";
      for (let attempt = 0; attempt < 5; attempt++) {
        yield* Effect.exit(
          keys.confirmKey(desktop, { orgId, thumbprint: key.thumbprint, code: wrong }),
        );
      }
      const exit = yield* Effect.exit(
        keys.confirmKey(desktop, { orgId, thumbprint: key.thumbprint, code }),
      );
      assert.strictEqual(reasonOf(exit), "bad_code");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a later key needs a register_approver_key grant from an active key", () =>
    Effect.gen(function* () {
      const { keys, actions, sql } = yield* seed;
      const first = yield* confirmFirst(keys);
      const second = yield* registerAndroid(keys, phone, { attestationLevel: 1, keyMintLevel: 1 });
      const desktopConfirm = yield* Effect.exit(
        keys.confirmKey(desktop, { orgId, thumbprint: second.key.thumbprint, code: second.code }),
      );
      assert.strictEqual(reasonOf(desktopConfirm), "invalid_state");

      const [row] = yield* sql<{ action_id: string }>`SELECT action_id FROM kin_pending_actions
        WHERE kind = 'register_approver_key' AND state = 'awaiting_approval'`;
      const action = Option.getOrThrow(
        yield* actions.get({ orgId, actionId: row!.action_id as KinPendingAction["id"] }),
      );
      assert.deepStrictEqual(action.target, {
        _tag: "device_key",
        thumbprint: second.key.thumbprint,
        hardware: "tee",
        attested: true,
      });
      assert.deepStrictEqual(action.provenance.startedBy, { humanId: owner });

      const approved = yield* approveWith(actions, action, first.key.thumbprint, "jti-key");
      assert.strictEqual(approved._tag, "approved");
      if (approved._tag !== "approved") return;
      const handler = yield* makeRegisterApproverKeyHandler;
      assert.strictEqual(yield* handler.reconcile(action), "not_done");
      // The stored key must still be what the card described.
      yield* sql`UPDATE kin_approver_keys SET hardware = 'strongbox' WHERE thumbprint = ${second.key.thumbprint}`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(handler.run(action, approved.grant))));
      yield* sql`UPDATE kin_approver_keys SET hardware = 'tee' WHERE thumbprint = ${second.key.thumbprint}`;
      assert.strictEqual(yield* handler.run(action, approved.grant), "succeeded");
      assert.strictEqual(yield* handler.reconcile(action), "done");
      assert.strictEqual((yield* keys.requireActive(second.key)).state, "active");
      // A second run finds nothing pending.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(handler.run(action, approved.grant))));

      const third = yield* registerAndroid(keys);
      yield* keys.revokeKey(phone, third.key);
      const [cancelled] = yield* sql<{ state: string }>`SELECT state FROM kin_pending_actions
        WHERE kind = 'register_approver_key'
          AND json_extract(target_json, '$.thumbprint') = ${third.key.thumbprint}`;
      assert.strictEqual(cancelled?.state, "cancelled");

      yield* sql`ALTER TABLE kin_approver_keys RENAME TO kin_approver_keys_gone`;
      assert.strictEqual(
        reasonOf(yield* Effect.exit(keys.listKeys(phone, { orgId }))),
        "unavailable",
      );
    }).pipe(Effect.provide(layer)),
  );
});

function registerAndroidWith(keys: ApproverKeys["Service"], from: KinKeyCaller, challenge: string) {
  const chain = androidChain(fixture, {
    challenge: new Uint8Array(Buffer.from(challenge, "base64url")),
  });
  return keys.registerKey(from, {
    orgId,
    publicJwk: chain.publicJwk,
    platform: "android",
    challenge,
    attestation: { format: "android-key", certificateChain: chain.certificateChain },
    deviceLabel: "Pixel 9",
  });
}

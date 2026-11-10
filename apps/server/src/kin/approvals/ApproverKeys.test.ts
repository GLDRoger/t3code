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
} from "./ApproverKeys.ts";
import * as Audit from "./Audit.ts";
import { KinHostKeyCeremony, layer as hostCeremonyLayer } from "./HostKeyCeremony.ts";
import * as KeySeal from "./KeySeal.ts";
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
const layer = Layer.merge(approverKeysLayer, hostCeremonyLayer).pipe(
  Layer.provideMerge(pendingActionsLayer),
  Layer.provideMerge(Audit.layer),
  Layer.provide(Layer.merge(trustLayer, KeySeal.layerTest())),
  Layer.provideMerge(database),
);

// Real T3 auth with Kin's proof key hooks, so revocations write what #54 writes.
const relayLayer = Layer.merge(approverKeysLayer, hostCeremonyLayer).pipe(
  Layer.provideMerge(pendingActionsLayer),
  Layer.provideMerge(Audit.layer),
  Layer.provide(Layer.merge(trustLayer, KeySeal.layerTest())),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(layerKinAuthTest("kin-approver-keys-")),
);

const orgId = Schema.decodeSync(KinOrgId)("org_01");
const owner = Schema.decodeSync(KinPersonId)("h_owner");
const sessionId = Schema.decodeSync(AuthSessionId);
const decodeEventId = Schema.decodeSync(KinEventId);

const caller = (id: string, subject: string): KinKeyCaller => ({
  session: { sessionId: sessionId(id), subject, method: "bearer-access-token", scopes: [] },
  people: [{ _tag: "person", orgId, personId: owner }],
});
const phone = caller("sess-phone", "phone");
const laptop = caller("sess-laptop", "browser");

const seed = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
    VALUES ('org_01', 'Kin', '2026-11-07T00:00:00.000Z')`;
  for (const [id, subject, ip] of [
    ["sess-phone", "phone", "192.168.1.20"],
    ["sess-phone-2", "phone", "192.168.1.21"],
    ["sess-laptop", "browser", "192.168.1.30"],
  ] as const) {
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, client_ip_address,
        issued_at, expires_at)
      VALUES (${id}, ${subject}, '[]', 'bearer-access-token', ${ip},
        '2026-11-07T00:00:00.000Z', '2026-12-07T00:00:00.000Z')`;
  }
  return {
    keys: yield* ApproverKeys,
    ceremony: yield* KinHostKeyCeremony,
    actions: yield* KinPendingActions,
    sql,
  };
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
    provenance: { startedBy: "github", startedByRole: "none", chain: [], ceilingBelowOwner: true },
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

/** What the owner types into `kin approvals confirm-key` on the host. */
const onHost = (
  registered: { readonly key: { readonly thumbprint: KinPendingAction["targetDigest"] } },
  code: string,
  options: { readonly session?: string; readonly recover?: boolean } = {},
) =>
  KinHostKeyCeremony.use((ceremony) =>
    ceremony.confirm({
      orgId,
      thumbprint: registered.key.thumbprint as never,
      sessionId: sessionId(options.session ?? "sess-phone"),
      code,
      recover: options.recover ?? false,
    }),
  );

const confirmFirst = (keys: ApproverKeys["Service"]) =>
  Effect.gen(function* () {
    const registered = yield* registerAndroid(keys);
    yield* onHost(registered, registered.code);
    return registered;
  });

const otherCode = (code: string) => (code === "000000" ? "000001" : "000000");

describe("ApproverKeys", () => {
  it.effect("keys active before the seal shipped are sealed on the first start only", () =>
    Effect.gen(function* () {
      const { keys, sql } = yield* seed;
      const legacy = yield* confirmFirst(keys);
      const later = yield* registerAndroid(keys);
      assert.isTrue(yield* keys.activateByGrant(later.key));
      // As every active key was before K027: no seal.
      yield* sql`UPDATE kin_approver_keys SET seal = NULL WHERE org_id = ${orgId}`;
      const upgraded = yield* Layer.build(KeySeal.layerTest({ adopted: false }));
      // A fresh build per call, as a restart would be.
      const start = Layer.fresh(approverKeysLayer).pipe(
        Layer.provideMerge(pendingActionsLayer),
        Layer.provideMerge(Audit.layer),
        Layer.provide(Layer.merge(trustLayer, Layer.succeedContext(upgraded))),
      );
      const attested = (thumbprint: (typeof legacy)["key"]["thumbprint"]) =>
        ApproverKeys.use((started) => started.get({ orgId, thumbprint })).pipe(
          Effect.map((key) => Option.getOrThrow(key).attested),
          Effect.provide(start),
        );
      assert.isTrue(yield* attested(legacy.key.thumbprint));
      // A row written into SQLite after that start stays unsealed through the next one.
      yield* sql`UPDATE kin_approver_keys SET seal = NULL
        WHERE org_id = ${orgId} AND thumbprint = ${later.key.thumbprint}`;
      assert.isFalse(yield* attested(later.key.thumbprint));
      assert.isTrue(yield* attested(legacy.key.thumbprint));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("the host confirms the first key only with its phone's code, key and session", () =>
    Effect.gen(function* () {
      const { keys, ceremony } = yield* seed;
      const mine = yield* registerAndroid(keys);
      // The list is oldest first; a second apart keeps it from falling back to random thumbprints.
      yield* TestClock.adjust("1 second");
      const other = yield* registerAndroid(keys, caller("sess-phone-2", "phone"));
      assert.strictEqual(mine.key.state, "pending");
      assert.strictEqual(mine.key.hardware, "strongbox");
      assert.isTrue(mine.key.attested);
      const listed = yield* ceremony.listPending();
      assert.deepStrictEqual(
        listed.map((row) => [row.thumbprint, row.sessionId, row.hardware, row.attemptsLeft]),
        [
          [mine.key.thumbprint, "sess-phone", "strongbox", 5],
          [other.key.thumbprint, "sess-phone-2", "strongbox", 5],
        ],
      );

      // Wrong code; another key's code; the right code named with another session.
      assert.strictEqual(
        reasonOf(yield* Effect.exit(onHost(mine, otherCode(mine.code)))),
        "bad_code",
      );
      assert.strictEqual(reasonOf(yield* Effect.exit(onHost(mine, other.code))), "bad_code");
      assert.strictEqual(
        reasonOf(yield* Effect.exit(onHost(mine, mine.code, { session: "sess-phone-2" }))),
        "bad_code",
      );
      assert.strictEqual(Option.getOrThrow(yield* keys.get(mine.key)).state, "pending");

      const confirmed = yield* onHost(mine, mine.code);
      assert.strictEqual(confirmed.key.state, "active");
      assert.deepStrictEqual(confirmed.revoked, []);
      assert.deepStrictEqual(yield* keys.requireActive(mine.key), confirmed.key);
      // Exactly that key: the other phone stays pending, and only --recover could confirm it now.
      assert.strictEqual(Option.getOrThrow(yield* keys.get(other.key)).state, "pending");
      assert.isTrue((yield* ceremony.listPending())[0]!.needsRecovery);
      assert.strictEqual(
        reasonOf(yield* Effect.exit(onHost(other, other.code, { session: "sess-phone-2" }))),
        "invalid_state",
      );
      // A code works once.
      assert.strictEqual(reasonOf(yield* Effect.exit(onHost(mine, mine.code))), "bad_code");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a code bound to another tuple in SQLite doesn't confirm, and expires in 10 minutes",
    () =>
      Effect.gen(function* () {
        const { keys, sql } = yield* seed;
        const moved = yield* registerAndroid(keys);
        // Point the code at another session, as a SQLite write could: the verifier no longer fits.
        yield* sql`UPDATE kin_approver_key_confirmations SET session_id = 'sess-phone-2'
        WHERE thumbprint = ${moved.key.thumbprint}`;
        yield* sql`UPDATE kin_approver_keys SET session_id = 'sess-phone-2'
        WHERE thumbprint = ${moved.key.thumbprint}`;
        assert.strictEqual(
          reasonOf(yield* Effect.exit(onHost(moved, moved.code, { session: "sess-phone-2" }))),
          "bad_code",
        );
        const late = yield* registerAndroid(keys);
        yield* TestClock.adjust("10 minutes");
        assert.strictEqual(reasonOf(yield* Effect.exit(onHost(late, late.code))), "bad_code");
        assert.strictEqual(Option.getOrThrow(yield* keys.get(late.key)).state, "pending");
      }).pipe(Effect.provide(layer)),
  );

  it.effect("recovery on the host revokes the lost phone's key and activates the new one", () =>
    Effect.gen(function* () {
      const { keys, sql } = yield* seed;
      const lost = yield* confirmFirst(keys);
      const replacement = yield* registerAndroid(keys, caller("sess-phone-2", "phone"));
      const listed = yield* keys.listKeys(laptop, { orgId });
      assert.deepStrictEqual(
        listed.enrolments?.map((enrolment) => enrolment.thumbprint),
        [replacement.key.thumbprint],
      );

      const recovered = yield* onHost(replacement, replacement.code, {
        session: "sess-phone-2",
        recover: true,
      });
      assert.strictEqual(recovered.key.state, "active");
      assert.deepStrictEqual(recovered.revoked, [lost.key.thumbprint]);
      assert.strictEqual(reasonOf(yield* Effect.exit(keys.requireActive(lost.key))), "revoked_key");
      assert.deepStrictEqual((yield* keys.listKeys(laptop, { orgId })).enrolments, []);
      const [enrolment] = yield* sql<{ state: string; state_reason: string }>`
        SELECT state, state_reason FROM kin_pending_actions WHERE kind = 'register_approver_key'`;
      assert.deepStrictEqual(enrolment, { state: "cancelled", state_reason: "confirmed_on_host" });
      const audit = yield* sql<{ event: string }>`SELECT event FROM kin_audit
        WHERE event IN ('key_revoked', 'key_confirmed') ORDER BY seq`;
      assert.deepStrictEqual(
        audit.map((row) => row.event),
        ["key_confirmed", "key_revoked", "key_confirmed"],
      );
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
      const { keys: listed } = yield* keys.listKeys(laptop, { orgId });
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
      // No code is kept for an unattested key, so the host has nothing to confirm.
      for (const registered of [ios, failed]) {
        const exit = yield* Effect.exit(onHost(registered, registered.code));
        assert.strictEqual(reasonOf(exit), "bad_code");
        assert.isFalse(yield* keys.activateByGrant(registered.key));
        assert.strictEqual(Option.getOrThrow(yield* keys.get(registered.key)).state, "pending");
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a key challenge is single-use, bound to its session and expires in 5 minutes", () =>
    Effect.gen(function* () {
      const { keys } = yield* seed;
      const { challenge } = yield* keys.keyChallenge(laptop);
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
      for (let attempt = 0; attempt < 5; attempt++) {
        assert.strictEqual(
          reasonOf(yield* Effect.exit(onHost({ key }, otherCode(code)))),
          "bad_code",
        );
      }
      assert.strictEqual(reasonOf(yield* Effect.exit(onHost({ key }, code))), "bad_code");
      assert.strictEqual(Option.getOrThrow(yield* keys.get(key)).state, "pending");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a later key needs a register_approver_key grant from an active key", () =>
    Effect.gen(function* () {
      const { keys, actions, sql } = yield* seed;
      const first = yield* confirmFirst(keys);
      const second = yield* registerAndroid(keys, phone, { attestationLevel: 1, keyMintLevel: 1 });
      const hostConfirm = yield* Effect.exit(onHost(second, second.code));
      assert.strictEqual(reasonOf(hostConfirm), "invalid_state");

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

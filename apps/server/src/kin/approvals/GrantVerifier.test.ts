// @effect-diagnostics nodeBuiltinImport:off -- node:crypto signs like the phone; node:fs reads the import graph.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  KinEventId,
  KinOrgId,
  KinPersonId,
  type KinActionTarget,
  KinApprovalError,
  type KinGrantHeader,
  type KinGrantPayload,
  type KinPendingAction,
  type KinResolvedTarget,
} from "@t3tools/contracts";
import { computeDpopJwkThumbprint } from "@t3tools/shared/dpop";
import { encodeGrantSigningInput } from "@t3tools/shared/kinGrant";
import { stableStringify } from "@t3tools/shared/relaySigning";
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
import { layerKinAuthTest } from "../auth/ProofKeySessions.testkit.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { ApproverKeys, layer as approverKeysLayer, type KinKeyCaller } from "./ApproverKeys.ts";
import { KinAudit, make as makeAudit, type KinAuditAppendInput } from "./Audit.ts";
import { KinAttestationTrust } from "./attestation/AttestationTrust.ts";
import { androidChain, makeTrustFixture, newKey } from "./attestation/testFixtures.ts";
import {
  BOOTSTRAP_OWNER,
  auditLayer as grantAuditLayer,
  KinLiveTargets,
  KinOrgRoles,
  orgRolesLayer,
} from "./GrantPorts.ts";
import { GrantVerifier, layer as grantVerifierLayer } from "./GrantVerifier.ts";
import {
  KinPendingActions,
  kinTargetDigest,
  layer as pendingActionsLayer,
  type KinPendingActionCreateInput,
} from "./PendingActions.ts";

const NOW = Date.parse("2026-11-08T00:00:00Z");
const NOW_S = NOW / 1000;
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const fixture = makeTrustFixture();
const orgId = Schema.decodeSync(KinOrgId)("org_01");
const owner = Schema.decodeSync(KinPersonId)("h_owner");
const member = Schema.decodeSync(KinPersonId)("h_member");
const sessionId = Schema.decodeSync(AuthSessionId);
const decodeEventId = Schema.decodeSync(KinEventId);
const decodeOrgId = Schema.decodeSync(KinOrgId);
const decodePersonId = Schema.decodeSync(KinPersonId);

const callerFor = (id: string, personId: KinPersonId, subject = "phone"): KinKeyCaller => ({
  session: { sessionId: sessionId(id), subject, method: "bearer-access-token", scopes: [] },
  people: [{ _tag: "person", orgId, personId }],
  connection: Option.some({
    remoteAddress: subject === "desktop-bootstrap" ? "127.0.0.1" : "192.168.1.20",
    headers: {},
  }),
});
const ownerPhone = callerFor("sess-phone", owner);
const ownerLaptop = callerFor("sess-laptop", owner);
const desktop = callerFor("sess-desktop", owner, "desktop-bootstrap");
const memberPhone = callerFor("sess-member", member);
const nobody: KinKeyCaller = { ...callerFor("sess-nobody", owner), people: [] };

const sha = (char: string) => char.repeat(40);
const pr = (number: number, mergeMethod: "squash" | "merge" = "squash"): KinActionTarget => ({
  _tag: "pull_request",
  host: "github.com",
  repo: "GLDRoger/t3code",
  number,
  mergeMethod,
  deleteBranchAfter: false,
});
const prFacts = (headSha: string, base = "main"): KinResolvedTarget => ({
  _tag: "pull_request",
  headSha,
  base,
  head: "kin/fix",
  title: "Fix",
  additions: 3,
  deletions: 1,
  files: 1,
  checks: [{ name: "ci", required: true, status: "passed" }],
});

const DECISION_EVENTS = new Set(["grant_accepted", "grant_rejected", "action_rejected"]);

/** One test's world: an in-memory database, a recorded audit and a scriptable GitHub. */
function harness() {
  const audit: Array<KinAuditAppendInput> = [];
  const github = new Map<number, KinResolvedTarget | "down">();
  // Runs inside check 9's read, between check 6 and check 10: a concurrent writer's slot.
  const race: { during?: Effect.Effect<unknown> } = {};
  const roles = Layer.succeed(KinOrgRoles, {
    isOwner: (ref) => Effect.succeed(ref.orgId === orgId && ref.personId === owner),
  });
  const live = Layer.succeed(KinLiveTargets, {
    resolve: ({ target }) =>
      Effect.suspend(() => race.during ?? Effect.void).pipe(
        Effect.andThen(() => {
          const facts = target._tag === "pull_request" ? github.get(target.number) : undefined;
          return facts === undefined || facts === "down"
            ? Effect.fail(
                new KinApprovalError({ reason: "unavailable", message: "GitHub is down." }),
              )
            : Effect.succeed(facts);
        }),
      ),
  });
  // The real chain, recording the grant decisions whichever writer appended them.
  const recordingAudit = Layer.effect(
    KinAudit,
    Effect.gen(function* () {
      const real = yield* makeAudit;
      return KinAudit.of({
        ...real,
        append: (entry) =>
          real
            .append(entry)
            .pipe(
              Effect.tap(() =>
                DECISION_EVENTS.has(entry.event)
                  ? Effect.sync(() => void audit.push(entry))
                  : Effect.void,
              ),
            ),
      });
    }),
  );
  const trust = Layer.succeed(KinAttestationTrust, { load: () => Effect.succeed(fixture.trust) });
  const on = <A, E, R>(database: Layer.Layer<A, E, R>) =>
    grantVerifierLayer.pipe(
      Layer.provideMerge(approverKeysLayer),
      Layer.provideMerge(pendingActionsLayer),
      Layer.provide(Layer.mergeAll(trust, roles, live, grantAuditLayer)),
      Layer.provideMerge(recordingAudit),
      Layer.provideMerge(Layer.provideMerge(KinPersistence.layer, database)),
    );
  const layer = on(Sqlite.layerMemory);
  // Real T3 auth with Kin's proof key hooks, so revocations write what #54 writes.
  const relayLayer = on(layerKinAuthTest("kin-grants-"));
  return { audit, github, race, layer, relayLayer };
}

const seed = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
    VALUES ('org_01', 'Kin', '2026-11-07T00:00:00.000Z')`;
  for (const [id, subject, ip] of [
    ["sess-phone", "phone", "192.168.1.20"],
    ["sess-laptop", "phone", "192.168.1.21"],
    ["sess-member", "phone", "192.168.1.30"],
    ["sess-desktop", "desktop-bootstrap", "127.0.0.1"],
  ] as const) {
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, client_ip_address,
        issued_at, expires_at)
      VALUES (${id}, ${subject}, '[]', 'bearer-access-token', ${ip},
        '2026-11-07T00:00:00.000Z', '2026-12-07T00:00:00.000Z')`;
  }
  return {
    sql,
    keys: yield* ApproverKeys,
    actions: yield* KinPendingActions,
    grants: yield* GrantVerifier,
  };
});

/** Through the real path: key challenge, attested Android registration. */
const register = (keys: ApproverKeys["Service"], from: KinKeyCaller) =>
  Effect.gen(function* () {
    const { challenge } = yield* keys.keyChallenge(from);
    const chain = androidChain(fixture, {
      challenge: new Uint8Array(Buffer.from(challenge, "base64url")),
    });
    const registered = yield* keys.registerKey(from, {
      orgId,
      publicJwk: chain.publicJwk,
      platform: "android",
      challenge,
      attestation: { format: "android-key", certificateChain: chain.certificateChain },
      deviceLabel: "Pixel 9",
    });
    return { ...registered, privateKey: chain.approvalKey.privateKey };
  });

/** The owner's first key, confirmed on the desktop; the member's activated as a later key. */
const enrol = Effect.gen(function* () {
  const world = yield* seed;
  const ownerKey = yield* register(world.keys, ownerPhone);
  yield* world.keys.confirmKey(desktop, {
    orgId,
    thumbprint: ownerKey.key.thumbprint,
    code: ownerKey.code,
  });
  const memberKey = yield* register(world.keys, memberPhone);
  assert.isTrue(yield* world.keys.activateByGrant(memberKey.key));
  yield* world.sql`DELETE FROM kin_pending_actions WHERE kind = 'register_approver_key'`;
  return { ...world, ownerKey, memberKey };
});

const requestMerge = (
  actions: KinPendingActions["Service"],
  number: number,
  github: Map<number, KinResolvedTarget | "down">,
) =>
  Effect.gen(function* () {
    const target = pr(number);
    const resolved = prFacts(sha(number === 212 ? "a" : "b"));
    github.set(number, resolved);
    const input = {
      orgId,
      kind: "merge_pull_request",
      target,
      resolved,
      targetDigest: kinTargetDigest("merge_pull_request", target, resolved),
      reason: "CI is green.",
      requestedBy: { agentId: "lead", threadId: "thread-lead" },
      provenance: {
        startedBy: "github",
        startedByRole: "none",
        chain: [],
        ceilingBelowOwner: true,
      },
      source: decodeEventId(`evt-${number}`),
    } as unknown as KinPendingActionCreateInput;
    return (yield* actions.create(input)).action;
  });

const lowS = (raw: Buffer) => {
  const s = BigInt(`0x${raw.subarray(32).toString("hex")}`);
  const low = s > P256_N / 2n ? P256_N - s : s;
  return { r: raw.subarray(0, 32), s: low };
};
const sigBytes = (r: Buffer, s: bigint) =>
  Buffer.concat([r, Buffer.from(s.toString(16).padStart(64, "0"), "hex")]).toString("base64url");

/** Signs exactly like the phone module: canonical parts, ES256, low-S, r‖s. */
function signGrant(
  privateKey: NodeCrypto.KeyObject,
  header: object,
  payload: object,
  options: { readonly highS?: boolean } = {},
) {
  const input = encodeGrantSigningInput(header as KinGrantHeader, payload as KinGrantPayload);
  const raw = NodeCrypto.sign("sha256", Buffer.from(input), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  const { r, s } = lowS(raw);
  return `${input}.${sigBytes(r, options.highS ? P256_N - s : s)}`;
}

let jtiCounter = 0;
const freshJti = () => Buffer.from(`device-jti-${++jtiCounter}-0000`).toString("base64url");

type Signer = { readonly privateKey: NodeCrypto.KeyObject; readonly kid: string };

/** The phone's flow: ask for the card's payload, add jti/iat/exp, sign. */
const signFor = (
  grants: GrantVerifier["Service"],
  from: KinKeyCaller,
  action: KinPendingAction,
  signer: Signer,
  edit: (payload: Record<string, unknown>) => Record<string, unknown> = (payload) => payload,
) =>
  Effect.gen(function* () {
    const { payload } = yield* grants.challenge(from, { actionId: action.id });
    const full = edit({
      ...payload,
      approver: { ...payload.approver, kid: signer.kid },
      jti: freshJti(),
      iat: NOW_S,
      exp: NOW_S + 600,
    });
    return signGrant(
      signer.privateKey,
      { typ: "kin-grant+jws", alg: "ES256", kid: signer.kid },
      full,
    );
  });

const reasonOf = <A>(exit: Exit.Exit<A, KinApprovalError>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? (exit.cause.reasons[0].error as KinApprovalError).reason
    : "success";

const stateOf = (actions: KinPendingActions["Service"], action: KinPendingAction) =>
  actions.get({ orgId, actionId: action.id }).pipe(Effect.map((found) => Option.getOrThrow(found)));

/** The owner's relay phone: a DPoP session that renews under a new id with the same proof key. */
const relayPhone = (ttl: Duration.Duration) =>
  Effect.gen(function* () {
    const issued = yield* (yield* SessionStore.SessionStore).issue({
      proofKeyThumbprint: "relay-phone",
      ttl,
    });
    const phone = callerFor(issued.sessionId, owner);
    return {
      ...phone,
      session: { ...phone.session, method: "dpop-access-token", proofKeyThumbprint: "relay-phone" },
    } satisfies KinKeyCaller;
  });

const signerOf = (key: { key: { thumbprint: string }; privateKey: NodeCrypto.KeyObject }) => ({
  privateKey: key.privateKey,
  kid: key.key.thumbprint,
});

describe("GrantVerifier", () => {
  it.effect("an owner grant approves the action once, bound to what the card showed", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions, ownerKey } = yield* enrol;
      const action = yield* requestMerge(actions, 212, h.github);
      const { payload, resolved } = yield* grants.challenge(ownerPhone, { actionId: action.id });
      assert.deepStrictEqual(payload, {
        v: 1,
        orgId,
        actionId: action.id,
        revision: 0,
        nonce: action.nonce,
        kind: "merge_pull_request",
        targetDigest: action.targetDigest,
        target: action.target,
        headSha: sha("a"),
        base: "main",
        mergeMethod: "squash",
        approver: { humanId: owner, kid: ownerKey.key.thumbprint },
        decision: "approve",
      });
      assert.deepStrictEqual(resolved, action.resolved);

      const compact = yield* signFor(grants, ownerPhone, action, signerOf(ownerKey));
      // Another session of the same person may send it (check 5).
      const result = yield* grants.submitGrant(ownerLaptop, { compact });
      assert.deepStrictEqual(result, { actionId: action.id, state: "approved" });
      assert.strictEqual((yield* stateOf(actions, action)).state, "approved");
      assert.deepStrictEqual(
        h.audit.map((entry) => [entry.event, entry.result]),
        [["grant_accepted", undefined]],
      );
      assert.strictEqual(h.audit[0]?.sessionId, "sess-laptop");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a member's client sends a forged approval and the server rejects it", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions, memberKey } = yield* enrol;
      const action = yield* requestMerge(actions, 212, h.github);
      // A member gets no challenge, so the forger copies the owner's card facts.
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.challenge(memberPhone, { actionId: action.id }))),
        "not_owner",
      );
      const { payload } = yield* grants.challenge(ownerPhone, { actionId: action.id });
      const compact = signGrant(
        memberKey.privateKey,
        { typ: "kin-grant+jws", alg: "ES256", kid: memberKey.key.thumbprint },
        {
          ...payload,
          approver: { humanId: member, kid: memberKey.key.thumbprint },
          jti: freshJti(),
          iat: NOW_S,
          exp: NOW_S + 600,
        },
      );
      const exit = yield* Effect.exit(grants.submitGrant(memberPhone, { compact }));
      assert.strictEqual(reasonOf(exit), "not_owner");
      assert.strictEqual((yield* stateOf(actions, action)).state, "awaiting_approval");
      assert.deepStrictEqual(h.audit.at(-1), {
        orgId,
        event: "grant_rejected",
        actionId: action.id,
        kind: "merge_pull_request",
        grantJti: Buffer.from(`device-jti-${jtiCounter}-0000`).toString("base64url"),
        keyThumbprint: memberKey.key.thumbprint,
        headSha: sha("a"),
        sessionId: sessionId("sess-member"),
        result: "not_owner",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a grant signed by an unregistered key is rejected", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions } = yield* enrol;
      const action = yield* requestMerge(actions, 212, h.github);
      const stranger = newKey();
      const jwk = stranger.publicKey.export({ format: "jwk" });
      const kid = computeDpopJwkThumbprint({ kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! });
      const compact = yield* signFor(grants, ownerPhone, action, {
        privateKey: stranger.privateKey,
        kid,
      });
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.submitGrant(ownerPhone, { compact }))),
        "unknown_key",
      );
      assert.strictEqual((yield* stateOf(actions, action)).state, "awaiting_approval");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a grant whose header carries a jwk is rejected", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions, ownerKey } = yield* enrol;
      const action = yield* requestMerge(actions, 212, h.github);
      const { payload } = yield* grants.challenge(ownerPhone, { actionId: action.id });
      const header = {
        typ: "kin-grant+jws",
        alg: "ES256",
        kid: ownerKey.key.thumbprint,
        jwk: ownerKey.key.publicJwk,
      };
      const full = { ...payload, jti: freshJti(), iat: NOW_S, exp: NOW_S + 600 };
      const b64 = (value: unknown) => Buffer.from(stableStringify(value)).toString("base64url");
      const input = `${b64(header)}.${b64(full)}`;
      const { r, s } = lowS(
        NodeCrypto.sign("sha256", Buffer.from(input), {
          key: ownerKey.privateKey,
          dsaEncoding: "ieee-p1363",
        }),
      );
      const exit = yield* Effect.exit(
        grants.submitGrant(ownerPhone, { compact: `${input}.${sigBytes(r, s)}` }),
      );
      assert.strictEqual(reasonOf(exit), "malformed");
      assert.strictEqual(h.audit.at(-1)?.result, "malformed");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "a grant signed by a revoked key is rejected, and revoking voids approved actions it signed",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const { grants, actions, keys, ownerKey } = yield* enrol;
        const signed = yield* requestMerge(actions, 212, h.github);
        const waiting = yield* requestMerge(actions, 213, h.github);
        const first = yield* signFor(grants, ownerPhone, signed, signerOf(ownerKey));
        const second = yield* signFor(grants, ownerPhone, waiting, signerOf(ownerKey));
        yield* grants.submitGrant(ownerPhone, { compact: first });

        yield* keys.revokeKey(ownerPhone, ownerKey.key);
        assert.strictEqual((yield* stateOf(actions, signed)).state, "voided");
        const exit = yield* Effect.exit(grants.submitGrant(ownerPhone, { compact: second }));
        assert.strictEqual(reasonOf(exit), "revoked_key");
        assert.strictEqual((yield* stateOf(actions, waiting)).state, "awaiting_approval");
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("an owner grant replayed a second time is rejected", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions, ownerKey, sql } = yield* enrol;
      const action = yield* requestMerge(actions, 212, h.github);
      const compact = yield* signFor(grants, ownerPhone, action, signerOf(ownerKey));
      yield* grants.submitGrant(ownerPhone, { compact });
      const exit = yield* Effect.exit(grants.submitGrant(ownerPhone, { compact }));
      assert.strictEqual(reasonOf(exit), "replayed");
      const rows = yield* sql`SELECT 1 FROM kin_grants`;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(h.audit.at(-1)?.result, "replayed");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("an owner grant for PR 212 can't approve PR 213", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions, ownerKey } = yield* enrol;
      const for212 = yield* requestMerge(actions, 212, h.github);
      const for213 = yield* requestMerge(actions, 213, h.github);
      // Pointed at 213 with 213's nonce, but still describing 212.
      const retargeted = yield* signFor(grants, ownerPhone, for212, signerOf(ownerKey), (p) => ({
        ...p,
        actionId: for213.id,
        nonce: for213.nonce,
      }));
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.submitGrant(ownerPhone, { compact: retargeted }))),
        "target_mismatch",
      );
      // Pointed at 213 with 212's nonce.
      const wrongNonce = yield* signFor(grants, ownerPhone, for212, signerOf(ownerKey), (p) => ({
        ...p,
        actionId: for213.id,
      }));
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.submitGrant(ownerPhone, { compact: wrongNonce }))),
        "stale",
      );
      assert.strictEqual((yield* stateOf(actions, for213)).state, "awaiting_approval");
      assert.strictEqual((yield* stateOf(actions, for212)).state, "awaiting_approval");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a grant for the old nonce fails after a new commit", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions, ownerKey } = yield* enrol;
      const action = yield* requestMerge(actions, 212, h.github);
      const old = yield* signFor(grants, ownerPhone, action, signerOf(ownerKey));
      // Checks alone moving isn't what check 9 compares, so the card shows them without a rotation.
      const failing = {
        ...prFacts(sha("a")),
        checks: [{ name: "ci", required: true, status: "failed" as const }],
      };
      h.github.set(212, failing);
      const reopened = yield* grants.challenge(ownerPhone, { actionId: action.id });
      assert.deepStrictEqual(
        [reopened.payload.revision, reopened.payload.nonce, reopened.resolved],
        [0, action.nonce, failing],
      );
      h.github.set(212, prFacts(sha("c")));
      // Opening the card again re-reads GitHub, bumps the revision and rotates the nonce.
      const { payload } = yield* grants.challenge(ownerPhone, { actionId: action.id });
      assert.strictEqual(payload.revision, 1);
      assert.strictEqual(payload.headSha, sha("c"));
      assert.notStrictEqual(payload.nonce, action.nonce);
      const exit = yield* Effect.exit(grants.submitGrant(ownerPhone, { compact: old }));
      assert.strictEqual(reasonOf(exit), "stale");
      const fresh = yield* signFor(grants, ownerPhone, action, signerOf(ownerKey));
      assert.strictEqual(
        (yield* grants.submitGrant(ownerPhone, { compact: fresh })).state,
        "approved",
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a grant older than 15 minutes is voided before execution", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions, ownerKey, sql } = yield* enrol;
      const action = yield* requestMerge(actions, 212, h.github);
      const compact = yield* signFor(grants, ownerPhone, action, signerOf(ownerKey), (p) => ({
        ...p,
        exp: NOW_S + 900,
      }));
      yield* grants.submitGrant(ownerPhone, { compact });
      const [grant] = yield* sql<{ grant_id: string }>`SELECT grant_id FROM kin_grants`;
      yield* TestClock.adjust("14 minutes");
      assert.deepStrictEqual((yield* actions.sweep()).voided, []);
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual((yield* actions.sweep()).voided, [{ orgId, actionId: action.id }]);
      assert.strictEqual((yield* stateOf(actions, action)).state, "voided");
      const claimed = yield* actions.claim({
        orgId,
        actionId: action.id,
        revision: 0,
        grantId: grant!.grant_id as never,
      });
      assert.isFalse(claimed);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a grant with exp more than 900 s after iat is rejected", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions, ownerKey } = yield* enrol;
      const action = yield* requestMerge(actions, 212, h.github);
      const compact = yield* signFor(grants, ownerPhone, action, signerOf(ownerKey), (p) => ({
        ...p,
        exp: NOW_S + 901,
      }));
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.submitGrant(ownerPhone, { compact }))),
        "time_window",
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("each check rejects with its own reason and leaves the action waiting", () => {
    const h = harness();
    return Effect.gen(function* () {
      const world = yield* enrol;
      const { grants, actions, keys, ownerKey, memberKey } = world;
      const owner_ = signerOf(ownerKey);
      const pending = yield* register(keys, ownerPhone);

      type Case = {
        readonly name: string;
        readonly reason: string;
        readonly build: (action: KinPendingAction) => Effect.Effect<string, KinApprovalError>;
        readonly from?: KinKeyCaller;
        readonly before?: (action: KinPendingAction) => void;
      };
      const edit =
        (change: (p: Record<string, unknown>) => Record<string, unknown>, signer = owner_) =>
        (action: KinPendingAction) =>
          signFor(grants, ownerPhone, action, signer, change);
      const cases: ReadonlyArray<Case> = [
        {
          name: "1: whitespace in a part",
          reason: "malformed",
          build: (action) =>
            edit((p) => p)(action).pipe(
              Effect.map((compact) => {
                const [header, payload, sig] = compact.split(".");
                const text = Buffer.from(payload!, "base64url").toString().replace(":", ": ");
                return `${header}.${Buffer.from(text).toString("base64url")}.${sig}`;
              }),
            ),
        },
        {
          name: "1: wrong typ",
          reason: "malformed",
          build: (action) =>
            grants
              .challenge(ownerPhone, { actionId: action.id })
              .pipe(
                Effect.map(({ payload }) =>
                  signGrant(
                    ownerKey.privateKey,
                    { typ: "JWT", alg: "ES256", kid: owner_.kid },
                    { ...payload, jti: freshJti(), iat: NOW_S, exp: NOW_S + 600 },
                  ),
                ),
              ),
        },
        {
          name: "1: a jti shorter than 16 bytes",
          reason: "malformed",
          build: edit((p) => ({ ...p, jti: Buffer.alloc(15, 1).toString("base64url") })),
        },
        {
          name: "2: a pending key",
          reason: "unknown_key",
          build: edit((p) => p, signerOf(pending)),
        },
        {
          name: "2: approver.kid differs from the header kid",
          reason: "unknown_key",
          build: edit((p) => ({
            ...p,
            approver: { humanId: owner, kid: memberKey.key.thumbprint },
          })),
        },
        {
          name: "3: a flipped signature",
          reason: "bad_signature",
          build: (action) =>
            edit((p) => p)(action).pipe(
              Effect.map((compact) => {
                const sig = Buffer.from(compact.split(".")[2]!, "base64url");
                sig[10]! ^= 1;
                return `${compact.split(".").slice(0, 2).join(".")}.${sig.toString("base64url")}`;
              }),
            ),
        },
        {
          name: "3: the high-S twin",
          reason: "bad_signature",
          build: (action) =>
            grants
              .challenge(ownerPhone, { actionId: action.id })
              .pipe(
                Effect.map(({ payload }) =>
                  signGrant(
                    ownerKey.privateKey,
                    { typ: "kin-grant+jws", alg: "ES256", kid: owner_.kid },
                    { ...payload, jti: freshJti(), iat: NOW_S, exp: NOW_S + 600 },
                    { highS: true },
                  ),
                ),
              ),
        },
        {
          name: "4: approver.humanId isn't the key's person",
          reason: "not_owner",
          build: edit((p) => ({ ...p, approver: { humanId: member, kid: owner_.kid } })),
        },
        {
          name: "4 before 8: a member's expired grant",
          reason: "not_owner",
          from: memberPhone,
          build: edit(
            (p) => ({
              ...p,
              approver: { humanId: member, kid: memberKey.key.thumbprint },
              iat: NOW_S - 1000,
              exp: NOW_S - 500,
            }),
            signerOf(memberKey),
          ),
        },
        {
          name: "5: the owner's grant from the member's session",
          reason: "session_mismatch",
          from: memberPhone,
          build: edit((p) => p),
        },
        {
          name: "5: a session that is nobody",
          reason: "session_mismatch",
          from: nobody,
          build: edit((p) => p),
        },
        { name: "6: wrong revision", reason: "stale", build: edit((p) => ({ ...p, revision: 7 })) },
        {
          name: "6: wrong nonce",
          reason: "stale",
          build: edit((p) => ({ ...p, nonce: Buffer.alloc(32, 7).toString("base64url") })),
        },
        {
          name: "7: another targetDigest",
          reason: "target_mismatch",
          build: edit((p) => ({ ...p, targetDigest: "f".repeat(64) })),
        },
        {
          name: "7: another merge method",
          reason: "target_mismatch",
          build: edit((p) => ({ ...p, target: pr(212, "merge"), mergeMethod: "merge" })),
        },
        {
          name: "7: another headSha",
          reason: "target_mismatch",
          build: edit((p) => ({ ...p, headSha: sha("d") })),
        },
        {
          name: "7: another base",
          reason: "target_mismatch",
          build: edit((p) => ({ ...p, base: "release" })),
        },
        {
          name: "8: iat more than 300 s ago",
          reason: "time_window",
          build: edit((p) => ({ ...p, iat: NOW_S - 301, exp: NOW_S + 100 })),
        },
        {
          name: "8: already expired",
          reason: "time_window",
          build: edit((p) => ({ ...p, iat: NOW_S - 10, exp: NOW_S })),
        },
        {
          name: "8: exp not after iat",
          reason: "time_window",
          build: edit((p) => ({ ...p, iat: NOW_S, exp: NOW_S })),
        },
        {
          name: "9: GitHub shows a new head",
          reason: "head_moved",
          build: edit((p) => p),
          before: (action) => {
            const target = action.target as Extract<KinActionTarget, { _tag: "pull_request" }>;
            h.github.set(target.number, prFacts(sha("e")));
          },
        },
        {
          name: "9: GitHub shows a new base",
          reason: "head_moved",
          build: edit((p) => p),
          before: (action) => {
            const target = action.target as Extract<KinActionTarget, { _tag: "pull_request" }>;
            h.github.set(target.number, prFacts(sha("b"), "release"));
          },
        },
        {
          name: "9: GitHub can't be read",
          reason: "unavailable",
          build: edit((p) => p),
          before: (action) => {
            const target = action.target as Extract<KinActionTarget, { _tag: "pull_request" }>;
            h.github.set(target.number, "down");
          },
        },
      ];

      let number = 300;
      for (const testCase of cases) {
        const action = yield* requestMerge(actions, ++number, h.github);
        const compact = yield* testCase.build(action);
        testCase.before?.(action);
        const exit = yield* Effect.exit(
          grants.submitGrant(testCase.from ?? ownerPhone, { compact }),
        );
        assert.strictEqual(reasonOf(exit), testCase.reason, testCase.name);
        const after = yield* stateOf(actions, action);
        assert.strictEqual(after.state, "awaiting_approval", testCase.name);
        // A moved head rotates the nonce; nothing else touches the action.
        assert.strictEqual(after.revision, testCase.reason === "head_moved" ? 1 : 0, testCase.name);
        if (testCase.from !== nobody)
          assert.deepStrictEqual(
            [h.audit.at(-1)?.event, h.audit.at(-1)?.result],
            ["grant_rejected", testCase.reason],
            testCase.name,
          );
      }
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a grant that loses the race at check 10 is replayed, stale or revoked", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions, keys, ownerKey, sql } = yield* enrol;
      const raced = yield* requestMerge(actions, 212, h.github);
      const compact = yield* signFor(grants, ownerPhone, raced, signerOf(ownerKey));
      // Another grant from the same approver lands after this one passed check 6.
      h.race.during = actions
        .approve({
          orgId,
          actionId: raced.id,
          revision: raced.revision,
          nonce: raced.nonce,
          jti: "concurrent-jti",
          approverHumanId: owner,
          keyThumbprint: ownerKey.key.thumbprint,
          compact: "concurrent",
          iat: NOW_S,
          exp: NOW_S + 600,
        })
        .pipe(Effect.orDie);
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.submitGrant(ownerPhone, { compact }))),
        "replayed",
      );

      const rejected = yield* requestMerge(actions, 213, h.github);
      const late = yield* signFor(grants, ownerPhone, rejected, signerOf(ownerKey));
      h.race.during = actions
        .transition({
          orgId,
          actionId: rejected.id,
          revision: 0,
          to: "rejected",
        })
        .pipe(Effect.orDie);
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.submitGrant(ownerPhone, { compact: late }))),
        "stale",
      );
      assert.strictEqual((yield* stateOf(actions, rejected)).state, "rejected");

      // The signing key's session is revoked, or the key itself, after check 2 passed.
      const laptopKey = yield* register(keys, ownerLaptop);
      assert.isTrue(yield* keys.activateByGrant(laptopKey.key));
      const revocations = [
        {
          number: 214,
          signer: signerOf(laptopKey),
          from: ownerLaptop,
          revoke: Effect.orDie(sql`UPDATE auth_sessions SET revoked_at = '2026-11-08T00:00:00.000Z'
            WHERE session_id = 'sess-laptop'`),
        },
        {
          number: 215,
          signer: signerOf(ownerKey),
          from: ownerPhone,
          revoke: Effect.orDie(keys.revokeKey(ownerPhone, ownerKey.key)),
        },
      ];
      for (const { number, signer, from, revoke } of revocations) {
        const action = yield* requestMerge(actions, number, h.github);
        const signed = yield* signFor(grants, from, action, signer);
        h.race.during = revoke;
        assert.strictEqual(
          reasonOf(yield* Effect.exit(grants.submitGrant(from, { compact: signed }))),
          "revoked_key",
          `${number}`,
        );
        assert.strictEqual((yield* stateOf(actions, action)).state, "awaiting_approval");
      }
      delete h.race.during;
      const held = yield* sql`SELECT 1 FROM kin_grants WHERE action_id IN (
        SELECT action_id FROM kin_pending_actions WHERE state = 'awaiting_approval')`;
      assert.strictEqual(held.length, 0);
      // `approve` records its own refusals; the verifier doesn't write them a second time. The
      // race's own writer re-runs on later reads and has no session, so it is left out.
      assert.deepStrictEqual(
        h.audit
          .filter((entry) => entry.event === "grant_rejected" && entry.sessionId !== undefined)
          .map((entry) => entry.result),
        ["replayed", "stale", "revoked_key", "revoked_key"],
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "revoking a relay phone's renewed session rejects its key's grants, even mid-check",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const { grants, actions, keys } = yield* enrol;
        const sessions = yield* SessionStore.SessionStore;
        const first = yield* relayPhone(Duration.minutes(1));
        const relayKey = yield* register(keys, first);
        assert.isTrue(yield* keys.activateByGrant(relayKey.key));
        yield* TestClock.adjust(Duration.minutes(2));
        const renewed = yield* relayPhone(Duration.hours(1));

        // Settings revokes the session it lists, while check 9 reads GitHub.
        const raced = yield* requestMerge(actions, 212, h.github);
        const compact = yield* signFor(grants, renewed, raced, signerOf(relayKey));
        h.race.during = Effect.orDie(sessions.revoke(renewed.session.sessionId));
        assert.strictEqual(
          reasonOf(yield* Effect.exit(grants.submitGrant(renewed, { compact }))),
          "revoked_key",
        );
        assert.strictEqual((yield* stateOf(actions, raced)).state, "awaiting_approval");
        delete h.race.during;

        const later = yield* requestMerge(actions, 213, h.github);
        const next = yield* signFor(grants, renewed, later, signerOf(relayKey));
        assert.strictEqual(
          reasonOf(yield* Effect.exit(grants.submitGrant(renewed, { compact: next }))),
          "revoked_key",
        );
      }).pipe(Effect.provide(h.relayLayer));
    },
  );

  it.effect(
    "an approved grant can't be claimed once a renewed relay session of its key is revoked",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const { grants, actions, keys, sql } = yield* enrol;
        const sessions = yield* SessionStore.SessionStore;
        const relayKey = yield* register(keys, yield* relayPhone(Duration.minutes(1)));
        assert.isTrue(yield* keys.activateByGrant(relayKey.key));
        yield* TestClock.adjust(Duration.minutes(2));
        const renewed = yield* relayPhone(Duration.hours(1));
        const action = yield* requestMerge(actions, 212, h.github);
        const compact = yield* signFor(grants, renewed, action, signerOf(relayKey));
        yield* grants.submitGrant(renewed, { compact });
        assert.strictEqual((yield* stateOf(actions, action)).state, "approved");

        // No key read runs between the revoke and the claim, so nothing has voided the action yet.
        yield* sessions.revoke(renewed.session.sessionId);
        const [grant] = yield* sql<{ grant_id: string }>`SELECT grant_id FROM kin_grants
        WHERE action_id = ${action.id}`;
        assert.isFalse(
          yield* actions.claim({
            orgId,
            actionId: action.id,
            revision: action.revision,
            grantId: grant!.grant_id as never,
          }),
        );
      }).pipe(Effect.provide(h.relayLayer));
    },
  );

  it.effect("a phone that signs out other devices still approves with its own key", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions, keys } = yield* enrol;
      const sessions = yield* SessionStore.SessionStore;
      const first = yield* relayPhone(Duration.hours(1));
      const relayKey = yield* register(keys, first);
      assert.isTrue(yield* keys.activateByGrant(relayKey.key));
      const renewed = yield* relayPhone(Duration.hours(1));
      yield* sessions.revokeAllExcept(renewed.session.sessionId);

      const action = yield* requestMerge(actions, 212, h.github);
      const compact = yield* signFor(grants, renewed, action, signerOf(relayKey));
      yield* grants.submitGrant(renewed, { compact });
      assert.strictEqual((yield* stateOf(actions, action)).state, "approved");
    }).pipe(Effect.provide(h.relayLayer));
  });

  it.effect("an active key the server never attested can't sign", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions, ownerKey, sql } = yield* enrol;
      const action = yield* requestMerge(actions, 212, h.github);
      const compact = yield* signFor(grants, ownerPhone, action, signerOf(ownerKey));
      // No path stores this row; it stands for a database edited behind the server's back.
      yield* sql`UPDATE kin_approver_keys SET attested = 0 WHERE thumbprint = ${ownerKey.key.thumbprint}`;
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.submitGrant(ownerPhone, { compact }))),
        "unknown_key",
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("rejections are bounded per session per minute, with junk on its own budget", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions, ownerKey, memberKey, sql } = yield* enrol;
      for (let attempt = 0; attempt < 25; attempt++) {
        yield* Effect.exit(grants.submitGrant(memberPhone, { compact: "not.a.grant" }));
      }
      assert.strictEqual(h.audit.length, 20);
      // Past the junk budget, a forgery against the owner's real key is still recorded.
      const action = yield* requestMerge(actions, 212, h.github);
      const forger = { privateKey: memberKey.privateKey, kid: ownerKey.key.thumbprint };
      const forged = yield* signFor(grants, ownerPhone, action, forger);
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.submitGrant(memberPhone, { compact: forged }))),
        "bad_signature",
      );
      assert.deepStrictEqual(
        [h.audit.length, h.audit.at(-1)?.keyThumbprint, h.audit.at(-1)?.sessionId],
        [21, ownerKey.key.thumbprint, "sess-member"],
      );
      // Forgeries against a real key have a budget of their own, so they can't flood the chain either.
      for (let attempt = 0; attempt < 24; attempt++) {
        yield* Effect.exit(grants.submitGrant(memberPhone, { compact: forged }));
      }
      assert.strictEqual(h.audit.length, 40);
      // Another session has its own budget.
      yield* Effect.exit(grants.submitGrant(ownerPhone, { compact: "not.a.grant" }));
      assert.strictEqual(h.audit.length, 41);
      // The skipped counts are written when the windows end, not on a later rejection.
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(
        h.audit.slice(41).map((entry) => [entry.event, entry.sessionId, entry.result]),
        [
          ["grant_rejected", "sess-member", "5 more not recorded"],
          ["grant_rejected", "sess-member", "5 more not recorded"],
        ],
      );

      // Before its signature verifies, a grant naming another org's key is audited in the
      // caller's org: an unproven claim can't write into a chain it doesn't belong to.
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
        VALUES ('org_02', 'Other', '2026-11-07T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_approver_keys SELECT thumbprint, 'org_02', public_jwk_json,
          human_id, device_label, platform, hardware, attested, NULL, NULL, state, created_at,
          confirmed_at, revoked_at
        FROM kin_approver_keys WHERE thumbprint = ${ownerKey.key.thumbprint}`;
      const elsewhere = yield* signFor(grants, ownerPhone, action, forger, (p) => ({
        ...p,
        orgId: "org_02",
      }));
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.submitGrant(memberPhone, { compact: elsewhere }))),
        "bad_signature",
      );
      assert.strictEqual(h.audit.length, 44);
      assert.isTrue(h.audit.every((entry) => entry.orgId === orgId));
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("only the owner can reject, against the card's revision, and it is audited", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions, ownerKey } = yield* enrol;
      const action = yield* requestMerge(actions, 212, h.github);
      const compact = yield* signFor(grants, ownerPhone, action, signerOf(ownerKey));
      const input = { actionId: action.id, revision: 0 };
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.reject(memberPhone, input))),
        "not_owner",
      );
      assert.strictEqual(reasonOf(yield* Effect.exit(grants.reject(nobody, input))), "not_owner");
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.reject(ownerPhone, { ...input, revision: 1 }))),
        "stale",
      );
      assert.deepStrictEqual(yield* grants.reject(ownerPhone, input), {
        actionId: action.id,
        state: "rejected",
      });
      assert.deepStrictEqual(
        [h.audit.at(-1)?.event, h.audit.at(-1)?.sessionId],
        ["action_rejected", "sess-phone"],
      );
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.submitGrant(ownerPhone, { compact }))),
        "stale",
      );
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.challenge(ownerPhone, { actionId: action.id }))),
        "invalid_state",
      );

      // Past `expiresAt` it is expired, not rejected, even before the sweep runs.
      const lapsed = yield* requestMerge(actions, 213, h.github);
      yield* TestClock.adjust("7 days");
      assert.strictEqual(
        reasonOf(
          yield* Effect.exit(grants.reject(ownerPhone, { actionId: lapsed.id, revision: 0 })),
        ),
        "invalid_state",
      );
      assert.strictEqual((yield* stateOf(actions, lapsed)).state, "expired");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("challenge finds actions only in the caller's own org", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { grants, actions, sql } = yield* enrol;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
        VALUES ('org_02', 'Other', '2026-11-07T00:00:00.000Z')`;
      const action = yield* requestMerge(actions, 212, h.github);
      yield* sql`UPDATE kin_pending_actions SET org_id = 'org_02' WHERE action_id = ${action.id}`;
      assert.strictEqual(
        reasonOf(yield* Effect.exit(grants.challenge(ownerPhone, { actionId: action.id }))),
        "not_found",
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("phase 1's org owner is the person bootstrap reserved", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
        VALUES ('kin-default', 'Kin', '2026-11-07T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES (${BOOTSTRAP_OWNER}, 'kin-default', 'owner', 'Owner', '2026-11-07T00:00:00.000Z'),
          ('h_member', 'kin-default', 'priya', 'Priya', '2026-11-07T00:00:00.000Z')`;
      const roles = yield* KinOrgRoles;
      const ask = (org: string, person: string) =>
        roles.isOwner({
          orgId: decodeOrgId(org),
          personId: decodePersonId(person),
        });
      assert.isTrue(yield* ask("kin-default", BOOTSTRAP_OWNER));
      assert.isFalse(yield* ask("kin-default", "h_member"));
      assert.isFalse(yield* ask("org_01", BOOTSTRAP_OWNER));
    }).pipe(
      Effect.provide(
        orgRolesLayer.pipe(
          Layer.provideMerge(Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory)),
        ),
      ),
    ),
  );

  it("no agent, MCP tool or model-reachable path can reach grant decisions", () => {
    const root = NodePath.resolve(import.meta.dirname, "../..");
    const files = (NodeFS.readdirSync(root, { recursive: true }) as Array<string>)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => file.split(NodePath.sep).join("/"))
      .toSorted();
    const source = (file: string) => NodeFS.readFileSync(NodePath.join(root, file), "utf8");
    // Every relative specifier, static or dynamic, resolved from the importing file.
    const imports = (file: string) =>
      [...source(file).matchAll(/(?:from|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)].map((match) =>
        NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(file), match[1]!)),
      );
    const importers = (target: string) => files.filter((file) => imports(file).includes(target));
    const modelFacing = (file: string) =>
      file.startsWith("mcp/") || file.startsWith("kin/mcp/") || file.startsWith("kin/lead/");
    const forbidden = (file: string) => modelFacing(file) || file === "kin/approvals/mcp.ts";

    // Only check 10 moves an action to `approved`, and only the verifier runs it.
    assert.deepStrictEqual(
      files.filter(
        (file) => /KinPendingActions/.test(source(file)) && /\.approve\(/.test(source(file)),
      ),
      ["kin/approvals/GrantVerifier.ts"],
    );
    // The verifier is built in the approvals layer, exposed on KinServer and called by WS only.
    const verifierImporters = importers("kin/approvals/GrantVerifier.ts");
    assert.deepStrictEqual(verifierImporters, [
      "kin/KinServer.ts",
      "kin/approvals/layer.ts",
      "kin/approvals/rpcHandlers.ts",
    ]);
    // Those handlers are served only on the authenticated `/ws` session, never over MCP.
    const handlerImporters = importers("kin/approvals/rpcHandlers.ts");
    assert.deepStrictEqual(handlerImporters, ["kin/rpcHandlers.ts"]);
    assert.deepStrictEqual(importers("kin/rpcHandlers.ts"), ["ws.ts"]);
    // request_action's tool is the one approvals module the model reaches, and it only requests.
    const approvalsImports = (file: string) =>
      imports(file).filter((target) => target.startsWith("kin/approvals/"));
    assert.deepStrictEqual(
      [...new Set(files.filter(modelFacing).flatMap(approvalsImports))],
      ["kin/approvals/mcp.ts"],
    );
    const fromTool = new Set<string>();
    const pending = ["kin/approvals/mcp.ts"];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      for (const target of approvalsImports(file)) {
        if (!fromTool.has(target)) pending.push(target);
        fromTool.add(target);
      }
    }
    assert.deepStrictEqual(
      [...fromTool].filter(
        (file) =>
          [
            "kin/approvals/GrantVerifier.ts",
            "kin/approvals/rpcHandlers.ts",
            "kin/approvals/ApproverKeys.ts",
            "kin/approvals/layer.ts",
          ].includes(file) || file.startsWith("kin/approvals/handlers/"),
      ),
      [],
    );
    assert.deepStrictEqual([...verifierImporters, ...handlerImporters].filter(forbidden), []);
  });
});

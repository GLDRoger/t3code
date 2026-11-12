import { assert, describe, it } from "@effect/vitest";
import {
  AuthKinChatScope,
  AuthSessionId,
  KIN_APPROVER_ENROLMENT_VERSION,
  KinApprovalError,
  KinEventId,
  KinOrgId,
  KinPersonId,
  type KinApprovalsRegisterKeyInput,
  type KinPendingAction,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
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
import { ApproverKeys, layer as approverKeysLayer, type KinKeyCaller } from "./ApproverKeys.ts";
import * as Audit from "./Audit.ts";
import { KinKeyNotices, type KinKeyChange } from "./ExecutionNotices.ts";
import { KinOrgRoles } from "./GrantPorts.ts";
import * as KeySeal from "./KeySeal.ts";
import { KinAttestationTrust } from "./attestation/AttestationTrust.ts";
import { androidChain, makeTrustFixture } from "./attestation/testFixtures.ts";
import { insertActiveKey, insertPendingKey, makeApprovalKey } from "./grant.testkit.ts";
import {
  KIN_APPROVER_KEYS_REQUESTER,
  KinExecutionLedger,
  KinPendingActions,
  kinTargetDigest,
  layer as pendingActionsLayer,
  ledgerLayer,
  type KinPendingActionCreateInput,
} from "./PendingActions.ts";

const NOW = Date.parse("2026-11-08T00:00:00Z");
const fixture = makeTrustFixture();
const trustLayer = Layer.succeed(KinAttestationTrust, {
  load: () => Effect.succeed(fixture.trust),
});
const orgId = Schema.decodeSync(KinOrgId)("org_01");
const owner = Schema.decodeSync(KinPersonId)("h_owner");
const member = Schema.decodeSync(KinPersonId)("h_member");
const otherOrg = Schema.decodeSync(KinOrgId)("org_02");

/** What the owner's chat would have been told, in order, and which changes it refuses to take. */
class NoticeLog extends Context.Service<
  NoticeLog,
  { readonly posted: Array<KinKeyChange>; readonly refuse: Set<KinKeyChange["change"]> }
>()("t3/kin/approvals/ApproverKeys.test/NoticeLog") {}
const noticesLayer = Layer.effect(
  KinKeyNotices,
  Effect.gen(function* () {
    const log = yield* NoticeLog;
    return KinKeyNotices.of({
      changed: (change) =>
        log.refuse.has(change.change)
          ? Effect.fail(new KinApprovalError({ reason: "unavailable", message: "chat down" }))
          : Effect.sync(() => void log.posted.push(change)),
    });
  }),
).pipe(
  Layer.provideMerge(
    Layer.sync(NoticeLog, () => ({ posted: [], refuse: new Set<KinKeyChange["change"]>() })),
  ),
);
const rolesLayer = Layer.succeed(KinOrgRoles, {
  isOwner: (ref) => Effect.succeed(ref.orgId === orgId && ref.personId === owner),
});
const services = Layer.mergeAll(trustLayer, KeySeal.layerTest(), rolesLayer);

const database = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);
const layerWith = (trust: typeof trustLayer) =>
  approverKeysLayer.pipe(
    Layer.provideMerge(Layer.merge(pendingActionsLayer, ledgerLayer)),
    Layer.provideMerge(Audit.layer),
    Layer.provideMerge(noticesLayer),
    Layer.provideMerge(Layer.mergeAll(trust, KeySeal.layerTest(), rolesLayer)),
    Layer.provideMerge(database),
  );
const layer = layerWith(trustLayer);

// Real T3 auth with Kin's proof key hooks, so revocations write what #54 writes.
const relayLayer = approverKeysLayer.pipe(
  Layer.provideMerge(pendingActionsLayer),
  Layer.provideMerge(Audit.layer),
  Layer.provideMerge(noticesLayer),
  Layer.provide(services),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(layerKinAuthTest("kin-approver-keys-")),
);
const sessionId = Schema.decodeSync(AuthSessionId);
const decodeEventId = Schema.decodeSync(KinEventId);

const caller = (id: string, personId: KinPersonId = owner): KinKeyCaller => ({
  session: { sessionId: sessionId(id), subject: id, method: "bearer-access-token", scopes: [] },
  people: [{ _tag: "person", orgId, personId }],
});
const phone = caller("sess-phone");
const laptop = caller("sess-laptop");

const seed = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
    VALUES ('org_01', 'Kin', '2026-11-07T00:00:00.000Z')`;
  return {
    notices: yield* NoticeLog,
    keys: yield* ApproverKeys,
    actions: yield* KinPendingActions,
    ledger: yield* KinExecutionLedger,
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

const androidInput = (
  challenge: string,
  spec: Partial<Parameters<typeof androidChain>[1]> = {},
) => {
  const chain = androidChain(fixture, {
    challenge: new Uint8Array(Buffer.from(challenge, "base64url")),
    ...spec,
  });
  return {
    enrolmentVersion: KIN_APPROVER_ENROLMENT_VERSION,
    orgId,
    publicJwk: chain.publicJwk,
    platform: "android",
    challenge,
    attestation: { format: "android-key", certificateChain: chain.certificateChain },
    deviceLabel: "Pixel 9",
  } satisfies KinApprovalsRegisterKeyInput;
};

const registerAndroid = (
  keys: ApproverKeys["Service"],
  from: KinKeyCaller = phone,
  spec: Partial<Parameters<typeof androidChain>[1]> = {},
) =>
  Effect.gen(function* () {
    const { challenge } = yield* keys.keyChallenge(from);
    const input = androidInput(challenge, spec);
    return { ...(yield* keys.registerKey(from, input)), input };
  });

const errorOf = <A>(exit: Exit.Exit<A, KinApprovalError>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error
    : undefined;
const reasonOf = <A>(exit: Exit.Exit<A, KinApprovalError>) => errorOf(exit)?.reason ?? "success";

const keyCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_approver_keys`;
  return row?.n ?? 0;
});

const auditResults = (event: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ entry_json: string }>`SELECT entry_json FROM kin_audit
      WHERE event = ${event} ORDER BY seq`;
    return rows.map((row) => JSON.parse(row.entry_json).result as string);
  });

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

/** A fresh build of the service over the same database, as a restart would be. */
const restart = ApproverKeys.use(() => Effect.void).pipe(
  Effect.provide(
    Layer.fresh(approverKeysLayer).pipe(
      Layer.provide(Layer.mergeAll(trustLayer, rolesLayer, KeySeal.layerTest())),
    ),
  ),
);

describe("ApproverKeys", () => {
  it.effect("the owner's phone with a trusted attestation can approve at once", () =>
    Effect.gen(function* () {
      const { keys, notices } = yield* seed;
      const { key } = yield* registerAndroid(keys);
      assert.deepInclude(key, { state: "active", attested: true, hardware: "strongbox" });
      assert.deepStrictEqual(yield* keys.requireActive(key), key);
      assert.deepStrictEqual(
        notices.posted.map((notice) => [notice.change, notice.thumbprint, notice.ownerPersonId]),
        [["added", key.thumbprint, owner]],
      );
      assert.deepStrictEqual(yield* auditResults("key_registered"), [
        "set up on the phone; can approve",
      ]);
      const listed = yield* keys.listKeys(laptop, { orgId });
      assert.deepStrictEqual(
        listed.keys.map((listedKey) => listedKey.thumbprint),
        [key.thumbprint],
      );
      assert.deepStrictEqual(
        listed.activity.map((entry) => [entry.change, entry.deviceLabel]),
        [["added", "Pixel 9"]],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a key without a trusted attestation is refused and nothing is stored", () =>
    Effect.gen(function* () {
      const { keys, notices } = yield* seed;
      const { challenge } = yield* keys.keyChallenge(phone);
      const simulator = yield* Effect.exit(
        keys.registerKey(phone, {
          ...androidInput(challenge),
          platform: "ios",
          attestation: undefined,
          deviceLabel: "iPhone",
        }),
      );
      assert.strictEqual(reasonOf(simulator), "unattested");
      // An unlocked bootloader fails Android's checks; so does another platform's format.
      const unlocked = yield* Effect.exit(registerAndroid(keys, phone, { deviceLocked: false }));
      assert.strictEqual(reasonOf(unlocked), "unattested");
      const wrongFormat = yield* keys.keyChallenge(phone);
      const mixed = yield* Effect.exit(
        keys.registerKey(phone, { ...androidInput(wrongFormat.challenge), platform: "ios" }),
      );
      assert.strictEqual(reasonOf(mixed), "unattested");
      assert.strictEqual(yield* keyCount, 0);
      assert.deepStrictEqual(notices.posted, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an app from before one-step set-up is told to update, before anything changes", () =>
    Effect.gen(function* () {
      const { keys, notices } = yield* seed;
      const { challenge } = yield* keys.keyChallenge(phone);
      const { enrolmentVersion: _, ...older } = androidInput(challenge);
      const refused = yield* Effect.exit(keys.registerKey(phone, older));
      // Build 36 shows the message only for `unavailable`, cut at 200 characters.
      assert.strictEqual(reasonOf(refused), "unavailable");
      assert.include(errorOf(refused)?.message, "update the Kin app");
      assert.isAtMost(errorOf(refused)?.message.length ?? 0, 200);
      assert.strictEqual(yield* keyCount, 0);
      assert.deepStrictEqual(notices.posted, []);
      // The challenge wasn't spent, so the updated app goes straight on.
      const { key } = yield* keys.registerKey(phone, androidInput(challenge));
      assert.strictEqual(key.state, "active");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a host that doesn't know the Kin app refuses every phone and says what to set", () =>
    Effect.gen(function* () {
      const { keys } = yield* seed;
      const exit = yield* Effect.exit(registerAndroid(keys));
      assert.strictEqual(reasonOf(exit), "unattested");
      assert.include(errorOf(exit)?.message, "Set KIN_ANDROID_PACKAGE in the host's service.env");
      assert.strictEqual(yield* keyCount, 0);
    }).pipe(
      Effect.provide(
        layerWith(
          Layer.succeed(KinAttestationTrust, {
            load: () => Effect.succeed({ ...fixture.trust, androidApps: [] }),
          }),
        ),
      ),
    ),
  );

  it.effect("only the owner's own session registers a key", () =>
    Effect.gen(function* () {
      const { keys, notices } = yield* seed;
      // Agents, MCP tools, scheduled tasks and workers resolve to no person at all.
      const nobody: KinKeyCaller = { ...caller("sess-agent"), people: [] };
      assert.strictEqual(reasonOf(yield* Effect.exit(keys.keyChallenge(nobody))), "not_owner");
      const refused: ReadonlyArray<readonly [string, KinKeyCaller, KinOrgId]> = [
        ["a teammate", caller("sess-member", member), orgId],
        [
          "a shared or guest session bound to the owner",
          {
            ...caller("sess-guest"),
            session: { ...caller("sess-guest").session, scopes: [AuthKinChatScope] },
          },
          orgId,
        ],
        ["the owner, for another org", caller("sess-other"), otherOrg],
      ];
      for (const [who, from, org] of refused) {
        const { challenge } = yield* keys.keyChallenge(from);
        const exit = yield* Effect.exit(
          keys.registerKey(from, { ...androidInput(challenge), orgId: org }),
        );
        assert.strictEqual(reasonOf(exit), "not_owner", who);
      }
      assert.strictEqual(yield* keyCount, 0);
      assert.deepStrictEqual(notices.posted, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a key challenge is single-use, bound to its session and expires in 5 minutes", () =>
    Effect.gen(function* () {
      const { keys } = yield* seed;
      const { challenge } = yield* keys.keyChallenge(laptop);
      const other = yield* Effect.exit(keys.registerKey(phone, androidInput(challenge)));
      assert.strictEqual(reasonOf(other), "bad_challenge");

      const first = yield* keys.keyChallenge(phone);
      yield* keys.registerKey(phone, androidInput(first.challenge));
      // The same challenge again, for another key.
      const replayed = yield* Effect.exit(keys.registerKey(phone, androidInput(first.challenge)));
      assert.strictEqual(reasonOf(replayed), "bad_challenge");

      const late = yield* keys.keyChallenge(phone);
      yield* TestClock.adjust("5 minutes");
      const expired = yield* Effect.exit(keys.registerKey(phone, androidInput(late.challenge)));
      assert.strictEqual(reasonOf(expired), "bad_challenge");
      assert.strictEqual(yield* keyCount, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an identical retry returns the stored key and posts one notice", () =>
    Effect.gen(function* () {
      const { keys, notices } = yield* seed;
      const first = yield* registerAndroid(keys);
      const again = yield* keys.registerKey(phone, first.input);
      assert.deepStrictEqual(again.key, first.key);
      assert.lengthOf(notices.posted, 1);
      assert.lengthOf(yield* auditResults("key_registered"), 1);
      // The same key from another session, or with other details, is a new registration.
      for (const [from, input] of [
        [laptop, first.input],
        [phone, { ...first.input, deviceLabel: "Owner phone" }],
      ] as const)
        assert.strictEqual(
          reasonOf(yield* Effect.exit(keys.registerKey(from, input))),
          "invalid_state",
        );
      assert.lengthOf(notices.posted, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("two phones set up at once both land, each with its notice", () =>
    Effect.gen(function* () {
      const { keys, notices } = yield* seed;
      const [a, b] = yield* Effect.all(
        [registerAndroid(keys, phone), registerAndroid(keys, laptop)],
        { concurrency: 2 },
      );
      assert.deepStrictEqual([a.key.state, b.key.state], ["active", "active"]);
      assert.sameMembers(
        notices.posted.map((notice) => notice.thumbprint),
        [a.key.thumbprint, b.key.thumbprint],
      );
      assert.lengthOf((yield* keys.listKeys(phone, { orgId })).keys, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("at most 10 phones can approve at once; removing one makes room", () =>
    Effect.gen(function* () {
      const { keys } = yield* seed;
      const added = [];
      for (let index = 0; index < 10; index++)
        added.push(yield* registerAndroid(keys, caller(`sess-phone-${index}`)));
      const full = yield* Effect.exit(registerAndroid(keys, caller("sess-phone-10")));
      assert.strictEqual(reasonOf(full), "too_many_keys");
      assert.strictEqual(yield* keyCount, 10);
      yield* keys.revokeKey(laptop, added[0]!.key);
      assert.strictEqual(
        (yield* registerAndroid(keys, caller("sess-phone-10"))).key.state,
        "active",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "any owner session removes a key, the last one too, voiding what it signed and hasn't run",
    () =>
      Effect.gen(function* () {
        const { keys, actions, ledger, notices, sql } = yield* seed;
        const { key } = yield* registerAndroid(keys);
        const signed = (yield* actions.create(mergeRequest("evt-1"))).action;
        const claimed = (yield* actions.create(mergeRequest("evt-2"))).action;
        const waiting = (yield* actions.create(mergeRequest("evt-3"))).action;
        yield* approveWith(actions, signed, key.thumbprint, "jti-1");
        const approved = yield* approveWith(actions, claimed, key.thumbprint, "jti-2");
        assert.strictEqual(approved._tag, "approved");
        if (approved._tag !== "approved") return;
        // The executor claimed it and hasn't started the write.
        assert.isTrue(
          yield* ledger.claim({
            orgId,
            actionId: claimed.id,
            revision: claimed.revision,
            grantId: approved.grant.id,
          }),
        );

        // A teammate can't; the phone itself can.
        assert.strictEqual(
          reasonOf(yield* Effect.exit(keys.revokeKey(caller("sess-member", member), key))),
          "not_owner",
        );
        const removed = yield* keys.revokeKey(phone, key);
        assert.strictEqual(removed.state, "revoked");
        assert.strictEqual(reasonOf(yield* Effect.exit(keys.requireActive(key))), "revoked_key");
        const states = yield* sql<{ action_id: string; state: string; reason: string | null }>`
          SELECT action_id, state, state_reason AS reason FROM kin_pending_actions
          ORDER BY created_at, action_id`;
        assert.deepStrictEqual(
          Object.fromEntries(states.map((row) => [row.action_id, [row.state, row.reason]])),
          {
            [signed.id]: ["voided", "key_revoked"],
            [claimed.id]: ["voided", "key_revoked"],
            [waiting.id]: ["awaiting_approval", null],
          },
        );
        const [execution] = yield* sql<{ outcome: string; finished: number }>`
          SELECT outcome, finished_at IS NOT NULL AS finished FROM kin_executions`;
        assert.deepStrictEqual(execution, { outcome: "failed", finished: 1 });

        // A retry answers with the stored key and posts nothing more.
        assert.deepStrictEqual(yield* keys.revokeKey(laptop, key), removed);
        assert.deepStrictEqual(
          notices.posted.map((notice) => [notice.change, notice.lastKey]),
          [
            ["added", false],
            ["removed", true],
          ],
        );
        assert.deepStrictEqual(yield* auditResults("key_revoked"), ["removed by the owner"]);
        const listed = yield* keys.listKeys(laptop, { orgId });
        assert.deepStrictEqual(listed.keys, []);
        assert.deepStrictEqual(
          listed.activity.map((entry) => entry.change),
          ["removed", "added"],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("another org's key reads as unknown", () =>
    Effect.gen(function* () {
      const { keys, sql } = yield* seed;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
        VALUES ('org_02', 'Other', '2026-11-07T00:00:00.000Z')`;
      const theirs = makeApprovalKey();
      yield* insertActiveKey({ key: theirs, orgId: otherOrg, humanId: owner });
      assert.strictEqual(
        reasonOf(yield* Effect.exit(keys.revokeKey(laptop, { orgId, thumbprint: theirs.kid }))),
        "not_found",
      );
      assert.strictEqual(
        reasonOf(yield* Effect.exit(keys.listKeys(laptop, { orgId: otherOrg }))),
        "not_owner",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a key change rolls back when its notice can't be written", () =>
    Effect.gen(function* () {
      const { keys, notices } = yield* seed;
      notices.refuse.add("added");
      assert.strictEqual(reasonOf(yield* Effect.exit(registerAndroid(keys))), "unavailable");
      assert.strictEqual(yield* keyCount, 0);
      assert.deepStrictEqual(yield* auditResults("key_registered"), []);

      notices.refuse.clear();
      const { key } = yield* registerAndroid(keys);
      notices.refuse.add("removed");
      assert.strictEqual(reasonOf(yield* Effect.exit(keys.revokeKey(laptop, key))), "unavailable");
      assert.strictEqual((yield* keys.requireActive(key)).state, "active");
      assert.deepStrictEqual(yield* auditResults("key_revoked"), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keys active before the seal shipped are sealed on the first start only", () =>
    Effect.gen(function* () {
      const { keys, sql } = yield* seed;
      const legacy = yield* registerAndroid(keys);
      const later = yield* registerAndroid(keys, laptop);
      // As every active key was before K027: no seal.
      yield* sql`UPDATE kin_approver_keys SET seal = NULL WHERE org_id = ${orgId}`;
      const upgraded = yield* Layer.build(KeySeal.layerTest({ adopted: false }));
      const start = Layer.fresh(approverKeysLayer).pipe(
        Layer.provide(Layer.mergeAll(trustLayer, rolesLayer, Layer.succeedContext(upgraded))),
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

  it.effect("a key forged or edited in SQLite never signs", () =>
    Effect.gen(function* () {
      const { keys, sql } = yield* seed;
      const genuine = yield* registerAndroid(keys);
      const [real] = yield* sql<{ seal: string }>`
        SELECT seal FROM kin_approver_keys WHERE thumbprint = ${genuine.key.thumbprint}`;
      // A software key posing as attested, carrying a real row's seal.
      const forged = makeApprovalKey();
      yield* sql`INSERT INTO kin_approver_keys (thumbprint, org_id, public_jwk_json, human_id,
          device_label, platform, hardware, attested, session_id, state, created_at, seal)
        VALUES (${forged.kid}, ${orgId}, ${forged.publicJwkJson}, ${owner}, 'iPhone', 'ios',
          'secure_enclave', 1, 'sess-phone', 'active', ${NOW}, ${real!.seal})`;
      assert.isFalse((yield* keys.requireActive({ orgId, thumbprint: forged.kid })).attested);
      // `created_at` bounds the session-revocation check, so moving it voids the seal.
      yield* sql`UPDATE kin_approver_keys SET created_at = created_at + 1
        WHERE thumbprint = ${genuine.key.thumbprint}`;
      assert.isFalse((yield* keys.requireActive(genuine.key)).attested);
      yield* sql`ALTER TABLE kin_approver_keys RENAME TO kin_approver_keys_gone`;
      assert.strictEqual(
        reasonOf(yield* Effect.exit(keys.listKeys(laptop, { orgId }))),
        "unavailable",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keys still waiting from the old flow run out at start, once, audited", () =>
    Effect.gen(function* () {
      const { keys, sql } = yield* seed;
      const kept = yield* registerAndroid(keys);
      const waiting = makeApprovalKey();
      yield* insertPendingKey({ key: waiting, orgId, humanId: owner });
      yield* restart;
      yield* restart;
      const rows = yield* sql<{ thumbprint: string; state: string; confirmed: number }>`
        SELECT thumbprint, state, confirmed_at IS NOT NULL AS confirmed FROM kin_approver_keys
        ORDER BY created_at, thumbprint`;
      assert.deepStrictEqual(rows, [
        { thumbprint: waiting.kid, state: "revoked", confirmed: 0 },
        { thumbprint: kept.key.thumbprint, state: "active", confirmed: 1 },
      ]);
      assert.deepStrictEqual(yield* auditResults("key_revoked"), [
        "ran out: it waited to be allowed and never was; set up again on the phone",
      ]);
      assert.isTrue((yield* keys.requireActive(kept.key)).attested);
      // Never active, so it isn't a change the owner sees.
      const listed = yield* keys.listKeys(laptop, { orgId });
      assert.deepStrictEqual(
        listed.activity.map((entry) => entry.change),
        ["added"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("phone-to-phone requests close at start, expired or not, once", () =>
    Effect.gen(function* () {
      const { keys, actions, sql } = yield* seed;
      const lost = yield* registerAndroid(keys);
      const target = (thumbprint: string) =>
        ({ _tag: "device_key", thumbprint, hardware: "strongbox", attested: true }) as const;
      const request = (thumbprint: string, source: string) =>
        actions.create({
          ...mergeRequest(source),
          kind: "register_approver_key",
          target: target(thumbprint),
          resolved: { _tag: "none" },
          targetDigest: kinTargetDigest("register_approver_key", target(thumbprint), {
            _tag: "none",
          }),
          requestedBy: {
            agentId: KIN_APPROVER_KEYS_REQUESTER,
            threadId: KIN_APPROVER_KEYS_REQUESTER,
          },
          provenance: {
            startedBy: { humanId: owner },
            startedByRole: "owner",
            chain: [],
            ceilingBelowOwner: false,
          },
        } as unknown as KinPendingActionCreateInput);
      const expired = (yield* request(makeApprovalKey().kid, "evt-a")).action;
      const approved = (yield* request(makeApprovalKey().kid, "evt-b")).action;
      yield* approveWith(actions, approved, lost.key.thumbprint, "jti-b");
      yield* TestClock.adjust("8 days");
      const live = (yield* request(makeApprovalKey().kid, "evt-c")).action;
      yield* restart;
      yield* restart;
      const states = yield* sql<{ action_id: string; state: string; state_reason: string }>`
        SELECT action_id, state, state_reason FROM kin_pending_actions ORDER BY action_id`;
      assert.deepStrictEqual(
        Object.fromEntries(states.map((row) => [row.action_id, [row.state, row.state_reason]])),
        {
          [expired.id]: ["cancelled", "phone_approval_retired"],
          [approved.id]: ["voided", "phone_approval_retired"],
          [live.id]: ["cancelled", "phone_approval_retired"],
        },
      );
      const audited = yield* sql<{ event: string }>`SELECT event FROM kin_audit
        WHERE event IN ('action_cancelled', 'action_voided') ORDER BY seq`;
      assert.deepStrictEqual(audited.map((row) => row.event).toSorted(), [
        "action_cancelled",
        "action_cancelled",
        "action_voided",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("revoking the T3 session a key was registered from revokes the key", () =>
    Effect.gen(function* () {
      const { keys, actions, sql } = yield* seed;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at,
          expires_at)
        VALUES ('sess-phone', 'phone', '[]', 'bearer-access-token', '2026-11-07T00:00:00.000Z',
          '2026-12-07T00:00:00.000Z')`;
      const { key } = yield* registerAndroid(keys);
      const signed = (yield* actions.create(mergeRequest("evt-1"))).action;
      yield* approveWith(actions, signed, key.thumbprint, "jti-1");
      yield* sql`UPDATE auth_sessions SET revoked_at = '2026-11-08T00:00:00.000Z'
        WHERE session_id = 'sess-phone'`;

      assert.strictEqual(reasonOf(yield* Effect.exit(keys.requireActive(key))), "revoked_key");
      assert.deepStrictEqual((yield* keys.listKeys(laptop, { orgId })).keys, []);
      const voided = Option.getOrThrow(yield* actions.get({ orgId, actionId: signed.id }));
      assert.strictEqual(voided.stateReason, "session_revoked");
      assert.deepStrictEqual(yield* auditResults("key_revoked"), [
        "the session it was set up from was signed out",
      ]);
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
      assert.strictEqual(Option.getOrThrow(yield* keys.get(own.key)).state, "active");
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
      assert.strictEqual(Option.getOrThrow(yield* keys.get(key)).state, "active");
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
      assert.strictEqual(Option.getOrThrow(yield* keys.get(key)).state, "active");
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
      assert.strictEqual(Option.getOrThrow(yield* keys.get(second.key)).state, "active");
      assert.strictEqual(Option.getOrThrow(yield* keys.get(first.key)).state, "revoked");
    }).pipe(Effect.provide(relayLayer)),
  );
});

import { assert, describe, it } from "@effect/vitest";
import {
  KinEventId,
  KinKeyThumbprint,
  KinPersonId,
  type KinPendingAction,
  type KinResolvedTarget,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import {
  KinPendingActions,
  kinIdempotencyKey,
  KinExecutionLedger,
  layer as pendingActionsLayer,
  ledgerLayer,
  type KinPendingActionCreateInput,
} from "./PendingActions.ts";
import * as Audit from "./Audit.ts";

const database = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);
const layer = Layer.merge(pendingActionsLayer, ledgerLayer).pipe(
  Layer.provideMerge(Audit.layer),
  Layer.provideMerge(database),
);

const decodeEventId = Schema.decodeSync(KinEventId);
const owner = Schema.decodeSync(KinPersonId)("h_owner");
const kid = Schema.decodeSync(KinKeyThumbprint)("Y0ZkXVc6eNfxv3xVNHZJp1x7m3kQqb2O8s5vB1aWc9E");
const digest = (char: string) => char.repeat(64);
const resolved = (headSha: string): KinResolvedTarget => ({
  _tag: "pull_request",
  headSha,
  base: "main",
  head: "kin/fix-212",
  title: "Fix 212",
  additions: 3,
  deletions: 1,
  files: 1,
  checks: [{ name: "ci", required: true, status: "passed" }],
});

// `create` decodes its input, so a bad fixture fails loudly rather than slipping through.
const request = (source: string, number = 212) =>
  ({
    orgId: "org_01",
    kind: "merge_pull_request",
    target: {
      _tag: "pull_request",
      host: "github.com",
      repo: "GLDRoger/t3code",
      number,
      mergeMethod: "squash",
      deleteBranchAfter: false,
    },
    resolved: resolved("a".repeat(40)),
    targetDigest: digest("1"),
    reason: "CI is green.",
    requestedBy: { agentId: "lead", threadId: "thread-lead" },
    provenance: { startedBy: "github", startedByRole: "none", chain: [], ceilingBelowOwner: true },
    source: decodeEventId(source),
  }) as unknown as KinPendingActionCreateInput;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
    VALUES ('org_01', 'Kin', '2026-11-07T00:00:00.000Z')`;
  // Check 10 approves only while the signing key is active.
  yield* sql`INSERT INTO kin_approver_keys (thumbprint, org_id, public_jwk_json, human_id,
      device_label, platform, hardware, attested, state, created_at)
    VALUES (${kid}, 'org_01', '{}', ${owner}, 'Pixel 9', 'android', 'tee', 1, 'active', 0)`;
  // The executor's ledger alongside, so these tests can claim and finish directly.
  return { ...(yield* KinPendingActions), ...(yield* KinExecutionLedger) };
});

const grant = (action: KinPendingAction, jti: string, iat = 0, exp = 600) => ({
  orgId: action.orgId,
  actionId: action.id,
  revision: action.revision,
  nonce: action.nonce,
  jti,
  approverHumanId: owner,
  keyThumbprint: kid,
  compact: `compact-${jti}`,
  iat,
  exp,
});

const count = (table: "kin_pending_actions" | "kin_grants" | "kin_executions") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`;
    return row?.n;
  });

describe("KinPendingActions", () => {
  it.effect("a replayed webhook and a deferral firing twice create one pending action", () =>
    Effect.gen(function* () {
      const actions = yield* seed;
      const first = yield* actions.create(request("webhook-delivery-1"));
      const replayed = yield* actions.create(request("webhook-delivery-1"));
      assert.isTrue(first.created);
      assert.isFalse(replayed.created);
      assert.deepStrictEqual(replayed.action, first.action);
      // The key comes from the decoded input, so an undeclared field can't fork the action.
      const padded = request("webhook-delivery-1");
      const withExtra = yield* actions.create({
        ...padded,
        target: { ...padded.target, extra: "ignored" },
      } as unknown as KinPendingActionCreateInput);
      assert.isFalse(withExtra.created);
      assert.strictEqual(withExtra.action.id, first.action.id);
      // Key registration's requester id is reserved, so an agent can't pose as the phone.
      for (const requestedBy of [
        { agentId: "kin-approver-keys", threadId: "thread-lead" },
        { agentId: "kin-approver-keys", threadId: "kin-approver-keys" },
      ]) {
        const posing = yield* Effect.exit(
          actions.create({
            ...request("webhook-delivery-2"),
            requestedBy,
          } as unknown as KinPendingActionCreateInput),
        );
        assert.isTrue(Exit.isFailure(posing));
      }

      const twice = yield* Effect.all(
        [
          actions.create(request("deferral-7@2026-11-08")),
          actions.create(request("deferral-7@2026-11-08")),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(twice.map((result) => result.created).toSorted(), [false, true]);
      assert.strictEqual(twice[0].action.id, twice[1].action.id);
      assert.strictEqual(yield* count("kin_pending_actions"), 2);

      assert.strictEqual(first.action.state, "awaiting_approval");
      assert.strictEqual(first.action.revision, 0);
      assert.match(first.action.id, /^act_[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.match(first.action.nonce, /^[A-Za-z0-9_-]{43}$/);
      assert.deepStrictEqual(first.action.requiredApprovers, [{ role: "owner" }]);
      assert.strictEqual(
        first.action.expiresAt.epochMilliseconds - first.action.createdAt.epochMilliseconds,
        7 * 24 * 60 * 60 * 1000,
      );
      assert.strictEqual(
        first.action.idempotencyKey,
        kinIdempotencyKey(request("webhook-delivery-1")),
      );
      assert.notStrictEqual(
        kinIdempotencyKey(request("webhook-delivery-1", 213)),
        first.action.idempotencyKey,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a new commit rotates the nonce on the same action and stales the old grant", () =>
    Effect.gen(function* () {
      const actions = yield* seed;
      const { action } = yield* actions.create(request("delivery-1"));
      const refreshed = yield* actions.refresh({
        orgId: action.orgId,
        actionId: action.id,
        revision: 0,
        resolved: resolved("b".repeat(40)),
        targetDigest: digest("2"),
      });
      assert.isTrue(Option.isSome(refreshed));
      const next = Option.getOrThrow(refreshed);
      assert.strictEqual(next.id, action.id);
      assert.strictEqual(next.idempotencyKey, action.idempotencyKey);
      assert.strictEqual(next.revision, 1);
      assert.notStrictEqual(next.nonce, action.nonce);
      assert.strictEqual(next.targetDigest, digest("2"));
      // Losing writer: the revision it read is gone.
      assert.isTrue(
        Option.isNone(
          yield* actions.refresh({
            orgId: action.orgId,
            actionId: action.id,
            revision: 0,
            resolved: resolved("c".repeat(40)),
            targetDigest: digest("3"),
          }),
        ),
      );

      assert.deepStrictEqual(yield* actions.approve(grant(action, "jti-old")), { _tag: "stale" });
      assert.deepStrictEqual(
        yield* actions.approve({ ...grant(next, "jti-old-nonce"), nonce: action.nonce }),
        { _tag: "stale" },
      );
      assert.strictEqual(yield* count("kin_grants"), 0);
      assert.strictEqual(
        Option.getOrThrow(yield* actions.get({ orgId: action.orgId, actionId: action.id })).state,
        "awaiting_approval",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("approves once, refuses a replayed grant and only approved actions can be voided", () =>
    Effect.gen(function* () {
      const actions = yield* seed;
      const { action } = yield* actions.create(request("delivery-1"));
      const ref = { orgId: action.orgId, actionId: action.id, revision: 0 };
      assert.isFalse(yield* actions.transition({ ...ref, to: "voided" }));

      const approved = yield* actions.approve(grant(action, "jti-1"));
      assert.strictEqual(approved._tag, "approved");
      if (approved._tag === "approved") {
        assert.strictEqual(approved.grant.jti, "jti-1");
        assert.isNull(approved.grant.consumedAt);
      }
      assert.deepStrictEqual(yield* actions.approve(grant(action, "jti-1")), { _tag: "replayed" });
      assert.deepStrictEqual(yield* actions.approve(grant(action, "jti-2")), { _tag: "replayed" });
      assert.strictEqual(yield* count("kin_grants"), 1);
      assert.isFalse(yield* actions.transition({ ...ref, to: "rejected" }));
      assert.isTrue(yield* actions.transition({ ...ref, to: "voided", reason: "key_revoked" }));
      assert.isFalse(yield* actions.transition({ ...ref, to: "voided" }));
      const voided = Option.getOrThrow(
        yield* actions.get({ orgId: action.orgId, actionId: action.id }),
      );
      assert.strictEqual(voided.state, "voided");
      assert.strictEqual(voided.stateReason, "key_revoked");
      // A voided action whose grant is still live never runs.
      if (approved._tag === "approved")
        assert.isFalse(yield* actions.claim({ ...ref, grantId: approved.grant.id }));
      assert.strictEqual(yield* count("kin_executions"), 0);

      const other = (yield* actions.create(request("delivery-2"))).action;
      const otherRef = { orgId: other.orgId, actionId: other.id, revision: 0 };
      const outcomes = yield* Effect.all(
        [
          actions.transition({ ...otherRef, to: "rejected" }),
          actions.transition({ ...otherRef, to: "cancelled" }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(outcomes.toSorted(), [false, true]);
      assert.deepStrictEqual(yield* actions.approve(grant(other, "jti-3")), { _tag: "stale" });

      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
        VALUES ('org_02', 'Other', '2026-11-07T00:00:00.000Z')`;
      const foreign = (yield* actions.create({
        ...request("delivery-1"),
        orgId: "org_02",
      } as unknown as KinPendingActionCreateInput)).action;
      assert.deepStrictEqual(yield* actions.approve(grant(foreign, "jti-1")), { _tag: "stale" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("two executors racing on one action run it once", () =>
    Effect.gen(function* () {
      const actions = yield* seed;
      const { action } = yield* actions.create(request("delivery-1"));
      const approved = yield* actions.approve(grant(action, "jti-1"));
      assert.strictEqual(approved._tag, "approved");
      if (approved._tag !== "approved") return;
      const claim = {
        orgId: action.orgId,
        actionId: action.id,
        revision: 0,
        grantId: approved.grant.id,
      };

      const claims = yield* Effect.all([actions.claim(claim), actions.claim(claim)], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(claims.toSorted(), [false, true]);
      assert.isFalse(yield* actions.claim(claim));
      // The executions row is the claim: even a state wrongly reset to approved can't rerun it.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_pending_actions SET state = 'approved' WHERE action_id = ${action.id}`;
      assert.isFalse(yield* actions.claim(claim));
      yield* sql`UPDATE kin_pending_actions SET state = 'executing' WHERE action_id = ${action.id}`;
      assert.strictEqual(yield* count("kin_executions"), 1);
      assert.strictEqual(
        Option.getOrThrow(yield* actions.get({ orgId: action.orgId, actionId: action.id })).state,
        "executing",
      );

      const [consumed] = yield* sql<{ consumed_at: number | null }>`
        SELECT consumed_at FROM kin_grants WHERE grant_id = ${approved.grant.id}`;
      assert.isNotNull(consumed?.consumed_at);

      const ref = { orgId: action.orgId, actionId: action.id };
      assert.isTrue(
        yield* actions.finish({ ...ref, outcome: "succeeded", mergeCommitSha: "f".repeat(40) }),
      );
      assert.isFalse(yield* actions.finish({ ...ref, outcome: "failed" }));
      assert.strictEqual(
        Option.getOrThrow(yield* actions.get({ orgId: action.orgId, actionId: action.id })).state,
        "succeeded",
      );
      assert.deepStrictEqual(
        yield* sql`SELECT outcome, merge_commit_sha FROM kin_executions WHERE action_id = ${action.id}`,
        [{ outcome: "succeeded", merge_commit_sha: "f".repeat(40) }],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("deadlines hold at the boundary even before the sweep runs", () =>
    Effect.gen(function* () {
      const actions = yield* seed;
      const week = 7 * 24 * 60 * 60 * 1000;
      const state = (action: KinPendingAction) =>
        actions
          .get({ orgId: action.orgId, actionId: action.id })
          .pipe(Effect.map((found) => Option.getOrThrow(found).state));
      const approveAt = Effect.fn(function* (source: string, exp: number) {
        const { action } = yield* actions.create(request(source));
        const approved = yield* actions.approve(grant(action, `jti-${source}`, 0, exp));
        assert.strictEqual(approved._tag, "approved");
        if (approved._tag !== "approved") return yield* Effect.die("not approved");
        return {
          action,
          claim: actions.claim({
            orgId: action.orgId,
            actionId: action.id,
            revision: 0,
            grantId: approved.grant.id,
          }),
        };
      });

      // A grant lapses at exp (seconds) when that binds first...
      const expBoundOk = yield* approveAt("exp-ok", 600);
      const expBoundLate = yield* approveAt("exp-late", 600);
      // ...and at acceptedAt + 15 min otherwise.
      const acceptedOk = yield* approveAt("accepted-ok", 3600);
      const acceptedLate = yield* approveAt("accepted-late", 3600);
      yield* TestClock.adjust("599999 millis");
      assert.isTrue(yield* expBoundOk.claim);
      yield* TestClock.adjust("1 millis");
      assert.isFalse(yield* expBoundLate.claim);
      assert.strictEqual(yield* state(expBoundLate.action), "approved");
      yield* TestClock.adjust("299999 millis");
      assert.isTrue(yield* acceptedOk.claim);
      yield* TestClock.adjust("1 millis");
      assert.isFalse(yield* acceptedLate.claim);
      assert.strictEqual(yield* state(acceptedLate.action), "approved");
      // A grant already past its own exp can't approve, even while the action is still open.
      const deadGrantFor = (yield* actions.create(request("dead-grant"))).action;
      assert.deepStrictEqual(yield* actions.approve(grant(deadGrantFor, "jti-dead", 0, 600)), {
        _tag: "stale",
      });
      assert.strictEqual(yield* state(deadGrantFor), "awaiting_approval");

      const created = yield* Clock.currentTimeMillis;
      const approvable = (yield* actions.create(request("approve-ok"))).action;
      const unapprovable = (yield* actions.create(request("approve-late"))).action;
      const refreshable = (yield* actions.create(request("refresh"))).action;
      const refresh = (revision: number) =>
        actions.refresh({
          orgId: refreshable.orgId,
          actionId: refreshable.id,
          revision,
          resolved: resolved("b".repeat(40)),
          targetDigest: digest("2"),
        });
      const expire = (action: KinPendingAction) =>
        actions.transition({
          orgId: action.orgId,
          actionId: action.id,
          revision: action.revision,
          to: "expired",
        });

      yield* TestClock.adjust(`${created + week - 1 - (yield* Clock.currentTimeMillis)} millis`);
      assert.isFalse(yield* expire(unapprovable));
      const nowS = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      assert.strictEqual(
        (yield* actions.approve(grant(approvable, "jti-approve-ok", nowS, nowS + 600)))._tag,
        "approved",
      );
      assert.isTrue(Option.isSome(yield* refresh(0)));
      yield* TestClock.adjust("1 millis");
      assert.deepStrictEqual(
        yield* actions.approve(grant(unapprovable, "jti-approve-late", nowS, nowS + 600)),
        { _tag: "stale" },
      );
      assert.isTrue(Option.isNone(yield* refresh(1)));
      assert.strictEqual(yield* state(unapprovable), "awaiting_approval");
      assert.isTrue(yield* expire(unapprovable));
      assert.strictEqual(yield* state(unapprovable), "expired");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("the sweep expires unapproved actions and voids approvals whose grant lapsed", () =>
    Effect.gen(function* () {
      const actions = yield* seed;
      const waiting = (yield* actions.create(request("delivery-1"))).action;
      const approvedAction = (yield* actions.create(request("delivery-2"))).action;
      // iat 300 s ahead of the server: acceptedAt + 15 min binds before exp.
      const approved = yield* actions.approve(grant(approvedAction, "jti-1", 300, 1200));
      assert.strictEqual(approved._tag, "approved");

      yield* TestClock.adjust("899999 millis");
      assert.deepStrictEqual(yield* actions.sweep(), { expired: [], voided: [] });
      yield* TestClock.adjust("1 millis");
      assert.deepStrictEqual(yield* actions.sweep(), {
        expired: [],
        voided: [{ orgId: approvedAction.orgId, actionId: approvedAction.id }],
      });
      if (approved._tag === "approved") {
        assert.isFalse(
          yield* actions.claim({
            orgId: approvedAction.orgId,
            actionId: approvedAction.id,
            revision: 0,
            grantId: approved.grant.id,
          }),
        );
      }
      assert.strictEqual(yield* count("kin_executions"), 0);

      yield* TestClock.adjust(`${7 * 24 * 60 * 60 * 1000 - 900_000} millis`);
      assert.deepStrictEqual(yield* actions.sweep(), {
        expired: [{ orgId: waiting.orgId, actionId: waiting.id }],
        voided: [],
      });
      assert.strictEqual(
        Option.getOrThrow(yield* actions.get({ orgId: waiting.orgId, actionId: waiting.id })).state,
        "expired",
      );
      assert.deepStrictEqual(yield* actions.approve(grant(waiting, "jti-2")), { _tag: "stale" });
    }).pipe(Effect.provide(layer)),
  );
});

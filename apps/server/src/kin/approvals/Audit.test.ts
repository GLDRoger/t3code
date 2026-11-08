import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KinEventId,
  KinKeyThumbprint,
  KinOrgId,
  KinPersonId,
  type KinAuditEvent,
  type KinPendingAction,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Kin from "../layer.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { KinAudit, kinAuditHash, layer as auditLayer } from "./Audit.ts";
import {
  KinPendingActions,
  layer as pendingActionsLayer,
  type KinPendingActionCreateInput,
} from "./PendingActions.ts";
import { makeKinApprovalHandlers } from "./rpcHandlers.ts";

const database = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);
const layer = pendingActionsLayer.pipe(
  Layer.provideMerge(auditLayer),
  Layer.provideMerge(database),
);

const org = Schema.decodeSync(KinOrgId)("org_01");
const otherOrg = Schema.decodeSync(KinOrgId)("org_02");
const defaultOrg = Schema.decodeSync(KinOrgId)("kin-default");
const decodeEventId = Schema.decodeSync(KinEventId);
const owner = Schema.decodeSync(KinPersonId)("h_owner");
const kid = Schema.decodeSync(KinKeyThumbprint)("Y0ZkXVc6eNfxv3xVNHZJp1x7m3kQqb2O8s5vB1aWc9E");
const sessionId = AuthSessionId.make("phone-session");
const headSha = "a".repeat(40);
const mergeSha = "f".repeat(40);

const request = {
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
    headSha,
    base: "main",
    head: "kin/fix-212",
    title: "Fix 212",
    additions: 3,
    deletions: 1,
    files: 1,
    checks: [{ name: "ci", required: true, status: "passed" }],
  },
  targetDigest: "1".repeat(64),
  reason: "CI is green.",
  requestedBy: { agentId: "lead", threadId: "thread-lead" },
  provenance: { startedBy: "github", startedByRole: "none", chain: [] },
  source: decodeEventId("webhook-delivery-1"),
} as unknown as KinPendingActionCreateInput;

const grant = (action: KinPendingAction, jti: string) => ({
  orgId: action.orgId,
  actionId: action.id,
  revision: action.revision,
  nonce: action.nonce,
  jti,
  approverHumanId: owner,
  keyThumbprint: kid,
  compact: `compact-${jti}`,
  iat: 0,
  exp: 600,
  sessionId,
  deviceLabel: "Owner's iPhone",
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES
    ('org_01', 'Kin', '2026-11-07T00:00:00.000Z'),
    ('org_02', 'Other', '2026-11-07T00:00:00.000Z')`;
  return yield* KinAudit;
});

// Five entries in org_01, so each tamper case has a row in the middle to break.
const seedChain = Effect.gen(function* () {
  const audit = yield* seed;
  for (const event of [
    "key_registered",
    "key_confirmed",
    "grant_rejected",
    "key_revoked",
    "credential_check_failed",
  ] as const) {
    yield* audit.append({ orgId: org, event, result: event });
  }
  return audit;
});

describe("KinAudit", () => {
  it.effect("the audit chain detects an edited row", () =>
    Effect.gen(function* () {
      const audit = yield* seedChain;
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* audit.verify({ orgId: org }), {
        ok: true,
        checked: 5,
        firstBadSeq: null,
      });

      // Editing the canonical entry, as someone hiding a failure would.
      yield* sql`UPDATE kin_audit SET entry_json = replace(entry_json, '"result":"grant_rejected"',
        '"result":"grant_accepted"') WHERE org_id = ${org} AND seq = 3`;
      assert.deepStrictEqual(yield* audit.verify({ orgId: org }), {
        ok: false,
        checked: 2,
        firstBadSeq: 3,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([
    {
      name: "an edited column",
      tamper: (sql: SqlClient.SqlClient) =>
        sql`UPDATE kin_audit SET event = 'grant_accepted' WHERE org_id = ${org} AND seq = 3`,
    },
    {
      name: "a rehashed edit",
      // The edited row's own hash is recomputed, so only the next row's prevHash gives it away.
      tamper: (sql: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          const [row] = yield* sql<{ entry_json: string }>`
            SELECT entry_json FROM kin_audit WHERE org_id = ${org} AND seq = 3`;
          const { hash: _hash, ...unhashed } = JSON.parse(row!.entry_json);
          const edited = { ...unhashed, result: "grant_accepted" };
          const hash = kinAuditHash(edited);
          yield* sql`UPDATE kin_audit SET entry_json = ${stableStringify({ ...edited, hash })},
            hash = ${hash} WHERE org_id = ${org} AND seq = 3`;
        }),
      firstBadSeq: 4,
    },
    {
      name: "a deleted row",
      tamper: (sql: SqlClient.SqlClient) =>
        sql`DELETE FROM kin_audit WHERE org_id = ${org} AND seq = 3`,
    },
    {
      name: "reordered rows",
      tamper: (sql: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          yield* sql`UPDATE kin_audit SET seq = 100 WHERE org_id = ${org} AND seq = 3`;
          yield* sql`UPDATE kin_audit SET seq = 3 WHERE org_id = ${org} AND seq = 4`;
          yield* sql`UPDATE kin_audit SET seq = 4 WHERE org_id = ${org} AND seq = 100`;
        }),
    },
    {
      name: "an inserted row",
      // A forged entry chained correctly onto seq 2, with every later row shifted down by one.
      tamper: (sql: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          const [prev] = yield* sql<{ hash: string }>`
            SELECT hash FROM kin_audit WHERE org_id = ${org} AND seq = 2`;
          yield* sql`UPDATE kin_audit SET seq = seq + 100 WHERE org_id = ${org} AND seq >= 3`;
          yield* sql`UPDATE kin_audit SET seq = seq - 99 WHERE org_id = ${org} AND seq >= 103`;
          const unhashed = {
            id: "aud_forged",
            orgId: org,
            seq: 3,
            at: "2026-11-08T00:00:00.000Z",
            event: "grant_accepted",
            prevHash: prev!.hash,
          };
          const hash = kinAuditHash(unhashed);
          yield* sql`INSERT INTO kin_audit (id, org_id, seq, at, event, entry_json, prev_hash, hash)
            VALUES ('aud_forged', ${org}, 3, ${Date.parse(unhashed.at)}, 'grant_accepted',
              ${stableStringify({ ...unhashed, hash })}, ${prev!.hash}, ${hash})`;
        }),
      firstBadSeq: 4,
    },
  ])("verify catches $name", ({ tamper, firstBadSeq = 3 }) =>
    Effect.gen(function* () {
      const audit = yield* seedChain;
      const sql = yield* SqlClient.SqlClient;
      yield* audit.append({ orgId: otherOrg, event: "key_registered" });
      yield* tamper(sql);
      assert.deepStrictEqual(yield* audit.verify({ orgId: org }), {
        ok: false,
        checked: firstBadSeq - 1,
        firstBadSeq,
      });
      // Chains are per org: the other org's stays intact.
      assert.deepStrictEqual(yield* audit.verify({ orgId: otherOrg }), {
        ok: true,
        checked: 1,
        firstBadSeq: null,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("concurrent appends form one gapless chain per org", () =>
    Effect.gen(function* () {
      const audit = yield* seed;
      const appended = yield* Effect.all(
        Array.from({ length: 40 }, (_, index) =>
          audit.append({ orgId: index % 2 === 0 ? org : otherOrg, event: "key_registered" }),
        ),
        { concurrency: "unbounded" },
      );
      for (const orgId of [org, otherOrg]) {
        const seqs = appended
          .filter((entry) => entry.orgId === orgId)
          .map((entry) => entry.seq)
          .toSorted((left, right) => left - right);
        assert.deepStrictEqual(
          seqs,
          Array.from({ length: 20 }, (_, index) => index + 1),
        );
        assert.deepStrictEqual(yield* audit.verify({ orgId }), {
          ok: true,
          checked: 20,
          firstBadSeq: null,
        });
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists entries a page at a time", () =>
    Effect.gen(function* () {
      const audit = yield* seedChain;
      const first = yield* audit.list({ orgId: org, limit: 2 });
      assert.deepStrictEqual(
        first.entries.map((entry) => entry.seq),
        [1, 2],
      );
      assert.isTrue(first.hasMore);
      const last = yield* audit.list({ orgId: org, afterSeq: 4, limit: 2 });
      assert.deepStrictEqual(
        last.entries.map((entry) => entry.event),
        ["credential_check_failed"],
      );
      assert.isFalse(last.hasMore);
      const all = (yield* audit.list({ orgId: org, limit: 200 })).entries;
      assert.strictEqual(last.entries[0]!.prevHash, all[3]!.hash);
      assert.deepStrictEqual((yield* audit.list({ orgId: otherOrg, limit: 10 })).entries, []);
    }).pipe(Effect.provide(layer)),
  );
});

describe("KinPendingActions audit trail", () => {
  it.effect("a merge leaves a complete trail: request, grant, device, SHA and merge commit", () =>
    Effect.gen(function* () {
      const audit = yield* seed;
      const actions = yield* KinPendingActions;
      const { action } = yield* actions.create(request);
      yield* actions.create(request); // replayed webhook: no second entry
      const refreshed = Option.getOrThrow(
        yield* actions.refresh({
          orgId: org,
          actionId: action.id,
          revision: 0,
          resolved: { ...request.resolved, headSha: "b".repeat(40) } as typeof request.resolved,
          targetDigest: "2".repeat(64),
        }),
      );
      assert.deepStrictEqual(yield* actions.approve(grant(action, "jti-old")), { _tag: "stale" });
      const approved = yield* actions.approve(grant(refreshed, "jti-1"));
      assert.strictEqual(approved._tag, "approved");
      if (approved._tag !== "approved") return;
      assert.isTrue(
        yield* actions.claim({
          orgId: org,
          actionId: action.id,
          revision: 1,
          grantId: approved.grant.id,
        }),
      );
      assert.isTrue(
        yield* actions.finish({
          orgId: org,
          actionId: action.id,
          outcome: "succeeded",
          mergeCommitSha: mergeSha,
        }),
      );

      const { entries } = yield* audit.list({ orgId: org, limit: 50 });
      assert.deepStrictEqual(
        entries.map((entry) => entry.event),
        [
          "action_requested",
          "action_refreshed",
          "grant_rejected",
          "grant_accepted",
          "execution_started",
          "execution_finished",
        ] satisfies ReadonlyArray<KinAuditEvent>,
      );
      const [requested, refreshedEntry, rejected, accepted, started, finished] = entries;
      assert.deepStrictEqual(requested!.target, request.target);
      assert.deepStrictEqual(requested!.provenance, request.provenance);
      assert.strictEqual(requested!.headSha, headSha);
      assert.strictEqual(refreshedEntry!.headSha, "b".repeat(40));
      assert.include(rejected!, { grantJti: "jti-old", result: "stale", sessionId });
      assert.include(accepted!, {
        actionId: action.id,
        kind: "merge_pull_request",
        headSha: "b".repeat(40),
        grantJti: "jti-1",
        keyThumbprint: kid,
        sessionId,
        deviceLabel: "Owner's iPhone",
      });
      assert.include(started!, { grantJti: "jti-1", headSha: "b".repeat(40) });
      assert.strictEqual(finished!.result, mergeSha);
      // The audit holds the jti and thumbprint, never the signed token.
      assert.notInclude(JSON.stringify(entries), "compact-jti");
      assert.deepStrictEqual(yield* audit.verify({ orgId: org }), {
        ok: true,
        checked: 6,
        firstBadSeq: null,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("terminal moves, the sweep and reconciliation each leave their own entry", () =>
    Effect.gen(function* () {
      const audit = yield* seed;
      const actions = yield* KinPendingActions;
      const create = (source: string) =>
        actions
          .create({ ...request, source: decodeEventId(source) })
          .pipe(Effect.map(({ action }) => action));
      const rejected = yield* create("a");
      const cancelled = yield* create("b");
      const reconciled = yield* create("c");
      const waiting = yield* create("d");
      const lapsing = yield* create("e");
      const ref = (action: KinPendingAction) => ({
        orgId: org,
        actionId: action.id,
        revision: 0,
      });
      assert.isTrue(yield* actions.transition({ ...ref(rejected), to: "rejected", sessionId }));
      assert.isTrue(yield* actions.transition({ ...ref(cancelled), to: "cancelled" }));
      assert.isFalse(yield* actions.transition({ ...ref(cancelled), to: "rejected" }));
      const approved = yield* actions.approve(grant(reconciled, "jti-r"));
      if (approved._tag !== "approved") return assert.fail("not approved");
      yield* actions.claim({ ...ref(reconciled), grantId: approved.grant.id });
      yield* actions.finish({
        orgId: org,
        actionId: reconciled.id,
        outcome: "interrupted",
        error: "still open after restart",
        reconciled: true,
      });

      assert.strictEqual((yield* actions.approve(grant(lapsing, "jti-l")))._tag, "approved");
      yield* TestClock.adjust("8 days");
      const swept = yield* actions.sweep();
      assert.strictEqual(swept.expired.length + swept.voided.length, 2);

      const { entries } = yield* audit.list({ orgId: org, limit: 50 });
      const byAction = (action: KinPendingAction) =>
        entries.filter((entry) => entry.actionId === action.id).map((entry) => entry.event);
      assert.deepStrictEqual(byAction(rejected), ["action_requested", "action_rejected"]);
      assert.deepStrictEqual(byAction(cancelled), ["action_requested", "action_cancelled"]);
      assert.deepStrictEqual(byAction(reconciled), [
        "action_requested",
        "grant_accepted",
        "execution_started",
        "execution_reconciled",
      ]);
      assert.deepStrictEqual(byAction(waiting), ["action_requested", "action_expired"]);
      assert.deepStrictEqual(byAction(lapsing), [
        "action_requested",
        "grant_accepted",
        "action_voided",
      ]);
      assert.strictEqual(
        entries.find((entry) => entry.event === "execution_reconciled")!.result,
        "interrupted: still open after restart",
      );
      assert.strictEqual(
        entries.find((entry) => entry.event === "action_voided")!.result,
        "grant_expired",
      );
      assert.strictEqual(
        entries.find((entry) => entry.event === "action_rejected")!.sessionId,
        sessionId,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a transition rolls back when its audit entry can't be written", () =>
    Effect.gen(function* () {
      yield* seed;
      const actions = yield* KinPendingActions;
      const sql = yield* SqlClient.SqlClient;
      const { action } = yield* actions.create(request);
      yield* sql`CREATE TRIGGER kin_audit_refuse BEFORE INSERT ON kin_audit
        BEGIN SELECT RAISE(ABORT, 'audit refused'); END`;
      const failure = yield* actions
        .transition({ orgId: org, actionId: action.id, revision: 0, to: "rejected" })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PersistenceSqlError");
      assert.strictEqual(
        Option.getOrThrow(yield* actions.get({ orgId: org, actionId: action.id })).state,
        "awaiting_approval",
      );
    }).pipe(Effect.provide(layer)),
  );
});

describe("kin.audit RPCs", () => {
  it.effect("only the org owner can list or verify the audit", () =>
    Effect.gen(function* () {
      const kin = yield* Kin.KinServer.pipe(
        Effect.provide(
          Kin.layer.pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
          ),
        ),
      );
      assert.isTrue(Option.isSome(kin.services));
      const handlersFor = (scopes: AuthenticatedSession["scopes"]) =>
        makeKinApprovalHandlers({
          sessionId,
          subject: "browser",
          method: "browser-session-cookie",
          scopes,
        }).pipe(Effect.provideService(Kin.KinServer, kin));
      const ownerHandlers = yield* handlersFor(AuthStandardClientScopes);
      assert.deepStrictEqual(yield* ownerHandlers["kin.audit.verify"]({ orgId: defaultOrg }), {
        ok: true,
        checked: 0,
        firstBadSeq: null,
      });
      assert.include(
        yield* ownerHandlers["kin.audit.list"]({ orgId: otherOrg, limit: 10 }).pipe(Effect.flip),
        { reason: "not_owner" },
      );
      const memberHandlers = yield* handlersFor([]);
      assert.include(
        yield* memberHandlers["kin.audit.verify"]({ orgId: defaultOrg }).pipe(Effect.flip),
        { reason: "not_owner" },
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  );
});

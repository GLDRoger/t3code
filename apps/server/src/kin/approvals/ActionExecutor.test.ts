// @effect-diagnostics nodeBuiltinImport:off -- node:fs reads the import graph for the reachability guard.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  KinEventId,
  KinKeyThumbprint,
  KinOrgId,
  KinPersonId,
  type KinActionTarget,
  type KinGrantPayload,
  type KinResolvedTarget,
} from "@t3tools/contracts";
import { encodeGrantSigningInput } from "@t3tools/shared/kinGrant";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinBotReads from "../github/KinBotReads.ts";
import * as KinGitHubApp from "../github/KinGitHubApp.ts";
import * as OwnerMergeClient from "../github/OwnerMergeClient.ts";
import {
  fakeGitHub,
  memoryKeychain,
  scopeLayer,
  type FakeAnswer,
  type RecordedRequest,
} from "../github/testFakes.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as ActionExecutor from "./ActionExecutor.ts";
import * as ActionHandlers from "./ActionHandlers.ts";
import * as Audit from "./Audit.ts";
import * as CredentialHygiene from "./CredentialHygiene.ts";
import { KinOrgRoles } from "./GrantPorts.ts";
import { makeDeleteBranchHandler } from "./handlers/deleteBranch.ts";
import { makeMergePullRequestHandler } from "./handlers/mergePullRequest.ts";
import * as PendingActions from "./PendingActions.ts";

const NOW = Date.parse("2026-11-08T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const orgId = Schema.decodeSync(KinOrgId)("org_01");
const owner = Schema.decodeSync(KinPersonId)("h_owner");
const kid = Schema.decodeSync(KinKeyThumbprint)("Y0ZkXVc6eNfxv3xVNHZJp1x7m3kQqb2O8s5vB1aWc9E");
const decodeEventId = Schema.decodeSync(KinEventId);
const REPO = "GLDRoger/t3code";
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const MERGED = "c".repeat(40);
const OWNER_TOKEN = "github_pat_owner_merge_token_never_logged";
const BOT_TOKEN = "ghs_bot_read_token";
const PULL = `/repos/${REPO}/pulls/212`;
const SIGNATURE = Buffer.alloc(64, 7).toString("base64url");

const prTarget = (deleteBranchAfter = false): KinActionTarget => ({
  _tag: "pull_request",
  host: "github.com",
  repo: REPO,
  number: 212,
  mergeMethod: "squash",
  deleteBranchAfter,
});
const prFacts: KinResolvedTarget = {
  _tag: "pull_request",
  headSha: HEAD,
  base: "kin",
  head: "kin/fix-212",
  title: "Fix 212",
  additions: 3,
  deletions: 1,
  files: 1,
  checks: [{ name: "Check", required: true, status: "passed" }],
};

/** GitHub as the executor sees it; tests change it between calls. */
interface World {
  pull: { state: "open" | "closed"; merged: boolean; mergeCommitSha: string | null; head: string };
  merge: FakeAnswer;
  /** Whether a merge call lands on GitHub, whatever it answers. */
  mergeLands: boolean;
  branches: Map<string, string>;
  down: boolean;
}

const mergedPull = { state: "closed", merged: true, mergeCommitSha: MERGED, head: HEAD } as const;
const openPull = { state: "open", merged: false, mergeCommitSha: null, head: HEAD } as const;

function harness() {
  const world: World = {
    pull: { ...openPull },
    merge: {
      status: 200,
      body: { merged: true, sha: MERGED, message: "Pull Request successfully merged" },
      headers: { "x-github-request-id": "REQ-1" },
    },
    mergeLands: true,
    branches: new Map([
      ["kin/fix-212", HEAD],
      ["kin/stale", HEAD],
    ]),
    down: false,
  };
  const github = fakeGitHub((request): FakeAnswer => {
    if (world.down) return { status: 502, body: { message: "Bad gateway" } };
    const key = `${request.method} ${request.path}`;
    if (key === `GET ${PULL}`)
      return {
        status: 200,
        body: {
          state: world.pull.state,
          merged: world.pull.merged,
          merge_commit_sha: world.pull.mergeCommitSha,
          head: { sha: world.pull.head, ref: "kin/fix-212", repo: { full_name: REPO } },
          base: { ref: "kin" },
        },
      };
    if (key === `GET /repos/${REPO}/rules/branches/kin`)
      return { status: 200, body: [{ type: "pull_request" }] };
    if (key === `GET /repos/${REPO}`) return { status: 200, body: { default_branch: "kin" } };
    if (key === `PUT ${PULL}/merge`) {
      if (world.mergeLands && world.pull.head === HEAD) world.pull = { ...mergedPull };
      return world.merge;
    }
    const ref = /^GET \/repos\/GLDRoger\/t3code\/git\/ref\/heads\/(.+)$/.exec(key)?.[1];
    if (ref !== undefined) {
      const sha = world.branches.get(decodeURIComponent(ref));
      return sha === undefined
        ? { status: 404, body: { message: "Not Found" } }
        : { status: 200, body: { object: { sha } } };
    }
    const deleted = /^DELETE \/repos\/GLDRoger\/t3code\/git\/refs\/heads\/(.+)$/.exec(key)?.[1];
    if (deleted !== undefined) {
      world.branches.delete(decodeURIComponent(deleted));
      return { status: 204 };
    }
    return { status: 404, body: { message: "Not Found" } };
  });
  const keychain = memoryKeychain({
    [`kin-owner-merge/${orgId}`]: JSON.stringify({
      token: OWNER_TOKEN,
      login: "Nishchay",
      expiresAt: NOW + 30 * DAY,
      savedAt: NOW,
    }),
  });
  const notices: Array<{ readonly actionId: string; readonly outcome: string }> = [];
  // What the owner is told about the credential check; `posted` lets a test await each one.
  const credentialNotices: {
    readonly sent: Array<{
      readonly orgId: string;
      readonly failures: ReadonlyArray<string>;
      readonly recoveredFrom?: number;
    }>;
    posted?: (failures: ReadonlyArray<string>) => Effect.Effect<unknown>;
  } = { sent: [] };
  const noticed = Deferred.makeUnsafe<void>();
  // Each credential check runs `during` with its count; `failing` makes the identity unreadable.
  const checks: {
    count: number;
    failing: boolean;
    during?: (count: number) => Effect.Effect<unknown>;
  } = { count: 0, failing: false };
  const mints: Array<string> = [];

  const app = Layer.succeed(
    KinGitHubApp.KinGitHubApp,
    KinGitHubApp.KinGitHubApp.of({
      app: Effect.die("unused"),
      installations: Effect.die("unused"),
      patchHookConfig: () => Effect.die("unused"),
      installationToken: (input) => {
        mints.push(`${input.holder} ${JSON.stringify(input.permissions)}`);
        return Effect.succeed({
          token: Redacted.make(BOT_TOKEN),
          repo: input.repo,
          expiresAt: "2026-11-08T01:00:00Z",
          permissions: { ...input.permissions, metadata: "read" },
        });
      },
    }),
  );
  const scope = scopeLayer({ repos: [REPO] });
  const githubStack = Layer.mergeAll(KinBotReads.layer, OwnerMergeClient.layer).pipe(
    Layer.provide(Layer.mergeAll(app, github.layer, keychain.layer, scope)),
  );
  const identity = Layer.succeed(CredentialHygiene.T3GitHubIdentity, {
    identities: Effect.suspend(() => {
      checks.count += 1;
      return checks.during?.(checks.count) ?? Effect.void;
    }).pipe(
      Effect.andThen(() =>
        checks.failing
          ? Effect.fail(new CredentialHygiene.T3GitHubIdentityError({ cause: "probe failed" }))
          : Effect.succeed({
              t3: [{ login: "kin-bot", source: "app" }],
              ghAccounts: ["kin-bot"],
              gitCredential: Option.none(),
              ssh: ["git@github.com: Permission denied (publickey)."],
            }),
      ),
    ),
  });
  const hygiene = CredentialHygiene.layer.pipe(
    Layer.provide(identity),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    Layer.provide(scope),
  );
  const handlers = Layer.effect(
    ActionHandlers.KinActionHandlers,
    Effect.all([makeMergePullRequestHandler, makeDeleteBranchHandler]).pipe(
      Effect.map(ActionHandlers.make),
    ),
  );
  const notifications = Layer.succeed(
    ActionExecutor.KinExecutionNotices,
    ActionExecutor.KinExecutionNotices.of({
      credentialCheck: ({ orgId: org, report, recoveredFrom }) =>
        Effect.sync(() =>
          credentialNotices.sent.push({
            orgId: org,
            failures: report.failures,
            ...(recoveredFrom === undefined ? {} : { recoveredFrom }),
          }),
        ).pipe(Effect.andThen(credentialNotices.posted?.(report.failures) ?? Effect.void)),
      finished: ({ action, outcome }) =>
        Effect.sync(() => void notices.push({ actionId: action.id, outcome })).pipe(
          Effect.andThen(Deferred.succeed(noticed, undefined)),
          Effect.asVoid,
        ),
    }),
  );
  const roles = Layer.succeed(KinOrgRoles, {
    isOwner: (ref) => Effect.succeed(ref.orgId === orgId && ref.personId === owner),
  });
  const deps = Layer.mergeAll(handlers, hygiene).pipe(
    Layer.provideMerge(githubStack),
    Layer.provideMerge(PendingActions.layer),
    Layer.provideMerge(Layer.mergeAll(notifications, roles)),
    Layer.provideMerge(Audit.layer),
    Layer.provideMerge(Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory)),
  );
  // Without the worker, so each test drives the executor itself.
  const layer = Layer.effect(ActionExecutor.KinActionExecutor, ActionExecutor.make).pipe(
    Layer.provideMerge(deps),
  );
  return {
    world,
    requests: github.requests,
    notices,
    credentialNotices,
    noticed,
    checks,
    mints,
    layer,
    deps,
  };
}

const seed = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
    VALUES ('org_01', 'Kin', '2026-11-07T00:00:00.000Z')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${owner}, 'org_01', 'nishchay', 'Nishchay', '2026-11-07T00:00:00.000Z')`;
  yield* sql`INSERT INTO kin_approver_keys (thumbprint, org_id, public_jwk_json, human_id,
      device_label, platform, hardware, attested, state, created_at)
    VALUES (${kid}, 'org_01', '{}', ${owner}, 'Pixel 9', 'android', 'tee', 1, 'active', 0)`;
  return { sql, actions: yield* PendingActions.KinPendingActions };
});

let jtiCounter = 0;

/** Creates an action and approves it through `PendingActions`, as check 10 does. */
const approved = (input: {
  readonly kind: "merge_pull_request" | "delete_branch";
  readonly target: KinActionTarget;
  readonly resolved: KinResolvedTarget;
  readonly source: string;
}) =>
  Effect.gen(function* () {
    const actions = yield* PendingActions.KinPendingActions;
    const { action } = yield* actions.create({
      orgId,
      kind: input.kind,
      target: input.target,
      resolved: input.resolved,
      targetDigest: PendingActions.kinTargetDigest(input.kind, input.target, input.resolved),
      reason: "CI is green.",
      requestedBy: { agentId: "lead", threadId: "thread-lead" },
      provenance: {
        startedBy: "github",
        startedByRole: "none",
        chain: [],
        ceilingBelowOwner: true,
      },
      source: decodeEventId(input.source),
    } as unknown as PendingActions.KinPendingActionCreateInput);
    jtiCounter += 1;
    const jti = `jti${String(jtiCounter).padStart(19, "0")}`;
    const iat = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const headSha = input.resolved._tag === "none" ? undefined : input.resolved.headSha;
    const payload = {
      v: 1,
      orgId,
      actionId: action.id,
      revision: action.revision,
      nonce: action.nonce,
      jti,
      kind: action.kind,
      targetDigest: action.targetDigest,
      target: action.target,
      ...(headSha === undefined ? {} : { headSha }),
      ...(input.resolved._tag === "pull_request" && action.target._tag === "pull_request"
        ? { base: input.resolved.base, mergeMethod: action.target.mergeMethod }
        : {}),
      approver: { humanId: owner, kid },
      decision: "approve",
      iat,
      exp: iat + 600,
    } as unknown as KinGrantPayload;
    const header = { typ: "kin-grant+jws", alg: "ES256", kid } as const;
    const result = yield* actions.approve({
      orgId,
      actionId: action.id,
      revision: action.revision,
      nonce: action.nonce,
      jti,
      approverHumanId: owner,
      keyThumbprint: kid,
      compact: `${encodeGrantSigningInput(header, payload)}.${SIGNATURE}`,
      iat,
      exp: iat + 600,
    });
    assert.strictEqual(result._tag, "approved");
    return { orgId, actionId: action.id, jti };
  });
const approvedMerge = (source: string, deleteBranchAfter = false) =>
  approved({
    kind: "merge_pull_request",
    target: prTarget(deleteBranchAfter),
    resolved: prFacts,
    source,
  });

/** A crash right after the claim: the row stays `executing` with no result. */
const claimedThenCrashed = (source: string) =>
  Effect.gen(function* () {
    const actions = yield* PendingActions.KinPendingActions;
    const ref = yield* approvedMerge(source);
    const found = (yield* actions.approvedWithGrant(orgId)).find(
      (item) => item.action.id === ref.actionId,
    );
    assert.isTrue(yield* actions.claim({ ...ref, revision: 0, grantId: found!.grant.id }));
    return ref;
  });

const stateOf = (ref: PendingActions.ActionRef) =>
  Effect.gen(function* () {
    const actions = yield* PendingActions.KinPendingActions;
    const action = Option.getOrThrow(yield* actions.get(ref));
    return { state: action.state, reason: action.stateReason };
  });
const executions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    action_id: string;
    outcome: string | null;
    merge_commit_sha: string | null;
    github_request_id: string | null;
  }>`SELECT action_id, outcome, merge_commit_sha, github_request_id FROM kin_executions
    ORDER BY action_id`;
});
const auditEntries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ entry_json: string }>`SELECT entry_json FROM kin_audit
    WHERE org_id = ${orgId} ORDER BY seq`;
  return rows.map((row) => JSON.parse(row.entry_json) as Record<string, unknown>);
});
const writes = (requests: ReadonlyArray<RecordedRequest>) =>
  requests.filter((request) => request.method !== "GET").map((r) => `${r.method} ${r.path}`);

describe("KinActionExecutor", () => {
  it.effect("merges an approved PR at the exact SHA and audits who approved it", () => {
    const { requests, notices, mints, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      const ref = yield* approvedMerge("webhook-1", true);
      assert.deepStrictEqual(yield* executor.execute(ref), {
        _tag: "finished",
        outcome: "succeeded",
      });
      assert.deepStrictEqual(yield* stateOf(ref), { state: "succeeded", reason: undefined });
      const merge = requests.find((request) => request.method === "PUT");
      assert.deepStrictEqual(merge?.body, { sha: HEAD, merge_method: "squash" });
      assert.strictEqual(merge?.authorization, `Bearer ${OWNER_TOKEN}`);
      // Reads use the bot's read-only `server` token, never the owner's.
      assert.isTrue(
        requests
          .filter((request) => request.method === "GET")
          .every((request) => request.authorization === `Bearer ${BOT_TOKEN}`),
      );
      assert.isTrue(
        mints.every((mint) => mint === 'server {"pull_requests":"read","contents":"read"}'),
      );
      // `deleteBranchAfter`: the merged head branch goes, with the owner's token.
      assert.deepStrictEqual(writes(requests), [
        `PUT ${PULL}/merge`,
        `DELETE /repos/${REPO}/git/refs/heads/kin/fix-212`,
      ]);
      assert.deepInclude((yield* executions)[0], {
        outcome: "succeeded",
        merge_commit_sha: MERGED,
        github_request_id: "REQ-1",
      });
      const entries = yield* auditEntries;
      assert.deepStrictEqual(
        entries.map((entry) => entry.event),
        ["action_requested", "grant_accepted", "execution_started", "execution_finished"],
      );
      assert.deepInclude(entries.at(-1), {
        actionId: ref.actionId,
        kind: "merge_pull_request",
        headSha: HEAD,
        grantJti: ref.jti,
        keyThumbprint: kid,
        deviceLabel: "Pixel 9",
        result: MERGED,
      });
      assert.deepStrictEqual(notices, [{ actionId: ref.actionId, outcome: "succeeded" }]);
      // One grant, one run.
      assert.deepStrictEqual(yield* executor.execute(ref), { _tag: "skipped" });
      assert.lengthOf(writes(requests), 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("the head moving between approval and merge stops the merge", () => {
    const { world, requests, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      // The precheck sees the new head: no merge call at all.
      world.pull.head = MOVED;
      const moved = yield* approvedMerge("webhook-1");
      assert.deepInclude(yield* executor.execute(moved), { _tag: "finished", outcome: "failed" });
      const precheck = yield* stateOf(moved);
      assert.strictEqual(precheck.state, "failed");
      assert.match(precheck.reason ?? "", /^head_moved/);
      assert.deepStrictEqual(writes(requests), []);

      // With the precheck passing, GitHub's 409 from the `sha` pin maps to head_moved.
      world.pull = { ...openPull };
      world.mergeLands = false;
      world.merge = {
        status: 409,
        body: { message: "Head branch was modified. Review and try the merge again." },
        headers: { "x-github-request-id": "REQ-409" },
      };
      const raced = yield* approvedMerge("webhook-2");
      assert.deepInclude(yield* executor.execute(raced), { _tag: "finished", outcome: "failed" });
      const pinned = yield* stateOf(raced);
      assert.strictEqual(pinned.state, "failed");
      assert.match(pinned.reason ?? "", /^head_moved: HTTP 409 Head branch was modified/);
      assert.deepStrictEqual(writes(requests), [`PUT ${PULL}/merge`]);
      assert.deepInclude(
        (yield* executions).find((row) => row.action_id === raced.actionId),
        { outcome: "failed", github_request_id: "REQ-409" },
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("a paused org never executes, even when the pause lands mid-run", () => {
    const { requests, checks, layer } = harness();
    return Effect.gen(function* () {
      const { sql, actions } = yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      const pause = sql`INSERT INTO kin_org_state (org_id, paused, paused_at, paused_by, reason)
        VALUES ('org_01', 1, ${NOW}, ${owner}, 'stop')
        ON CONFLICT (org_id) DO UPDATE SET paused = 1, paused_at = ${NOW}, paused_by = ${owner}`;
      const resume = sql`UPDATE kin_org_state SET paused = 0, paused_at = NULL, paused_by = NULL,
        reason = NULL WHERE org_id = 'org_01'`;

      // Paused before the claim: held and still approved, nothing claimed.
      yield* pause;
      const held = yield* approvedMerge("webhook-1");
      assert.deepStrictEqual(yield* executor.execute(held), { _tag: "held", reason: "paused" });
      assert.deepInclude(yield* stateOf(held), { state: "approved" });
      // The claim itself refuses a paused org, whoever calls it.
      const [waiting] = yield* actions.approvedWithGrant(orgId);
      assert.isFalse(yield* actions.claim({ ...held, revision: 0, grantId: waiting!.grant.id }));
      assert.lengthOf(yield* executions, 0);
      // When the grant lapses, the tick's sweep voids it.
      yield* TestClock.adjust("16 minutes");
      yield* executor.tick;
      assert.deepInclude(yield* stateOf(held), { state: "voided", reason: "grant_expired" });

      // Paused after the precheck, just before the side effect: refused, never sent.
      yield* resume;
      checks.count = 0;
      // Check 1 runs before the claim, check 2 right after the precheck.
      checks.during = (count) => (count === 2 ? Effect.orDie(pause) : Effect.void);
      const late = yield* approvedMerge("webhook-2");
      assert.deepStrictEqual(yield* executor.execute(late), {
        _tag: "finished",
        outcome: "failed",
        error: "paused",
      });
      assert.deepStrictEqual(writes(requests), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("holds an approved action while the credential check fails, audited once", () => {
    const { requests, checks, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      const ref = yield* approvedMerge("webhook-1");
      checks.failing = true;
      for (const _ of [1, 2]) {
        assert.deepStrictEqual(yield* executor.execute(ref), {
          _tag: "held",
          reason: "credential_check_failed",
        });
      }
      assert.deepInclude(yield* stateOf(ref), { state: "approved" });
      assert.lengthOf(yield* executions, 0);
      const failed = (yield* auditEntries).filter(
        (entry) => entry.event === "credential_check_failed",
      );
      assert.deepStrictEqual(
        failed.map((entry) => entry.result),
        ["identity_unknown"],
      );
      // Both holds within the minute shared one probe.
      assert.strictEqual(checks.count, 1);
      // Fixed before the grant lapses: the next tick's check sees it, and it runs.
      checks.failing = false;
      yield* TestClock.adjust("1 minute");
      assert.deepInclude(yield* executor.execute(ref), { outcome: "succeeded" });
      assert.deepStrictEqual(writes(requests), [`PUT ${PULL}/merge`]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("two executors racing on one action run it once", () => {
    const { requests, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      const ref = yield* approvedMerge("webhook-1");
      const [first, second, ticked] = yield* Effect.all(
        [executor.execute(ref), executor.execute(ref), executor.tick],
        { concurrency: "unbounded" },
      );
      // The tick may or may not see the action before a claim lands; either way one run.
      const results = [first, second, ...ticked.map(({ result }) => result)];
      assert.lengthOf(
        results.filter((result) => result._tag === "finished"),
        1,
      );
      assert.isTrue(results.every((result) => ["finished", "skipped"].includes(result._tag)));
      assert.lengthOf(yield* executions, 1);
      assert.deepStrictEqual(writes(requests), [`PUT ${PULL}/merge`]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a restart mid-merge reconciles to succeeded or interrupted, with no merge call",
    () => {
      const { world, requests, layer } = harness();
      return Effect.gen(function* () {
        yield* seed;
        const executor = yield* ActionExecutor.KinActionExecutor;

        const merged = yield* claimedThenCrashed("webhook-1");
        world.pull = { ...mergedPull };
        assert.deepStrictEqual(yield* executor.reconcile(merged), {
          _tag: "finished",
          outcome: "succeeded",
        });
        assert.deepInclude(
          (yield* executions).find((row) => row.action_id === merged.actionId),
          { outcome: "succeeded", merge_commit_sha: MERGED },
        );
        assert.deepInclude(
          (yield* auditEntries).find((entry) => entry.event === "execution_reconciled"),
          { result: MERGED, deviceLabel: "Pixel 9", grantJti: merged.jti },
        );

        const open = yield* claimedThenCrashed("webhook-2");
        world.pull = { ...openPull };
        // GitHub unreachable: state unchanged, tried again later.
        world.down = true;
        assert.deepStrictEqual(yield* executor.reconcile(open), { _tag: "unknown" });
        assert.deepInclude(yield* stateOf(open), { state: "executing" });
        world.down = false;
        assert.deepStrictEqual(yield* executor.reconcile(open), {
          _tag: "finished",
          outcome: "interrupted",
        });
        // Idempotent: a decided action is never reconciled or run again.
        assert.deepStrictEqual(yield* executor.reconcile(open), { _tag: "skipped" });
        assert.deepStrictEqual(yield* executor.execute(open), { _tag: "skipped" });
        assert.deepStrictEqual(writes(requests), []);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a merge whose answer is lost is reconciled, never sent twice", () => {
    const { world, requests, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      world.merge = { status: 502, body: { message: "Bad gateway" } };
      // GitHub merged and then failed to answer.
      const landed = yield* approvedMerge("webhook-1");
      assert.deepStrictEqual(yield* executor.execute(landed), {
        _tag: "finished",
        outcome: "succeeded",
      });
      // GitHub didn't merge: interrupted, and the grant is spent.
      world.pull = { ...openPull };
      world.mergeLands = false;
      const lost = yield* approvedMerge("webhook-2");
      assert.deepStrictEqual(yield* executor.execute(lost), {
        _tag: "finished",
        outcome: "interrupted",
      });
      assert.deepStrictEqual(writes(requests), [`PUT ${PULL}/merge`, `PUT ${PULL}/merge`]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("the worker reconciles at startup, retrying while GitHub is down", () => {
    const { world, requests, noticed, notices, deps } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const ref = yield* claimedThenCrashed("webhook-1");
      world.pull = { ...mergedPull };
      world.down = true;
      yield* Effect.gen(function* () {
        yield* ActionExecutor.KinActionExecutor;
        yield* TestClock.adjust("1 second");
        assert.deepInclude(yield* stateOf(ref), { state: "executing" });
        world.down = false;
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(noticed);
      }).pipe(Effect.provide(ActionExecutor.layer), Effect.scoped);
      assert.deepInclude(yield* stateOf(ref), { state: "succeeded" });
      assert.deepStrictEqual(notices, [{ actionId: ref.actionId, outcome: "succeeded" }]);
      assert.deepStrictEqual(writes(requests), []);
    }).pipe(Effect.provide(deps));
  });

  it.effect(
    "the worker checks credentials at startup and hourly, telling the owner of changes",
    () => {
      const { checks, credentialNotices, deps } = harness();
      return Effect.gen(function* () {
        yield* seed;
        const posted = yield* Queue.unbounded<ReadonlyArray<string>>();
        credentialNotices.posted = (failures) => Queue.offer(posted, failures);
        checks.failing = true;
        yield* Effect.gen(function* () {
          yield* ActionExecutor.KinActionExecutor;
          assert.deepStrictEqual(yield* Queue.take(posted), ["identity_unknown"]);
          // An unchanged hour stays quiet; the next one that passes says so.
          yield* TestClock.adjust("1 hour");
          assert.strictEqual(checks.count, 2);
          checks.failing = false;
          yield* TestClock.adjust("1 hour");
          assert.deepStrictEqual(yield* Queue.take(posted), []);
        }).pipe(Effect.provide(ActionExecutor.layer), Effect.scoped);
        assert.strictEqual(checks.count, 3);
        const failed = (yield* auditEntries).filter(
          (entry) => entry.event === "credential_check_failed",
        );
        assert.deepStrictEqual(
          failed.map((entry) => [entry.actionId, entry.result]),
          [[undefined, "identity_unknown"]],
        );
        assert.deepStrictEqual(credentialNotices.sent, [
          { orgId, failures: ["identity_unknown"] },
          { orgId, failures: [], recoveredFrom: failed[0]!.seq as number },
        ]);
      }).pipe(Effect.provide(deps));
    },
  );

  it.effect("tells only orgs with a merge token, and says it passes again after a restart", () => {
    const { checks, credentialNotices, deps } = harness();
    return Effect.gen(function* () {
      const { sql } = yield* seed;
      // An org that never saved a merge token hasn't set GitHub up: no notice, no audit.
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
        VALUES ('org_02', 'Other', '2026-11-07T00:00:00.000Z')`;
      checks.failing = true;
      yield* (yield* ActionExecutor.make).checkCredentials;
      assert.deepStrictEqual(credentialNotices.sent, [{ orgId, failures: ["identity_unknown"] }]);
      const others = yield* sql`SELECT seq FROM kin_audit WHERE org_id = 'org_02'`;
      assert.lengthOf(others, 0);
      const [failure] = (yield* auditEntries).filter(
        (entry) => entry.event === "credential_check_failed",
      );

      // Restarted after the fix: each new executor says it passes again, under one notice id.
      checks.failing = false;
      yield* TestClock.adjust("1 minute");
      for (const _ of [1, 2]) yield* (yield* ActionExecutor.make).checkCredentials;
      assert.deepStrictEqual(credentialNotices.sent.slice(1), [
        { orgId, failures: [], recoveredFrom: failure!.seq as number },
        { orgId, failures: [], recoveredFrom: failure!.seq as number },
      ]);
    }).pipe(Effect.provide(deps));
  });

  it.effect("the worker executes an approval as it lands", () => {
    const { requests, noticed, deps } = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* Effect.gen(function* () {
        yield* ActionExecutor.KinActionExecutor;
        const ref = yield* approvedMerge("webhook-1");
        yield* Deferred.await(noticed);
        assert.deepInclude(yield* stateOf(ref), { state: "succeeded" });
      }).pipe(Effect.provide(ActionExecutor.layer), Effect.scoped);
      assert.deepStrictEqual(writes(requests), [`PUT ${PULL}/merge`]);
    }).pipe(Effect.provide(deps));
  });

  it.effect("deletes a branch only at the approved head", () => {
    const { world, requests, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      const branch = (source: string) =>
        approved({
          kind: "delete_branch",
          target: { _tag: "branch", host: "github.com", repo: REPO, ref: "kin/stale" },
          resolved: { _tag: "branch", headSha: HEAD },
          source,
        });
      const ref = yield* branch("delete-1");
      assert.deepStrictEqual(yield* executor.execute(ref), {
        _tag: "finished",
        outcome: "succeeded",
      });
      assert.deepStrictEqual(writes(requests), [`DELETE /repos/${REPO}/git/refs/heads/kin/stale`]);
      assert.strictEqual(
        requests.find((request) => request.method === "DELETE")?.authorization,
        `Bearer ${OWNER_TOKEN}`,
      );
      assert.isFalse(world.branches.has("kin/stale"));

      // A push after approval: the precheck refuses and nothing is deleted.
      world.branches.set("kin/stale", MOVED);
      const moved = yield* branch("delete-2");
      assert.deepInclude(yield* executor.execute(moved), { _tag: "finished", outcome: "failed" });
      assert.match((yield* stateOf(moved)).reason ?? "", /^head_moved/);
      assert.lengthOf(writes(requests), 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("the merge token is never written to logs, audit, rows or the environment", () => {
    const { world, layer } = harness();
    const logged: Array<string> = [];
    const logger = Logger.make(({ message, cause }) => {
      logged.push(JSON.stringify(message), String(cause));
    });
    return Effect.gen(function* () {
      const { sql } = yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      // A success, three refusals, a lost answer and an unreadable GitHub all leave traces.
      yield* executor.execute(yield* approvedMerge("webhook-1", true));
      world.mergeLands = false;
      for (const [index, merge] of [
        { status: 409, body: { message: "Head branch was modified." } },
        { status: 403, body: { message: "Resource not accessible by personal access token" } },
        { status: 405, body: { message: "Required status check is expected." } },
        { status: 500, body: { message: "Server error" } },
      ].entries()) {
        world.pull = { ...openPull };
        world.merge = merge;
        yield* executor.execute(yield* approvedMerge(`webhook-${index + 2}`));
      }
      world.down = true;
      yield* executor.execute(yield* approvedMerge("webhook-9"));
      const dump: Array<string> = [];
      const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
        WHERE type = 'table' ORDER BY name`;
      for (const { name } of tables) {
        dump.push(JSON.stringify(yield* sql`SELECT * FROM ${sql(name)}`));
      }
      assert.include(dump.join("\n"), "execution_finished");
      // Nothing in this stack spawns a process: it is built without a ChildProcessSpawner.
      const haystack = [...logged, ...dump, JSON.stringify(process.env)].join("\n");
      assert.notInclude(haystack, OWNER_TOKEN);
      assert.notInclude(haystack, BOT_TOKEN);
    }).pipe(
      Effect.provide(Layer.merge(layer, Logger.layer([logger], { mergeWithExisting: false }))),
    );
  });

  it("no agent, MCP tool or model-reachable path can claim, run or finish an action", () => {
    const root = NodePath.resolve(import.meta.dirname, "../..");
    const files = (NodeFS.readdirSync(root, { recursive: true }) as Array<string>)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => file.split(NodePath.sep).join("/"))
      .toSorted();
    const source = (file: string) => NodeFS.readFileSync(NodePath.join(root, file), "utf8");
    const imports = (file: string) =>
      // Static, dynamic and bare side-effect imports, and re-exports.
      [...source(file).matchAll(/\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)].map(
        (match) =>
          NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(file), match[1]!)),
      );
    const importers = (target: string) => files.filter((file) => imports(file).includes(target));
    // What a model reaches (MCP tools, the lead runtime) and what a client's RPC reaches.
    const entryPoints = files.filter(
      (file) =>
        file.startsWith("mcp/") ||
        file.startsWith("kin/mcp/") ||
        file.startsWith("kin/lead/") ||
        file === "kin/approvals/mcp.ts" ||
        file === "kin/rpcHandlers.ts" ||
        file === "ws.ts",
    );

    // Only the executor claims and finishes pending actions.
    assert.deepStrictEqual(
      files.filter(
        (file) =>
          /KinPendingActions/.test(source(file)) && /\.(claim|finish)\(\{/.test(source(file)),
      ),
      ["kin/approvals/ActionExecutor.ts"],
    );
    // It is built in the approvals layer; the chat side only implements its notices.
    assert.deepStrictEqual(importers("kin/approvals/ActionExecutor.ts"), [
      "kin/approvals/layer.ts",
      "kin/chat/executionNotices.ts",
    ]);
    // Nothing model- or client-facing reaches the executor, its handlers or the owner's merge
    // client, directly or through other Kin modules (the composition root aside).
    const guarded = (file: string) =>
      file === "kin/approvals/ActionExecutor.ts" ||
      file === "kin/approvals/ActionHandlers.ts" ||
      file === "kin/approvals/layer.ts" ||
      file.startsWith("kin/approvals/handlers/") ||
      file === "kin/github/OwnerMergeClient.ts";
    for (const entry of entryPoints) {
      const seen = new Set<string>();
      const pending = [entry];
      for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
        for (const target of imports(file)) {
          if (!target.startsWith("kin/") || target === "kin/layer.ts" || seen.has(target)) continue;
          seen.add(target);
          pending.push(target);
        }
      }
      assert.deepStrictEqual([...seen].filter(guarded), [], entry);
    }
    // No RPC or MCP surface carries the executor's service.
    assert.notInclude(source("kin/KinServer.ts"), "KinActionExecutor");
  });
});

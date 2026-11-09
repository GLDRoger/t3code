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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
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
import { KinExecutionNotices } from "./ExecutionNotices.ts";
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
const HEAD_DELETE = `DELETE /repos/${REPO}/git/refs/heads/kin/fix-212`;
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

interface Pull {
  state: "open" | "closed";
  merged: boolean;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headRepo: string;
}

/** GitHub as the executor sees it; tests change it between calls. */
interface World {
  pull: Pull;
  merge: FakeAnswer;
  /** Whether a merge call lands on GitHub, whatever it answers. */
  mergeLands: boolean;
  /** The merge call throws inside the client: a handler defect. */
  mergeThrows: boolean;
  /** The bot's pull request read never answers. */
  pullHangs: boolean;
  branches: Map<string, string>;
  /** Ruleset rules per branch; branches not listed have none. */
  rules: Map<string, ReadonlyArray<{ readonly type: string }>>;
  /** Branches some open pull request targets as its base. */
  openBases: Set<string>;
  defaultBranch: string;
  down: boolean;
}

const mergedPull: Pull = {
  state: "closed",
  merged: true,
  mergeCommitSha: MERGED,
  head: HEAD,
  base: "kin",
  headRepo: REPO,
};
const openPull: Pull = {
  state: "open",
  merged: false,
  mergeCommitSha: null,
  head: HEAD,
  base: "kin",
  headRepo: REPO,
};

/** `registry`: which handlers the host has; `unconfigured` lists the kinds it holds instead. */
function harness(
  options: {
    readonly registry?: "both" | "delete_only";
    readonly unconfigured?: ReadonlyArray<"merge_pull_request">;
  } = {},
) {
  const world: World = {
    pull: { ...openPull },
    merge: {
      status: 200,
      body: { merged: true, sha: MERGED, message: "Pull Request successfully merged" },
      headers: { "x-github-request-id": "REQ-1" },
    },
    mergeLands: true,
    mergeThrows: false,
    pullHangs: false,
    branches: new Map([
      ["kin", HEAD],
      ["kin/fix-212", HEAD],
      ["kin/stale", HEAD],
    ]),
    rules: new Map([["kin", [{ type: "pull_request" }]]]),
    openBases: new Set(),
    defaultBranch: "kin",
    down: false,
  };
  const github = fakeGitHub((request): FakeAnswer => {
    if (world.down) return { status: 502, body: { message: "Bad gateway" } };
    const key = `${request.method} ${request.path}`;
    if (key === `GET ${PULL}`) {
      if (world.pullHangs) return { hang: true, status: 0 };
      return {
        status: 200,
        body: {
          state: world.pull.state,
          merged: world.pull.merged,
          merge_commit_sha: world.pull.mergeCommitSha,
          head: {
            sha: world.pull.head,
            ref: "kin/fix-212",
            repo: { full_name: world.pull.headRepo },
          },
          base: { ref: world.pull.base },
        },
      };
    }
    const rules = /^GET \/repos\/GLDRoger\/t3code\/rules\/branches\/(.+)$/.exec(key)?.[1];
    if (rules !== undefined)
      return { status: 200, body: world.rules.get(decodeURIComponent(rules)) ?? [] };
    const bases = /^GET \/repos\/GLDRoger\/t3code\/pulls\?state=open&base=([^&]+)&/.exec(key)?.[1];
    if (bases !== undefined)
      return {
        status: 200,
        body: world.openBases.has(decodeURIComponent(bases)) ? [{ number: 300 }] : [],
      };
    if (key === `GET /repos/${REPO}`)
      return { status: 200, body: { default_branch: world.defaultBranch } };
    if (key === `PUT ${PULL}/merge`) {
      if (world.mergeThrows) throw new Error("client bug");
      if (world.mergeLands && world.pull.head === HEAD)
        world.pull = { ...world.pull, state: "closed", merged: true, mergeCommitSha: MERGED };
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
  const notices: Array<{
    readonly actionId: string;
    readonly outcome: string;
    readonly note?: string;
  }> = [];
  const noticed = Deferred.makeUnsafe<void>();
  // Each credential check runs `during` with its count; `failing` makes the identity unreadable.
  const checks: {
    count: number;
    failing: boolean;
    during?: (count: number) => Effect.Effect<unknown>;
  } = { count: 0, failing: false };
  const mints: Array<string> = [];
  const owners = new Set<string>([owner]);
  // The next `finishFailures` calls to the ledger's `finish` fail, as a database error would.
  const faults = { finishFailures: 0 };

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
              t3: Option.some({ login: "kin-bot", source: "app" }),
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
      Effect.map(([merge, remove]) =>
        ActionHandlers.make(
          options.registry === "delete_only" ? [remove] : [merge, remove],
          options.unconfigured,
        ),
      ),
    ),
  );
  const notifications = Layer.succeed(
    KinExecutionNotices,
    KinExecutionNotices.of({
      finished: ({ action, outcome, note }) =>
        Effect.sync(
          () =>
            void notices.push({
              actionId: action.id,
              outcome,
              ...(note === undefined ? {} : { note }),
            }),
        ).pipe(Effect.andThen(Deferred.succeed(noticed, undefined)), Effect.asVoid),
    }),
  );
  const roles = Layer.succeed(KinOrgRoles, {
    isOwner: (ref) => Effect.sync(() => ref.orgId === orgId && owners.has(ref.personId)),
  });
  const ledger = Layer.effect(
    PendingActions.KinExecutionLedger,
    Effect.gen(function* () {
      const real = yield* PendingActions.KinExecutionLedger;
      return PendingActions.KinExecutionLedger.of({
        ...real,
        finish: (input) =>
          Effect.suspend(() => {
            if (faults.finishFailures === 0) return real.finish(input);
            faults.finishFailures -= 1;
            return Effect.fail(new PersistenceSqlError({ operation: "test.finish" }));
          }),
      });
    }),
  ).pipe(Layer.provide(PendingActions.ledgerLayer));
  const deps = Layer.mergeAll(handlers, hygiene).pipe(
    Layer.provideMerge(githubStack),
    Layer.provideMerge(Layer.mergeAll(PendingActions.layer, ledger)),
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
    noticed,
    checks,
    mints,
    owners,
    faults,
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
  /** Edits the signed payload, for a grant that doesn't bind its action. */
  readonly payload?: (payload: KinGrantPayload) => KinGrantPayload;
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
    const signed = input.payload?.(payload) ?? payload;
    const result = yield* actions.approve({
      orgId,
      actionId: action.id,
      revision: action.revision,
      nonce: action.nonce,
      jti,
      approverHumanId: owner,
      keyThumbprint: kid,
      compact: `${encodeGrantSigningInput(header, signed)}.${SIGNATURE}`,
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
    const ledger = yield* PendingActions.KinExecutionLedger;
    const ref = yield* approvedMerge(source);
    const found = (yield* actions.approvedWithGrant(orgId)).find(
      (item) => item.action.id === ref.actionId,
    );
    assert.isTrue(yield* ledger.claim({ ...ref, revision: 0, grantId: found!.grant.id }));
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
      assert.deepStrictEqual(writes(requests), [`PUT ${PULL}/merge`, HEAD_DELETE]);
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

  it.effect("keeps the head branch whenever delete_branch would refuse it", () => {
    const { world, requests, notices, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      const cases: ReadonlyArray<readonly [string, () => void, () => void]> = [
        ["fork", () => (world.pull.headRepo = "someone/t3code"), () => {}],
        [
          "default branch",
          () => (world.defaultBranch = "kin/fix-212"),
          () => (world.defaultBranch = "kin"),
        ],
        [
          "branch rules apply",
          () => world.rules.set("kin/fix-212", [{ type: "deletion" }]),
          () => world.rules.delete("kin/fix-212"),
        ],
        [
          "base of an open pull request",
          () => world.openBases.add("kin/fix-212"),
          () => world.openBases.delete("kin/fix-212"),
        ],
        [
          "moved",
          () => world.branches.set("kin/fix-212", MOVED),
          () => world.branches.set("kin/fix-212", HEAD),
        ],
      ];
      for (const [index, [reason, arrange, restore]] of cases.entries()) {
        world.pull = { ...openPull };
        arrange();
        const ref = yield* approvedMerge(`keep-${index}`, true);
        assert.deepStrictEqual(yield* executor.execute(ref), {
          _tag: "finished",
          outcome: "succeeded",
        });
        restore();
        const note = `Kept head branch kin/fix-212: ${reason}.`;
        assert.deepStrictEqual(notices.at(-1), {
          actionId: ref.actionId,
          outcome: "succeeded",
          note,
        });
        assert.deepInclude((yield* auditEntries).at(-1), {
          event: "execution_finished",
          result: `${MERGED}; ${note}`,
        });
      }
      // The merges ran; no head branch was deleted.
      assert.notInclude(writes(requests), HEAD_DELETE);
      assert.lengthOf(writes(requests), cases.length);
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

  it.effect("the precheck refuses a closed PR, a merge queue and an unbound grant", () => {
    const { world, requests, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      const refusedWith = (source: string, reason: RegExp) =>
        Effect.gen(function* () {
          const ref = yield* approvedMerge(source);
          assert.deepInclude(yield* executor.execute(ref), { outcome: "failed" });
          assert.match((yield* stateOf(ref)).reason ?? "", reason);
        });
      world.pull = { ...openPull, state: "closed" };
      yield* refusedWith("closed", /^not_open: closed/);
      world.pull = { ...openPull };
      world.rules.set("kin", [{ type: "merge_queue" }]);
      yield* refusedWith("queued", /^merge_queue_unsupported/);
      world.rules.set("kin", []);
      // The signed payload names another target: the run refuses before any write.
      const unbound = yield* approved({
        kind: "merge_pull_request",
        target: prTarget(),
        resolved: prFacts,
        source: "unbound",
        payload: (payload) => ({ ...payload, targetDigest: "0".repeat(64) as never }),
      });
      assert.deepInclude(yield* executor.execute(unbound), { outcome: "failed" });
      assert.match((yield* stateOf(unbound)).reason ?? "", /^grant_mismatch/);
      assert.deepStrictEqual(writes(requests), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("the live read sits right before the write, after every other check", () => {
    const { world, requests, checks, owners, layer } = harness();
    return Effect.gen(function* () {
      const { sql } = yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      // Check 1 runs before the claim, check 2 right after it; each case changes state there.
      const afterClaim = (source: string, change: Effect.Effect<unknown>) =>
        Effect.gen(function* () {
          checks.count = 0;
          checks.during = (count) => (count === 2 ? change : Effect.void);
          const ref = yield* approvedMerge(source);
          const result = yield* executor.execute(ref);
          checks.during = undefined;
          assert.deepInclude(result, { _tag: "finished", outcome: "failed" });
          return (yield* stateOf(ref)).reason ?? "";
        });
      // The base is retargeted after the claim: the precheck still sees it.
      assert.match(
        yield* afterClaim(
          "retarget",
          Effect.sync(() => (world.pull.base = "main")),
        ),
        /^base_changed: main/,
      );
      world.pull = { ...openPull };
      // The approver loses the owner role after the claim.
      assert.strictEqual(
        yield* afterClaim(
          "demoted",
          Effect.sync(() => owners.delete(owner)),
        ),
        "not_owner",
      );
      owners.add(owner);
      // The signing key is revoked after the claim.
      assert.strictEqual(
        yield* afterClaim(
          "revoked",
          Effect.orDie(
            sql`UPDATE kin_approver_keys SET state = 'revoked' WHERE thumbprint = ${kid}`,
          ),
        ),
        "revoked_key",
      );
      assert.deepStrictEqual(writes(requests), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("voids an approval whose approver is no longer an owner, without a claim", () => {
    const { owners, requests, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      const ref = yield* approvedMerge("webhook-1");
      owners.delete(owner);
      assert.deepStrictEqual(yield* executor.execute(ref), {
        _tag: "voided",
        reason: "approver_not_owner",
      });
      assert.lengthOf(yield* executions, 0);
      assert.deepStrictEqual(writes(requests), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a paused org never executes, even when the pause lands mid-run", () => {
    const { requests, checks, layer } = harness();
    return Effect.gen(function* () {
      const { sql, actions } = yield* seed;
      const ledger = yield* PendingActions.KinExecutionLedger;
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
      assert.isFalse(yield* ledger.claim({ ...held, revision: 0, grantId: waiting!.grant.id }));
      assert.lengthOf(yield* executions, 0);
      // When the grant lapses, the sweep voids it.
      yield* TestClock.adjust("16 minutes");
      yield* executor.sweep;
      assert.deepInclude(yield* stateOf(held), { state: "voided", reason: "grant_expired" });

      // Paused after the claim and the precheck, just before the side effect: never sent.
      yield* resume;
      checks.count = 0;
      // Check 1 runs before the claim, check 2 right after it.
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
      // Fixed before the grant lapses: it runs.
      checks.failing = false;
      assert.deepInclude(yield* executor.execute(ref), { outcome: "succeeded" });
      assert.deepStrictEqual(writes(requests), [`PUT ${PULL}/merge`]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("voids a kind with no handler, and holds one this host isn't configured for", () => {
    const unsupported = harness({ registry: "delete_only" });
    const unconfigured = harness({ registry: "delete_only", unconfigured: ["merge_pull_request"] });
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* seed;
        const executor = yield* ActionExecutor.KinActionExecutor;
        const ref = yield* approvedMerge("webhook-1");
        assert.deepStrictEqual(yield* executor.execute(ref), {
          _tag: "voided",
          reason: "unsupported_kind",
        });
        assert.deepInclude(yield* stateOf(ref), { state: "voided", reason: "unsupported_kind" });
      }).pipe(Effect.provide(unsupported.layer));
      yield* Effect.gen(function* () {
        yield* seed;
        const executor = yield* ActionExecutor.KinActionExecutor;
        const ref = yield* approvedMerge("webhook-1");
        assert.deepStrictEqual(yield* executor.execute(ref), {
          _tag: "held",
          reason: "not_configured",
        });
        // Still approved, so the sweep lapses it like any other held grant.
        assert.deepInclude(yield* stateOf(ref), { state: "approved" });
        yield* TestClock.adjust("16 minutes");
        yield* executor.sweep;
        assert.deepInclude(yield* stateOf(ref), { state: "voided", reason: "grant_expired" });
      }).pipe(Effect.provide(unconfigured.layer));
      assert.deepStrictEqual(writes([...unsupported.requests, ...unconfigured.requests]), []);
    });
  });

  it.effect("two executors racing on one action run it once", () => {
    const { requests, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      const ref = yield* approvedMerge("webhook-1");
      const results = yield* Effect.all(
        [executor.execute(ref), executor.execute(ref), executor.execute(ref)],
        { concurrency: "unbounded" },
      );
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

        // Merged, but GitHub hasn't filled in the merge commit yet: still undecided.
        const pending = yield* claimedThenCrashed("webhook-3");
        world.pull = { ...mergedPull, mergeCommitSha: null };
        assert.deepStrictEqual(yield* executor.reconcile(pending), { _tag: "unknown" });
        assert.deepInclude(yield* stateOf(pending), { state: "executing" });

        const open = yield* claimedThenCrashed("webhook-2");
        world.pull = { ...openPull };
        // GitHub unreachable: state unchanged, tried again later.
        world.down = true;
        assert.deepStrictEqual(yield* executor.reconcile(open), { _tag: "unknown" });
        assert.deepInclude(yield* stateOf(open), { state: "executing" });
        world.down = false;
        // Not merged yet, but a slow merge could still land: undecided until the claim is old.
        assert.deepStrictEqual(yield* executor.reconcile(open), { _tag: "unknown" });
        yield* TestClock.adjust("2 minutes");
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
      // GitHub answered 502 while the merge was still running: not merged on the first read, so
      // the action stays executing, and the late landing is recorded as a success.
      world.pull = { ...openPull };
      world.mergeLands = false;
      const slow = yield* approvedMerge("webhook-2");
      assert.deepStrictEqual(yield* executor.execute(slow), { _tag: "reconciling" });
      assert.deepInclude(yield* stateOf(slow), { state: "executing" });
      yield* TestClock.adjust("1 minute");
      world.pull = { ...mergedPull };
      assert.deepStrictEqual(yield* executor.reconcile(slow), {
        _tag: "finished",
        outcome: "succeeded",
      });
      // GitHub never merged: interrupted once the claim is old enough, and the grant is spent.
      world.pull = { ...openPull };
      const lost = yield* approvedMerge("webhook-3");
      assert.deepStrictEqual(yield* executor.execute(lost), { _tag: "reconciling" });
      yield* TestClock.adjust("119 seconds");
      assert.deepStrictEqual(yield* executor.reconcile(lost), { _tag: "unknown" });
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* executor.reconcile(lost), {
        _tag: "finished",
        outcome: "interrupted",
      });
      assert.deepStrictEqual(writes(requests), [
        `PUT ${PULL}/merge`,
        `PUT ${PULL}/merge`,
        `PUT ${PULL}/merge`,
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("an unreadable 200, a defect or no answer at all is reconciled, not decided", () => {
    const { world, requests, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      world.mergeLands = false;
      // A 200 whose body isn't a merge answer says nothing about whether it merged.
      world.merge = { status: 200, body: { unexpected: true } };
      const unreadable = yield* approvedMerge("webhook-1");
      assert.deepStrictEqual(yield* executor.execute(unreadable), { _tag: "reconciling" });
      assert.deepInclude(yield* stateOf(unreadable), { state: "executing" });
      // A defect inside the write may have happened after the request left.
      world.mergeThrows = true;
      const defect = yield* approvedMerge("webhook-2");
      assert.deepStrictEqual(yield* executor.execute(defect), { _tag: "reconciling" });
      assert.deepInclude(yield* stateOf(defect), { state: "executing" });
      world.mergeThrows = false;
      // No answer: the owner write times out, then reconciliation finds the merge landed.
      world.mergeLands = true;
      world.merge = { hang: true, status: 0 };
      const silent = yield* approvedMerge("webhook-3");
      const running = yield* executor.execute(silent).pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      assert.deepStrictEqual(yield* Fiber.join(running), {
        _tag: "finished",
        outcome: "succeeded",
      });
      assert.lengthOf(writes(requests), 3);
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

  it.effect("the worker executes an approval as it lands", () => {
    const { requests, deps } = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* Effect.gen(function* () {
        yield* ActionExecutor.KinActionExecutor;
        // Let the startup pass finish first, so only the published approval can start this run.
        yield* TestClock.adjust("1 second");
        const ref = yield* approvedMerge("webhook-1");
        yield* TestClock.adjust("1 second");
        assert.deepInclude(yield* stateOf(ref), { state: "succeeded" });
      }).pipe(Effect.provide(ActionExecutor.layer), Effect.scoped);
      assert.deepStrictEqual(writes(requests), [`PUT ${PULL}/merge`]);
    }).pipe(Effect.provide(deps));
  });

  it.effect("the worker settles an action whose result couldn't be recorded", () => {
    const { faults, requests, noticed, notices, deps } = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* Effect.gen(function* () {
        yield* ActionExecutor.KinActionExecutor;
        yield* TestClock.adjust("1 second");
        faults.finishFailures = 1;
        const ref = yield* approvedMerge("webhook-1");
        yield* TestClock.adjust("1 second");
        // Merged, but the outcome wasn't written: no fiber holds the row now.
        assert.deepInclude(yield* stateOf(ref), { state: "executing" });
        yield* TestClock.adjust("1 minute");
        yield* Deferred.await(noticed);
        assert.deepInclude(yield* stateOf(ref), { state: "succeeded" });
        assert.deepStrictEqual(notices, [{ actionId: ref.actionId, outcome: "succeeded" }]);
      }).pipe(Effect.provide(ActionExecutor.layer), Effect.scoped);
      assert.deepStrictEqual(writes(requests), [`PUT ${PULL}/merge`]);
    }).pipe(Effect.provide(deps));
  });

  it.effect("a stuck execution doesn't hold up the expiry sweep", () => {
    const { world, deps } = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* Effect.gen(function* () {
        yield* ActionExecutor.KinActionExecutor;
        yield* TestClock.adjust("1 second");
        // The first run's precheck read never answers, so it holds the org's lock.
        world.pullHangs = true;
        const stuck = yield* approvedMerge("webhook-1");
        yield* TestClock.adjust("1 second");
        const waiting = yield* approvedMerge("webhook-2");
        yield* TestClock.adjust("16 minutes");
        assert.deepInclude(yield* stateOf(stuck), { state: "executing" });
        assert.deepInclude(yield* stateOf(waiting), { state: "voided", reason: "grant_expired" });
      }).pipe(Effect.provide(ActionExecutor.layer), Effect.scoped);
    }).pipe(Effect.provide(deps));
  });

  it.effect("deletes a branch only at the approved head, and never the default branch", () => {
    const { world, requests, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      const branch = (source: string, ref = "kin/stale") =>
        approved({
          kind: "delete_branch",
          target: { _tag: "branch", host: "github.com", repo: REPO, ref },
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

      const main = yield* branch("delete-3", "kin");
      assert.deepInclude(yield* executor.execute(main), { _tag: "finished", outcome: "failed" });
      assert.match((yield* stateOf(main)).reason ?? "", /^refused: the default branch/);
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
    // Non-literal `import(` calls a guard can't follow, each with why it's safe.
    const opaqueImports = new Map([
      // Inside the speech worker's source text, which a separate Node process runs.
      ["speech/native.ts", ["import(moduleUrl)"]],
    ]);
    const unfollowable: Array<string> = [];
    const imports = (file: string) => {
      const text = source(file);
      // Static and bare side-effect imports, and re-exports.
      const specifiers = [...text.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/g)].map(
        (match) => match[1]!,
      );
      for (const call of text.matchAll(/\bimport\s*\(\s*/g)) {
        const rest = text.slice(call.index + call[0].length);
        // A string literal, or a backtick literal with no interpolation, and nothing after it.
        const literal =
          /^(["'])([^"'`\\$]*)\1\s*[),]/.exec(rest) ?? /^`([^`\\$]*)`\s*[),]/.exec(rest);
        if (literal === null) {
          const snippet = `import(${rest.slice(0, rest.search(/\)|$/))})`;
          if (!opaqueImports.get(file)?.includes(snippet)) unfollowable.push(`${file}: ${snippet}`);
          continue;
        }
        specifiers.push(literal[2] ?? literal[1]!);
      }
      return specifiers
        .filter((specifier) => specifier.startsWith("."))
        .map((specifier) =>
          NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(file), specifier)),
        );
    };
    const graph = new Map(files.map((file) => [file, imports(file)]));
    assert.deepStrictEqual(unfollowable, []);

    // Composition roots build the executor; reaching one isn't reaching what it builds.
    const compositionRoots = new Set(["server.ts", "kin/layer.ts", "kin/approvals/layer.ts"]);
    const guarded = (file: string) =>
      file === "kin/approvals/ActionExecutor.ts" ||
      file === "kin/approvals/ActionHandlers.ts" ||
      file === "kin/approvals/layer.ts" ||
      file.startsWith("kin/approvals/handlers/") ||
      file === "kin/github/OwnerMergeClient.ts";
    // Everything outside approvals, the GitHub clients and the roots is something an agent, a
    // client, a route or a scheduled task might reach.
    const entryPoints = files.filter(
      (file) =>
        !file.startsWith("kin/approvals/") &&
        !file.startsWith("kin/github/") &&
        !compositionRoots.has(file),
    );
    for (const entry of entryPoints) {
      const seen = new Set<string>();
      const pending = [entry];
      for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
        for (const target of graph.get(file) ?? []) {
          if (compositionRoots.has(target) || seen.has(target)) continue;
          seen.add(target);
          pending.push(target);
        }
      }
      assert.deepStrictEqual([...seen].filter(guarded), [], entry);
    }
    // Inside approvals, only the executor and its composition root import the executor.
    assert.deepStrictEqual(
      files.filter((file) => graph.get(file)?.includes("kin/approvals/ActionExecutor.ts")),
      ["kin/approvals/layer.ts"],
    );

    // Claim and finish live on the ledger, which only the executor's layer is given.
    const ledgerUsers = files.filter((file) =>
      /\bKinExecutionLedger\b|\bledgerLayer\b/.test(source(file)),
    );
    assert.deepStrictEqual(ledgerUsers, [
      "kin/approvals/ActionExecutor.ts",
      "kin/approvals/PendingActions.ts",
      "kin/approvals/layer.ts",
    ]);
    // Nothing reaches `claim` or `finish` through the pending actions service either.
    const sneaking = files.filter(
      (file) =>
        file !== "kin/approvals/ActionExecutor.ts" &&
        file !== "kin/approvals/PendingActions.ts" &&
        /\bKinPendingActions\b/.test(source(file)) &&
        /\.(?:claim|finish)\s*\(|\[\s*["'`](?:claim|finish)["'`]\s*\]/.test(source(file)),
    );
    assert.deepStrictEqual(sneaking, []);
    // No RPC or MCP surface carries the executor's service.
    assert.notInclude(source("kin/KinServer.ts"), "KinActionExecutor");
  });
});

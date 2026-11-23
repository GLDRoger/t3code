// @effect-diagnostics nodeBuiltinImport:off -- node:fs reads the import graph for the reachability guard.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  KinAgentId,
  KinEventId,
  KinOrgId,
  type KinActionTarget,
  type KinGrantPayload,
  type KinPendingAction,
  type KinResolvedTarget,
} from "@t3tools/contracts";
import { encodeGrantSigningInput } from "@t3tools/shared/kinGrant";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as ActionExecutor from "./ActionExecutor.ts";
import * as ActionHandlers from "./ActionHandlers.ts";
import * as Audit from "./Audit.ts";
import { makeKeyStore } from "./ApproverKeyStore.ts";
import { KinExecutionNotices, KinKeyNotices } from "./ExecutionNotices.ts";
import { BOOTSTRAP_OWNER, KinOrgRoles } from "./GrantPorts.ts";
import {
  insertActiveKey,
  insertPendingKey,
  makeApprovalKey,
  signCompact,
} from "./grant.testkit.ts";
import * as KeySeal from "./KeySeal.ts";
import * as ApprovalsLayer from "./layer.ts";
import * as PendingActions from "./PendingActions.ts";
import * as RetiredActions from "./retiredActions.ts";
import { KinRetiredActions, RETIRED_ACTION_REASON } from "../lead/Retirement.ts";

const NOW = Date.parse("2026-11-08T00:00:00Z");
const orgId = Schema.decodeSync(KinOrgId)("org_01");
// The production layer's roles port knows only the bootstrap owner.
const owner = BOOTSTRAP_OWNER;
const approvalKey = makeApprovalKey();
const kid = approvalKey.kid;
const decodeEventId = Schema.decodeSync(KinEventId);
const REPO = "GLDRoger/t3code";
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const MERGED = "c".repeat(40);
const PULL = `/repos/${REPO}/pulls/212`;
const JUNK_SIGNATURE = Buffer.alloc(64, 7).toString("base64url");

/** The owner's key as the server activated it; `sealed: false` is a row written into SQLite. */
const insertKey = (orgId: string, options: { readonly sealed?: boolean } = {}) =>
  insertActiveKey({ key: approvalKey, orgId, humanId: owner, ...options });

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

interface FakeAnswer {
  /** Never answers, like a connection GitHub leaves open. */
  readonly hang?: true;
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

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
    readonly registry?: "merge" | "none";
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
    down: false,
  };
  const notices: Array<{
    readonly actionId: string;
    readonly outcome: string;
    readonly note?: string;
  }> = [];
  const noticed = Deferred.makeUnsafe<void>();
  // Runs first after the claim, before any other post-claim check.
  const afterClaim: { during?: Effect.Effect<unknown> } = {};
  const owners = new Set<string>([owner]);
  // Each owner-role check runs `during` with its count: 1 before the claim, 2 after it.
  const roleChecks: { count: number; during?: (count: number) => Effect.Effect<unknown> } = {
    count: 0,
  };
  // The next `finishFailures` calls to the ledger's `finish` fail, as a database error would;
  // `writeStartFails` makes recording the write's start fail the same way. `afterMerge` runs once
  // GitHub answers the merge.
  const faults: {
    finishFailures: number;
    writeStartFails: boolean;
    afterMerge?: Effect.Effect<unknown>;
  } = { finishFailures: 0, writeStartFails: false };

  // GitHub's side of a merge, over `world`: the executor's checks and claims are under test here.
  const requests: Array<{
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
  }> = [];
  const fail = (reason: ActionHandlers.KinExecFailure, detail?: string, githubRequestId?: string) =>
    Effect.fail(
      new ActionHandlers.KinExecError({
        reason,
        ...(detail === undefined ? {} : { detail }),
        ...(githubRequestId === undefined ? {} : { githubRequestId }),
      }),
    );
  const partsOf = (action: KinPendingAction) =>
    action.target._tag === "pull_request" && action.resolved._tag === "pull_request"
      ? Effect.succeed({ target: action.target, resolved: action.resolved })
      : fail("invalid", "not a pull request merge");
  const readPull = Effect.suspend(() => {
    requests.push({ method: "GET", path: PULL });
    if (world.down) return fail("unavailable", "could not read the pull request");
    // GitHub reads give up after 15 s, as the real client did.
    return world.pullHangs
      ? Effect.sleep("15 seconds").pipe(
          Effect.andThen(fail("unavailable", "could not read the pull request")),
        )
      : Effect.succeed(world.pull);
  });
  const merge: ActionHandlers.KinActionHandler = {
    kind: "merge_pull_request",
    precheck: Effect.fn("fakeMerge.precheck")(function* (action) {
      const { resolved } = yield* partsOf(action);
      const pull = yield* readPull;
      if (pull.merged || pull.state !== "open")
        return yield* fail("not_open", pull.merged ? "merged" : "closed");
      if (pull.head !== resolved.headSha) return yield* fail("head_moved", pull.head);
      if (pull.base !== resolved.base) return yield* fail("base_changed", pull.base);
    }),
    run: Effect.fn("fakeMerge.run")(function* (action) {
      const { target, resolved } = yield* partsOf(action);
      requests.push({
        method: "PUT",
        path: `${PULL}/merge`,
        body: { sha: resolved.headSha, merge_method: target.mergeMethod },
      });
      if (world.mergeThrows) return yield* Effect.die(new Error("client bug"));
      if (world.mergeLands && world.pull.head === resolved.headSha)
        world.pull = { ...world.pull, state: "closed", merged: true, mergeCommitSha: MERGED };
      yield* faults.afterMerge ?? Effect.void;
      const answer = world.merge;
      // An owner write gives up after 30 s; it may have landed.
      if (answer.hang === true)
        return yield* Effect.sleep("30 seconds").pipe(Effect.andThen(fail("unknown_outcome")));
      const requestId = answer.headers?.["x-github-request-id"];
      const id = requestId === undefined ? {} : { githubRequestId: requestId };
      const body = answer.body as { readonly sha?: unknown; readonly message?: string } | undefined;
      if (answer.status === 200 && typeof body?.sha === "string")
        return { mergeCommitSha: body.sha, ...id };
      const detail = `HTTP ${answer.status}${body?.message === undefined ? "" : ` ${body.message}`}`;
      if (answer.status === 0 || answer.status >= 500 || answer.status === 200)
        return yield* fail("unknown_outcome", detail, requestId);
      if (answer.status === 409) return yield* fail("head_moved", detail, requestId);
      if (answer.status === 405) return yield* fail("not_mergeable", detail, requestId);
      return yield* fail(answer.status === 404 ? "not_found" : "denied", detail, requestId);
    }),
    reconcile: Effect.fn("fakeMerge.reconcile")(function* (action) {
      const { resolved } = yield* partsOf(action);
      const pull = yield* readPull.pipe(Effect.option);
      if (Option.isNone(pull)) return "unknown" as const;
      if (pull.value.head !== resolved.headSha) return "not_done" as const;
      if (pull.value.merged && pull.value.mergeCommitSha !== null)
        return { _tag: "done", outcome: { mergeCommitSha: pull.value.mergeCommitSha } } as const;
      return pull.value.merged ? ("unknown" as const) : ("not_done" as const);
    }),
  };
  const handlers = Layer.succeed(
    ActionHandlers.KinActionHandlers,
    ActionHandlers.make(options.registry === "none" ? [] : [merge], options.unconfigured),
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
      lapsed: ({ action, holdReason }) =>
        Effect.sync(
          () => void notices.push({ actionId: action.id, outcome: "lapsed", note: holdReason }),
        ),
    }),
  );
  const roles = Layer.succeed(KinOrgRoles, {
    isOwnerLevel: (ref) =>
      Effect.suspend(() => {
        roleChecks.count += 1;
        return roleChecks.during?.(roleChecks.count) ?? Effect.void;
      }).pipe(Effect.map(() => ref.orgId === orgId && owners.has(ref.personId))),
  });
  const ledger = Layer.effect(
    PendingActions.KinExecutionLedger,
    Effect.gen(function* () {
      const real = yield* PendingActions.KinExecutionLedger;
      return PendingActions.KinExecutionLedger.of({
        ...real,
        signingKeyUsable: (ref) =>
          Effect.suspend(() => afterClaim.during ?? Effect.void).pipe(
            Effect.andThen(real.signingKeyUsable(ref)),
          ),
        writeStarting: (input) =>
          faults.writeStartFails
            ? Effect.fail(new PersistenceSqlError({ operation: "test.writeStarting" }))
            : real.writeStarting(input),
        finish: (input) =>
          Effect.suspend(() => {
            if (faults.finishFailures === 0) return real.finish(input);
            faults.finishFailures -= 1;
            return Effect.fail(new PersistenceSqlError({ operation: "test.finish" }));
          }),
      });
    }),
  ).pipe(Layer.provide(PendingActions.ledgerLayer));
  const deps = Layer.mergeAll(handlers, KeySeal.layerTest()).pipe(
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
    requests,
    notices,
    noticed,
    owners,
    roleChecks,
    afterClaim,
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
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES (${owner}, 'org_01', 'nishchay', 'Nishchay', '2026-11-07T00:00:00.000Z', 'owner')`;
  yield* insertKey("org_01");
  return { sql, actions: yield* PendingActions.KinPendingActions };
});

let jtiCounter = 0;

/** Creates an action and approves it through `PendingActions`, as check 10 does. */
const approved = (input: {
  readonly kind: "merge_pull_request" | "delete_branch" | "register_approver_key";
  readonly target: KinActionTarget;
  readonly resolved: KinResolvedTarget;
  readonly source: string;
  /** Edits the signed payload, for a grant that doesn't bind its action. */
  readonly payload?: (payload: KinGrantPayload) => KinGrantPayload;
  /** A signature no key made, as a row written straight into SQLite would carry. */
  readonly forged?: boolean;
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
      compact:
        input.forged === true
          ? `${encodeGrantSigningInput(header, signed)}.${JUNK_SIGNATURE}`
          : signCompact(approvalKey, header, signed),
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

/** Claims an approved action as the executor does; `wrote` also records the write's start. */
const claim = <Ref extends PendingActions.ActionRef>(ref: Ref, wrote: boolean) =>
  Effect.gen(function* () {
    const actions = yield* PendingActions.KinPendingActions;
    const ledger = yield* PendingActions.KinExecutionLedger;
    const found = (yield* actions.approvedWithGrant(orgId)).find(
      (item) => item.action.id === ref.actionId,
    );
    assert.isTrue(yield* ledger.claim({ ...ref, revision: 0, grantId: found!.grant.id }));
    if (wrote)
      assert.strictEqual(
        yield* ledger.writeStarting({ ...ref, at: yield* Clock.currentTimeMillis }),
        "started",
      );
    return ref;
  });

/** A crash mid-write, or with `wrote: false` between the claim and the write. */
const claimedThenCrashed = (source: string, wrote = true) =>
  approvedMerge(source).pipe(Effect.flatMap((ref) => claim(ref, wrote)));

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
const writes = (requests: ReadonlyArray<{ readonly method: string; readonly path: string }>) =>
  requests.filter((request) => request.method !== "GET").map((r) => `${r.method} ${r.path}`);

describe("KinActionExecutor", () => {
  it.effect("merges an approved PR at the exact SHA and audits who approved it", () => {
    const { requests, notices, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      const ref = yield* approvedMerge("webhook-1");
      assert.deepStrictEqual(yield* executor.execute(ref), {
        _tag: "finished",
        outcome: "succeeded",
      });
      assert.deepStrictEqual(yield* stateOf(ref), { state: "succeeded", reason: undefined });
      const merge = requests.find((request) => request.method === "PUT");
      assert.deepStrictEqual(merge?.body, { sha: HEAD, merge_method: "squash" });
      assert.deepStrictEqual(writes(requests), [`PUT ${PULL}/merge`]);
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
      assert.lengthOf(writes(requests), 1);
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

  it.effect(
    "the precheck refuses a closed PR and a merge queue, and a grant that doesn't verify never runs",
    () => {
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
        // The signed payload names another target or head, no key signed it, or the key row was
        // written straight into SQLite: voided before the claim, so nothing is sent.
        const refuse = (source: string, options: Partial<Parameters<typeof approved>[0]> = {}) =>
          Effect.gen(function* () {
            const ref = yield* approved({
              kind: "merge_pull_request",
              target: prTarget(),
              resolved: prFacts,
              source,
              ...options,
            });
            assert.deepStrictEqual(
              yield* executor.execute(ref),
              { _tag: "voided", reason: "grant_unverified" },
              source,
            );
          });
        yield* refuse("unbound", {
          payload: (payload) => ({ ...payload, targetDigest: "0".repeat(64) as never }),
        });
        yield* refuse("unbound-head", { payload: (payload) => ({ ...payload, headSha: MOVED }) });
        yield* refuse("forged-signature", { forged: true });
        const sql = yield* SqlClient.SqlClient;
        // `created_at` bounds the session-revocation check, so the seal covers it.
        yield* sql`UPDATE kin_approver_keys SET created_at = created_at + 1 WHERE org_id = ${orgId}`;
        yield* refuse("moved-created-at");
        yield* sql`DELETE FROM kin_approver_keys WHERE org_id = ${orgId}`;
        yield* insertKey(orgId, { sealed: false });
        yield* refuse("unsealed-key");
        assert.deepStrictEqual(writes(requests), []);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("the live read sits right before the write, after every other check", () => {
    const { world, requests, afterClaim, owners, layer } = harness();
    return Effect.gen(function* () {
      const { sql } = yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      // Check 1 runs before the claim, check 2 right after it; each case changes state there.
      const changedAfterClaim = (source: string, change: Effect.Effect<unknown>) =>
        Effect.gen(function* () {
          afterClaim.during = change;
          const ref = yield* approvedMerge(source);
          const result = yield* executor.execute(ref);
          delete afterClaim.during;
          assert.deepInclude(result, { _tag: "finished", outcome: "failed" });
          return (yield* stateOf(ref)).reason ?? "";
        });
      // The base is retargeted after the claim: the precheck still sees it.
      assert.match(
        yield* changedAfterClaim(
          "retarget",
          Effect.sync(() => (world.pull.base = "main")),
        ),
        /^base_changed: main/,
      );
      world.pull = { ...openPull };
      // The approver loses the owner role after the claim.
      assert.strictEqual(
        yield* changedAfterClaim(
          "demoted",
          Effect.sync(() => owners.delete(owner)),
        ),
        "not_owner",
      );
      owners.add(owner);
      // The signing key is revoked after the claim.
      assert.strictEqual(
        yield* changedAfterClaim(
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
    const { requests, afterClaim, notices, layer } = harness();
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
      // The owner learns why it never ran.
      assert.deepStrictEqual(notices, [
        { actionId: held.actionId, outcome: "lapsed", note: "paused" },
      ]);

      // Paused after the claim and the precheck, just before the side effect: never sent.
      yield* resume;
      // Right after the claim.
      afterClaim.during = Effect.orDie(pause);
      const late = yield* approvedMerge("webhook-2");
      assert.deepStrictEqual(yield* executor.execute(late), {
        _tag: "finished",
        outcome: "failed",
        error: "paused",
      });
      assert.deepStrictEqual(writes(requests), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "an agent retired after the claim, while its checks run, never has its action sent, even once restored",
    () => {
      const { requests, afterClaim, notices, layer } = harness();
      return Effect.gen(function* () {
        const { sql } = yield* seed;
        const executor = yield* ActionExecutor.KinActionExecutor;
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
          VALUES ('lead', 'org_01', 'Lead', 'lead', ${owner}, '2026-11-07T00:00:00.000Z')`;
        const ref = yield* approvedMerge("webhook-1");
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        // Right after the claim: held there while it retires.
        afterClaim.during = Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const running = yield* executor.execute(ref).pipe(Effect.forkChild);
        yield* Deferred.await(reached);
        assert.deepInclude(yield* stateOf(ref), { state: "executing" });
        // Claimed but not yet sending: retiring voids it there and then.
        yield* sql`UPDATE kin_agents SET retired_at = '2026-11-08T00:00:00.000Z'
          WHERE agent_id = 'lead'`;
        yield* Effect.gen(function* () {
          yield* (yield* KinRetiredActions).close({ orgId, agentId: KinAgentId.make("lead") });
        }).pipe(Effect.provide(RetiredActions.layer));
        assert.deepStrictEqual(yield* stateOf(ref), {
          state: "voided",
          reason: RETIRED_ACTION_REASON,
        });
        // A restore before the executor reaches the write doesn't bring the signed action back.
        yield* sql`UPDATE kin_agents SET retired_at = NULL WHERE agent_id = 'lead'`;
        yield* Deferred.succeed(release, undefined);
        assert.deepStrictEqual(yield* Fiber.join(running), {
          _tag: "voided",
          reason: RETIRED_ACTION_REASON,
        });
        assert.deepStrictEqual(writes(requests), []);
        assert.deepStrictEqual(yield* stateOf(ref), {
          state: "voided",
          reason: RETIRED_ACTION_REASON,
        });
        const voided = (yield* auditEntries).filter((entry) => entry.event === "action_voided");
        assert.lengthOf(voided, 1);
        assert.deepInclude(voided[0], { actionId: ref.actionId, result: RETIRED_ACTION_REASON });
        assert.deepInclude((yield* auditEntries).at(-1), { event: "action_voided" });
        assert.deepInclude((yield* executions)[0], { action_id: ref.actionId, outcome: "failed" });
        // Nothing is left `executing` for a restart to reconcile, and the owner hears nothing new.
        assert.deepStrictEqual(yield* executor.pickup, { approved: [], orphaned: [] });
        assert.deepStrictEqual(notices, []);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("voids a kind with no handler, and holds one this host isn't configured for", () => {
    const unsupported = harness({ registry: "none" });
    const unconfigured = harness({ registry: "none", unconfigured: ["merge_pull_request"] });
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
        for (const _ of [1, 2]) {
          assert.deepStrictEqual(yield* executor.execute(ref), {
            _tag: "held",
            reason: "not_configured",
          });
        }
        // One trace per held action and reason, however many ticks retry it.
        assert.deepStrictEqual(
          (yield* auditEntries)
            .filter((entry) => entry.event === "execution_held")
            .map((entry) => [entry.actionId, entry.result]),
          [[ref.actionId, "held: not_configured"]],
        );
        // Still approved, so the sweep lapses it like any other held grant.
        assert.deepInclude(yield* stateOf(ref), { state: "approved" });
        yield* TestClock.adjust("16 minutes");
        yield* executor.sweep;
        assert.deepInclude(yield* stateOf(ref), { state: "voided", reason: "grant_expired" });
        assert.deepStrictEqual(unconfigured.notices, [
          { actionId: ref.actionId, outcome: "lapsed", note: "not_configured" },
        ]);
      }).pipe(Effect.provide(unconfigured.layer));
      assert.deepStrictEqual(writes([...unsupported.requests, ...unconfigured.requests]), []);
    });
  });

  it.effect("an executor that loses the claim after its checks pass writes nothing", () => {
    const { requests, roleChecks, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      // Two hosts: separate executors, so separate org locks, over one database.
      const loser = yield* ActionExecutor.KinActionExecutor;
      const winner = yield* ActionExecutor.make;
      const ref = yield* approvedMerge("webhook-1");
      let won: ActionExecutor.KinExecuteResult | undefined;
      // The loser's pre-claim owner check: the winner runs the whole action in that gap.
      roleChecks.during = (count) =>
        count === 1
          ? winner.execute(ref).pipe(
              Effect.orDie,
              Effect.tap((result) => Effect.sync(() => (won = result))),
            )
          : Effect.void;
      assert.deepStrictEqual(yield* loser.execute(ref), { _tag: "skipped" });
      assert.deepStrictEqual(won, { _tag: "finished", outcome: "succeeded" });
      // Only the winner's merge, and its execution as it left it.
      assert.deepStrictEqual(writes(requests), [`PUT ${PULL}/merge`]);
      assert.deepStrictEqual(yield* executions, [
        {
          action_id: ref.actionId,
          outcome: "succeeded",
          merge_commit_sha: MERGED,
          github_request_id: "REQ-1",
        },
      ]);
      assert.deepStrictEqual(yield* stateOf(ref), { state: "succeeded", reason: undefined });
    }).pipe(Effect.provide(layer));
  });

  it.effect("removing a key after its last read fences an unstarted write", () =>
    Effect.gen(function* () {
      // The removal itself, and a stop that closes no claim (a key stopped, not yet reconciled).
      for (const how of ["removed", "stopped"] as const) {
        const { requests, roleChecks, layer } = harness();
        yield* Effect.gen(function* () {
          const { sql } = yield* seed;
          const store = yield* makeKeyStore;
          const stop =
            how === "removed"
              ? store.revokeRow({ orgId, thumbprint: kid }, "key_revoked").pipe(Effect.asVoid)
              : sql`UPDATE kin_approver_keys SET state = 'revoked' WHERE thumbprint = ${kid}`.pipe(
                  Effect.asVoid,
                );
          const executor = yield* ActionExecutor.KinActionExecutor;
          const ref = yield* approvedMerge("removed-mid-run");
          // The second owner check runs after the executor's key read, before the write starts.
          roleChecks.during = (count) => (count === 2 ? Effect.orDie(stop) : Effect.void);
          assert.deepStrictEqual(yield* executor.execute(ref), {
            _tag: "voided",
            reason: "key_revoked",
          });
          assert.deepStrictEqual(writes(requests), []);
          assert.deepStrictEqual(yield* stateOf(ref), { state: "voided", reason: "key_revoked" });
        }).pipe(Effect.provide(layer));
      }
    }),
  );

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

        // Our merge timed out, the head moved, and a person merged that: not this grant's merge.
        const overtaken = yield* claimedThenCrashed("webhook-4");
        world.pull = { ...mergedPull, head: MOVED };
        assert.deepStrictEqual(yield* executor.reconcile(overtaken), { _tag: "unknown" });
        yield* TestClock.adjust("2 minutes");
        assert.deepStrictEqual(yield* executor.reconcile(overtaken), {
          _tag: "finished",
          outcome: "interrupted",
        });
        assert.deepStrictEqual(writes(requests), []);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a slow check after the claim doesn't eat the write's 2 minutes", () => {
    const { world, requests, afterClaim, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      // The post-claim check takes 100 s, then the merge never answers and never lands.
      afterClaim.during = Effect.sleep("100 seconds");
      world.mergeLands = false;
      world.merge = { hang: true, status: 0 };
      const ref = yield* approvedMerge("slow-check");
      const running = yield* executor.execute(ref).pipe(Effect.forkChild);
      yield* TestClock.adjust("130 seconds");
      // 130 s after the claim but 30 s after the write: GitHub may still be merging.
      assert.deepStrictEqual(yield* Fiber.join(running), { _tag: "reconciling" });
      assert.deepInclude(yield* stateOf(ref), { state: "executing" });
      yield* TestClock.adjust("89 seconds");
      assert.deepStrictEqual(yield* executor.reconcile(ref), { _tag: "unknown" });
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* executor.reconcile(ref), {
        _tag: "finished",
        outcome: "interrupted",
      });
      assert.deepStrictEqual(writes(requests), [`PUT ${PULL}/merge`]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a restart counts from the stored write time, and a claim never written fails", () => {
    const { world, requests, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      world.pull = { ...openPull };
      // Claimed, then 100 s of checks, then the write, then the crash.
      const ref = yield* claimedThenCrashed("restart-late-write", false);
      yield* TestClock.adjust("100 seconds");
      const ledger = yield* PendingActions.KinExecutionLedger;
      assert.strictEqual(
        yield* ledger.writeStarting({ ...ref, at: yield* Clock.currentTimeMillis }),
        "started",
      );
      // Written once: a second mark can't move the window.
      assert.strictEqual(yield* ledger.writeStarting({ ...ref, at: NOW }), "closed");
      yield* TestClock.adjust("30 seconds");
      assert.deepStrictEqual(yield* executor.reconcile(ref), { _tag: "unknown" });
      yield* TestClock.adjust("90 seconds");
      assert.deepStrictEqual(yield* executor.reconcile(ref), {
        _tag: "finished",
        outcome: "interrupted",
      });

      // A crash between the claim and the write: nothing was sent, so no read is needed.
      const reads = requests.length;
      const unsent = yield* claimedThenCrashed("restart-no-write", false);
      assert.deepStrictEqual(yield* executor.reconcile(unsent), {
        _tag: "finished",
        outcome: "failed",
      });
      assert.deepStrictEqual(yield* stateOf(unsent), { state: "failed", reason: "not_started" });
      assert.deepInclude((yield* auditEntries).at(-1), {
        event: "execution_reconciled",
        actionId: unsent.actionId,
        result: "failed: not_started",
      });
      assert.lengthOf(requests, reads);
      assert.deepStrictEqual(writes(requests), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a write whose start can't be recorded is never sent", () => {
    const { faults, requests, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      faults.writeStartFails = true;
      const ref = yield* approvedMerge("unrecorded");
      assert.deepStrictEqual(yield* executor.execute(ref), {
        _tag: "finished",
        outcome: "failed",
        error: "unavailable: ledger",
      });
      assert.deepStrictEqual(writes(requests), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a precheck read GitHub never answers ends the action failed", () => {
    const { world, requests, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      world.pullHangs = true;
      const ref = yield* approvedMerge("silent-precheck");
      const running = yield* executor.execute(ref).pipe(Effect.forkChild);
      yield* TestClock.adjust("15 seconds");
      assert.deepInclude(yield* Fiber.join(running), { _tag: "finished", outcome: "failed" });
      assert.match((yield* stateOf(ref)).reason ?? "", /^unavailable: could not read the pull/);
      assert.deepStrictEqual(writes(requests), []);
    }).pipe(Effect.provide(layer));
  });

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
    const { afterClaim, deps } = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* Effect.gen(function* () {
        yield* ActionExecutor.KinActionExecutor;
        yield* TestClock.adjust("1 second");
        // The first run's post-claim key check never returns, so it holds the org's lock.
        afterClaim.during = Effect.never;
        const stuck = yield* approvedMerge("webhook-1");
        yield* TestClock.adjust("1 second");
        const waiting = yield* approvedMerge("webhook-2");
        yield* TestClock.adjust("16 minutes");
        assert.deepInclude(yield* stateOf(stuck), { state: "executing" });
        assert.deepInclude(yield* stateOf(waiting), { state: "voided", reason: "grant_expired" });
      }).pipe(Effect.provide(ActionExecutor.layer), Effect.scoped);
    }).pipe(Effect.provide(deps));
  });

  /** The production composition, as `kin/layer.ts` builds it, with `notices` posting lapses. */
  const production = (executor: typeof ApprovalsLayer.executorLayer, lapses: Array<string>) =>
    executor.pipe(
      Layer.provideMerge(ApprovalsLayer.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(
            KinExecutionNotices,
            KinExecutionNotices.of({
              finished: () => Effect.void,
              lapsed: ({ holdReason }) => Effect.sync(() => void lapses.push(holdReason)),
            }),
          ),
          Layer.succeed(KinKeyNotices, KinKeyNotices.of({ changed: () => Effect.void })),
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
          KeySeal.layerTest(),
          Sqlite.layerMemory,
        ),
      ),
    );

  it.effect(
    "the production layer shares none of the executor's services, and voids GitHub kinds",
    () => {
      const lapses: Array<string> = [];
      return Effect.gen(function* () {
        // Before the worker's schedules start, or they replay every minute since the epoch.
        yield* TestClock.setTime(NOW);
        const context = yield* Layer.build(production(ApprovalsLayer.executorLayer, lapses));
        // `kin.services` hands this whole context to RPC handlers and the lead's MCP tools.
        for (const tag of [
          PendingActions.KinExecutionLedger,
          ActionHandlers.KinActionHandlers,
          ActionExecutor.KinActionExecutor,
        ] as const) {
          assert.isTrue(Option.isNone(Context.getOption(context, tag as never)), tag.key);
        }
        assert.isTrue(Option.isSome(Context.getOption(context, PendingActions.KinPendingActions)));
        yield* Effect.gen(function* () {
          yield* seed;
          // Kin no longer merges: an approved merge from before is voided as it lands.
          const ref = yield* approvedMerge("before");
          yield* TestClock.adjust("1 second");
          assert.deepInclude(yield* stateOf(ref), { state: "voided", reason: "unsupported_kind" });
          assert.deepStrictEqual(lapses, []);
        }).pipe(Effect.provide(context));
      }).pipe(Effect.scoped);
    },
  );

  it.effect("a phone-to-phone approval from before is voided and never activates its key", () => {
    const lapses: Array<string> = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const context = yield* Layer.build(production(ApprovalsLayer.executorLayer, lapses));
      yield* Effect.gen(function* () {
        const { sql } = yield* seed;
        const phone = makeApprovalKey();
        yield* insertPendingKey({ key: phone, orgId, humanId: owner });
        const ref = yield* approved({
          kind: "register_approver_key",
          target: { _tag: "device_key", thumbprint: phone.kid, hardware: "tee", attested: true },
          resolved: { _tag: "none" },
          source: "second-phone",
        });
        yield* TestClock.adjust("1 second");
        assert.deepInclude(yield* stateOf(ref), { state: "voided", reason: "unsupported_kind" });
        assert.deepStrictEqual(
          yield* sql<{ state: string }>`SELECT state FROM kin_approver_keys
            WHERE thumbprint = ${phone.kid}`,
          [{ state: "pending" }],
        );
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped);
  });

  it.effect("an execution never pairs with a grant from another org", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const { sql } = yield* seed;
      const executor = yield* ActionExecutor.KinActionExecutor;
      const ledger = yield* PendingActions.KinExecutionLedger;
      const ref = yield* claimedThenCrashed("other-org");
      // A grant row moved to another org that holds the same key, as corrupt data would.
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
        VALUES ('org_02', 'Other', '2026-11-07T00:00:00.000Z')`;
      yield* insertKey("org_02");
      yield* sql`UPDATE kin_grants SET org_id = 'org_02' WHERE action_id = ${ref.actionId}`;
      assert.deepStrictEqual((yield* executor.pickup).orphaned, []);
      assert.deepStrictEqual(yield* executor.reconcile(ref), { _tag: "skipped" });
      assert.isFalse(yield* ledger.signingKeyUsable(ref));
      assert.isTrue(yield* ledger.finish({ ...ref, outcome: "failed", error: "test" }));
      const finished = (yield* auditEntries).at(-1);
      assert.strictEqual(finished?.event, "execution_finished");
      assert.notProperty(finished, "grantJti");
    }).pipe(Effect.provide(layer));
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
      // Inside the hostile test page's text, which only a sealed browser page runs.
      ["kin/visualSeal.testkit.ts", ['import("${http}/dynamic-import")']],
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

    // `require`, `eval` and `new Function` load code the import graph can't follow. Each line
    // using one is listed, and loads a package, generated script text, or the server bundle itself.
    const dynamicLoads = new Map<string, ReadonlyArray<string>>([
      [
        "bin.ts",
        [
          // A Node SEA loads its own bundled entry, which is the composition root.
          "const require = NodeModule.createRequire(import.meta.url);",
          "// require() resolves links in the executable path, such as a Windows junction.",
          'return require(process.execPath) as typeof import("./binMain.ts");',
        ],
      ],
      [
        "binMain.ts",
        [
          "// Packaged builds load this graph with require(esm): top-level await anywhere in it breaks them.",
        ],
      ],
      ["outboundHttp.ts", ["const requireUndici = NodeModule.createRequire(import.meta.url);"]],
      // Only resolves where a chart library's file is on disk; nothing is loaded into the server.
      [
        "kin/visualLibraries.ts",
        ["const requireFromHere = NodeModule.createRequire(import.meta.url);"],
      ],
      [
        "policy/ManagedPolicy.ts",
        ["const requireForFfi = NodeModule.createRequire(import.meta.url);"],
      ],
      [
        "vcs/CheckoutCloner.ts",
        ["const requireForFfi = NodeModule.createRequire(import.meta.url);"],
      ],
      [
        "preview/ServerBrowserContexts.ts",
        [
          "// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.",
          "const requirePlaywright = NodeModule.createRequire(import.meta.url);",
        ],
      ],
      [
        "terminal/NodePtyAdapter.ts",
        ["const requireForNodePty = NodeModule.createRequire(import.meta.url);"],
      ],
      [
        "workspace/WorkspaceSearchIndex.ts",
        ["const requireForFff = NodeModule.createRequire(import.meta.url);"],
      ],
      // Finds pdf.js's font and colour-map folders; loads no code.
      [
        "kin/lead/turn/pdfPageImages.ts",
        ['NodeModule.createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),'],
      ],
      // Source text for the speech worker, a separate Node process.
      [
        "speech/native.ts",
        [
          'const { createRequire, findPackageJSON } = await import("node:module");',
          'speech = createRequire(packagePath)(join(dirname(packagePath), "dist/index.js"));',
          "const run = new Function(",
        ],
      ],
      // Source text for worker threads that load only Node's own modules.
      ...["persistence/initializeV2Database.ts", "process/SpawnWorker.ts"].map(
        (file): [string, ReadonlyArray<string>] => [file, ['*require("node:']],
      ),
      // Scripts run with `node -e` on a device host.
      ...[
        "device/sshDeviceScript.ts",
        "device/deviceToolMaintenance.ts",
        "device/DeviceService.ts",
      ].map((file): [string, ReadonlyArray<string>] => [
        file,
        ["*require('node:", '*require("node:'],
      ]),
    ]);
    const dynamic = /\b(?:createRequire|require|eval)\s*\(|\bnew\s+Function\s*\(/;
    const unlisted = files.flatMap((file) =>
      source(file)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => dynamic.test(line))
        .filter(
          (line) =>
            !dynamicLoads
              .get(file)
              ?.some((allowed) =>
                allowed.startsWith("*") ? line.includes(allowed.slice(1)) : line === allowed,
              ),
        )
        .map((line) => `${file}: ${line}`),
    );
    assert.deepStrictEqual(unlisted, []);
    // What each `createRequire` loader is called with: a package name, never a relative path.
    const code = (file: string) =>
      source(file)
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
    const required = files.flatMap((file) =>
      [...code(file).matchAll(/const (\w+) = NodeModule\.createRequire\(/g)].flatMap(([, name]) =>
        [...code(file).matchAll(new RegExp(`\\b${name}(?:\\.resolve)?\\(([^)]*)\\)`, "g"))]
          .map((call) => call[1]!)
          .filter((argument) => !/^["'][^./"'][^"']*["']$/.test(argument))
          .map((argument) => `${file}: ${name}(${argument})`),
      ),
    );
    assert.deepStrictEqual(required, [
      "bin.ts: require(process.execPath)",
      "bin.ts: require(process.execPath)",
    ]);

    // Composition roots build the executor; reaching one isn't reaching what it builds.
    const compositionRoots = new Set(["server.ts", "kin/layer.ts", "kin/approvals/layer.ts"]);
    const guarded = (file: string) =>
      file === "kin/approvals/ActionExecutor.ts" ||
      file === "kin/approvals/ActionHandlers.ts" ||
      file === "kin/approvals/layer.ts" ||
      file.startsWith("kin/approvals/handlers/");
    // Everything outside approvals and the roots is something an agent, a
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
    // The roots chain in one line, so none of them is a door to the executor from elsewhere.
    const importers = (target: string) => files.filter((file) => graph.get(file)?.includes(target));
    assert.deepStrictEqual(importers("kin/approvals/layer.ts"), ["kin/layer.ts"]);
    assert.deepStrictEqual(importers("kin/layer.ts"), ["server.ts"]);
    assert.deepStrictEqual(importers("server.ts"), [
      "cli/server.ts",
      "kin/auth/ProofKeySessions.testkit.ts",
    ]);

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
    // No RPC or MCP surface carries the executor's service. A tag forged with its key string finds
    // nothing, since no shared context holds it (the production layer test checks the output).
    assert.notInclude(source("kin/KinServer.ts"), "KinActionExecutor");

    // Leads are the owner's: the `kin lead` CLI, RPCs that check the caller owns the lead, reads
    // of only what's the caller's (`profiles`, `contacts`, also by the refresh stream), and the
    // owner's own tap on a route card. Nothing else the server runs (MCP, agent toolkits, HTTP
    // routes, schedules) reaches this module, and no RPC reaches what the CLI does unchecked.
    assert.deepStrictEqual(importers("kin/lead/KinLeadProvision.ts"), [
      "kin/chat/refreshes.ts",
      "kin/chat/rpcHandlers.ts",
      "kin/cli/lead.ts",
      "kin/lead/agentPage.ts",
      "kin/lead/agentUpdate.ts",
      "kin/lead/routeCard.ts",
      "kin/people/rpcHandlers.ts",
      "kin/recommend/card.ts",
    ]);
    // Closing a person's chat with a lead only takes writing away. It runs inside an owner-checked
    // revoke or team-agent switch, the owner's own co-owner-to-member change, and only the
    // return of someone removed as a co-owner and made a member while away.
    assert.deepStrictEqual(importers("kin/lead/directClose.ts"), [
      "kin/lead/KinLeadProvision.ts",
      "kin/people/KinPeople.ts",
    ]);
    const people = source("kin/people/KinPeople.ts");
    assert.lengthOf(people.match(/yield\* closeUngranted\(/g) ?? [], 2);
    assert.match(
      people,
      /if \(!isOwnerHimself\(identity\.owner, caller\.personId\)\) return yield\* ownerOnly;[\s\S]*if \(before === "co_owner" && input\.access === "member"\)\s*yield\* closeUngranted\(/,
    );
    assert.match(
      people,
      /const bringBack = Effect\.fn\("KinPeople\.bringBack"\)[\s\S]*KinPeople\.backChats[\s\S]*if \(gone\?\.was === "co_owner" && gone\.kept === "member"\)\s*yield\* closeUngranted\([\s\S]*const deviceLive =/,
    );
    // A route card grants only on a tap, as the owner-level person who tapped. `kin_hand_off`
    // imports this file to draw the card and cannot reach the grant.
    const routeCard = source("kin/lead/routeCard.ts");
    assert.strictEqual(routeCard.match(/\bLeadProvision\.\w+/g)?.join(), "LeadProvision.allow");
    assert.match(
      routeCard,
      /if \(!\(yield\* ownerLevel\(orgId, tap\.personId\)\)\)[\s\S]*LeadProvision\.allow\(\{\s*editor: \{ _tag: "person", personId: tap\.personId \}/,
    );
    assert.notMatch(source("kin/lead/Handoff.ts"), /\brunRoute\b/);
    // A suggestion grants or resumes only on its own sealed Do it, after the exact-owner check, as
    // the owner who tapped: `make` is the one place that changes anything, called only here, after
    // Not now has returned. The hourly pass that draws the card reaches neither the module nor the tap.
    const recommendCard = source("kin/recommend/card.ts");
    assert.strictEqual(
      recommendCard.match(/\bLeadProvision\.\w+/g)?.join(),
      "LeadProvision.allow,LeadProvision.setPaused",
    );
    assert.match(
      recommendCard,
      /LeadProvision\.allow\(\{\s*editor: \{ _tag: "person", personId \}[\s\S]*LeadProvision\.setPaused\(\{\s*by: \{ _tag: "person", personId \}/,
    );
    // The daily limit and a connection's pause change the same way, in `make` as the owner who
    // tapped: one call each, through the method their own Settings place calls.
    assert.strictEqual(
      recommendCard.match(/\(yield\* (?:KinBudget|KinConnections)\)\.\w+/g)?.join(),
      "(yield* KinBudget).set,(yield* KinConnections).update",
    );
    assert.lengthOf(recommendCard.match(/\bKin(?:Budget|Connections)\b(?!\.ts)/g) ?? [], 4);
    assert.match(
      recommendCard,
      /const make = [\s\S]*const people = \[\{ _tag: "person" as const, orgId, personId \}\];[\s\S]*\(yield\* KinBudget\)\.set\(people, \{[\s\S]*\(yield\* KinConnections\)\.update\(people, \{/,
    );
    // The rules only read: the budget module's one constant and the connections' row readers.
    const recommendRules = source("kin/recommend/rules.ts");
    assert.match(recommendRules, /import \{ USUAL_LIMITS \} from "\.\.\/lead\/KinBudget\.ts";/);
    assert.lengthOf(recommendRules.match(/from "\.\.\/lead\/KinBudget\.ts"/g) ?? [], 1);
    assert.notMatch(recommendRules, /yield\* KinBudget\b/);
    assert.match(
      recommendRules,
      /import \{ callable, pausedRefusal, toolsOf \} from "\.\.\/connections\/ConnectionRows\.ts";/,
    );
    assert.notMatch(recommendRules, /ConnectionsService\.ts|yield\* KinConnections\b/);
    assert.lengthOf(recommendCard.match(/(?<![.\w])make\(/g) ?? [], 1);
    assert.match(
      recommendCard,
      /yield\* onlyOwner\(orgId, tap\.personId\);[\s\S]*if \(plan\.answer === "not_now"\) \{[\s\S]*\}\s*const text = yield\* make\(orgId, tap\.personId, plan\.change\)/,
    );
    assert.notMatch(source("kin/recommend/KinRecommend.ts"), /KinLeadProvision|\brunRecommend\b/);
    // An agent's page reads and retires as its checked owner; a turn's model change is the
    // owner's or a co-owner's own words, saved with them as the editor (`updateAgent`).
    assert.match(
      source("kin/lead/agentPage.ts"),
      /import \{ type LeadCreator, profileIn, retirable \} from "\.\/KinLeadProvision\.ts"/,
    );
    assert.match(
      source("kin/lead/agentUpdate.ts"),
      /import \{ leadsIn, update \} from "\.\/KinLeadProvision\.ts"/,
    );
    assert.include(source("kin/lead/agentUpdate.ts"), "!(yield* ownerLevel(lead.orgId, asker))");
    // The team agent is set with the caller's own session, checked as the editor's.
    assert.notMatch(
      source("kin/people/rpcHandlers.ts"),
      /\bLeadProvision\.(?!setTeamAgent\b|ts\b)\w+/,
    );
    assert.notMatch(
      source("kin/chat/refreshes.ts"),
      /\bLeadProvision\.(?!profiles\b|contacts\b|messageable\b|ts\b)\w+/,
    );
    // `messageable` only reads the caller's own list of agents they may message: one SELECT,
    // scoped to their person row, that writes nothing and opens no chat.
    const messageable = /export const messageable = [\s\S]*?\n\}\);/.exec(
      source("kin/lead/messageable.ts"),
    )?.[0];
    // Its own module, so a person's coding agent key lists who it may message without reaching
    // the provisioning module: that one read is all the module holds, and it is all the key takes.
    assert.deepStrictEqual(importers("kin/lead/messageable.ts"), [
      "kin/lead/KinLeadProvision.ts",
      "kin/tasksKey/people.ts",
    ]);
    assert.strictEqual(
      source("kin/lead/messageable.ts")
        .match(/^export const \w+/gm)
        ?.join(),
      "export const messageable",
    );
    assert.isDefined(messageable);
    assert.match(messageable!, /me\.person_id = \$\{person\.personId\}/);
    assert.match(messageable!, /WHERE l\.org_id = \$\{person\.orgId\}/);
    assert.notMatch(messageable!, /\b(INSERT|UPDATE|DELETE)\b|createDirect|\bchats\./);
    assert.deepStrictEqual(importers("kin/chat/refreshes.ts"), ["kin/work/rpcHandlers.ts"]);
    assert.deepStrictEqual(importers("kin/chat/rpcHandlers.ts"), [
      "kin/people/rpcHandlers.ts",
      "kin/rpcHandlers.ts",
    ]);
    assert.notMatch(
      source("kin/chat/rpcHandlers.ts"),
      /\bLeadProvision\.(?!create\b|update\b|retire\b|restore\b|setPaused\b|agentDefaults\b|setAgentDefaults\b|profiles\b|contacts\b|messageable\b|access\b|allow\b|disallow\b|reachList\b|reachSet\b|teamAgent\b|KinLeadProvisionError\b|ts\b)\w+/,
    );
    // The refresh stream reads only the caller's own lead list to tell them it moved.
    assert.deepStrictEqual(importers("kin/chat/refreshes.ts"), ["kin/work/rpcHandlers.ts"]);
    assert.notMatch(
      source("kin/chat/refreshes.ts"),
      /\bLeadProvision\.(?!profiles\b|contacts\b|messageable\b|ts\b)\w+/,
    );
    assert.deepStrictEqual(importers("kin/cli/lead.ts"), ["binCli.ts"]);
    const served = new Set<string>();
    const pending = ["server.ts"];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      for (const target of graph.get(file) ?? []) {
        if (served.has(target)) continue;
        served.add(target);
        pending.push(target);
      }
    }
    assert.isTrue(served.size > 100);
    assert.notInclude([...served], "kin/cli/lead.ts");
  });
});

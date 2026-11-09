import type { KinGrant, KinOrgId, KinPendingAction } from "@t3tools/contracts";
import { decodeKinGrant } from "@t3tools/shared/kinGrant";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";
import { isOrgPaused } from "../lead/orgState.ts";
import {
  KinActionHandlers,
  KinExecError,
  type KinActionHandler,
  type KinOutcome,
} from "./ActionHandlers.ts";
import { KinAudit } from "./Audit.ts";
import { CredentialHygiene } from "./CredentialHygiene.ts";
import { KinOrgRoles } from "./GrantPorts.ts";
import { KinPendingActions, type ActionRef } from "./PendingActions.ts";

/** Approved actions held by the stop switch or a failing check are retried this often. */
const TICK_INTERVAL = "1 minute";
/** Reconciliation that can't read GitHub retries until it can; it never re-runs the action. */
const RECONCILE_RETRY = Schedule.spaced("30 seconds");

export type KinExecutionOutcome = "succeeded" | "failed" | "interrupted";

/** Posts the result to the requesting lead's chat. The chat lives outside approvals. */
export class KinExecutionNotices extends Context.Service<
  KinExecutionNotices,
  {
    readonly finished: (input: {
      readonly action: KinPendingAction;
      readonly outcome: KinExecutionOutcome;
      readonly mergeCommitSha?: string;
      readonly error?: string;
    }) => Effect.Effect<void>;
  }
>()("t3/kin/approvals/ActionExecutor/KinExecutionNotices") {}

export type KinExecuteResult =
  /** Not `approved` with a live grant, or another executor claimed it first. */
  | { readonly _tag: "skipped" }
  /** The stop switch or the credential check holds it `approved` until it lapses. */
  | { readonly _tag: "held"; readonly reason: string }
  | { readonly _tag: "voided"; readonly reason: string }
  | { readonly _tag: "finished"; readonly outcome: KinExecutionOutcome; readonly error?: string }
  /** The side effect may have landed; reconciliation decides, without a second run. */
  | { readonly _tag: "reconciling" };

export type KinReconcileResult =
  | { readonly _tag: "finished"; readonly outcome: "succeeded" | "interrupted" }
  | { readonly _tag: "unknown" }
  | { readonly _tag: "skipped" };

type Errors = PersistenceSqlError | PersistenceDecodeError;

/**
 * Spec section 6: carries out approved actions, one at a time per org. The only way in is an
 * action `PendingActions.approve` moved to `approved`; no RPC or MCP tool reaches this service.
 */
export class KinActionExecutor extends Context.Service<
  KinActionExecutor,
  {
    readonly execute: (ref: ActionRef) => Effect.Effect<KinExecuteResult, Errors>;
    /** One reconciliation attempt for an action left `executing`. */
    readonly reconcile: (ref: ActionRef) => Effect.Effect<KinReconcileResult, Errors>;
    /** Expiry sweep, then every approved action. The worker runs it at startup and each minute. */
    readonly tick: Effect.Effect<
      ReadonlyArray<{ readonly ref: ActionRef; readonly result: KinExecuteResult }>,
      Errors
    >;
  }
>()("t3/kin/approvals/ActionExecutor/KinActionExecutor") {}

const failureText = (error: KinExecError) => error.message.slice(0, 500);

export const make = Effect.gen(function* () {
  const pending = yield* KinPendingActions;
  const handlers = yield* KinActionHandlers;
  const hygiene = yield* CredentialHygiene;
  const roles = yield* KinOrgRoles;
  const audit = yield* KinAudit;
  const notices = yield* KinExecutionNotices;
  const sql = yield* SqlClient.SqlClient;

  const locks = new Map<KinOrgId, Semaphore.Semaphore>();
  const withOrgLock = <A, E, R>(orgId: KinOrgId, effect: Effect.Effect<A, E, R>) => {
    let lock = locks.get(orgId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(orgId, lock);
    }
    return lock.withPermits(1)(effect);
  };
  // One `credential_check_failed` entry per held action and failure set, not one per tick.
  const auditedHolds = new Map<string, string>();

  const paused = (orgId: KinOrgId) =>
    isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  const finish = Effect.fn("KinActionExecutor.finish")(function* (
    action: KinPendingAction,
    outcome: KinExecutionOutcome,
    detail: KinOutcome & { readonly error?: string; readonly reconciled?: boolean },
  ) {
    const recorded = yield* pending.finish({
      orgId: action.orgId,
      actionId: action.id,
      outcome,
      ...detail,
    });
    if (recorded) {
      yield* notices.finished({
        action,
        outcome,
        ...(detail.mergeCommitSha === undefined ? {} : { mergeCommitSha: detail.mergeCommitSha }),
        ...(detail.error === undefined ? {} : { error: detail.error }),
      });
    }
    return recorded;
  });

  const payloadOf = (grant: KinGrant) =>
    Effect.suspend(() => {
      const decoded = decodeKinGrant(grant.compact);
      return decoded === null
        ? Effect.fail(new KinExecError({ reason: "grant_mismatch", detail: "unreadable grant" }))
        : Effect.succeed(decoded.payload);
    });

  const reconcileClaimed = Effect.fn("KinActionExecutor.reconcileClaimed")(function* (
    action: KinPendingAction,
  ): Effect.fn.Return<KinReconcileResult, Errors> {
    const handler = handlers.get(action.kind);
    if (Option.isNone(handler)) return { _tag: "unknown" } as KinReconcileResult;
    const verdict = yield* handler.value
      .reconcile(action)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin reconcile could not tell", Cause.pretty(cause)).pipe(
            Effect.as("unknown" as const),
          ),
        ),
      );
    if (verdict === "unknown") return { _tag: "unknown" } as KinReconcileResult;
    if (verdict === "not_done") {
      // Terminal: the grant is spent. The owner approves a new request to try again.
      yield* finish(action, "interrupted", { error: "did not finish", reconciled: true });
      return { _tag: "finished", outcome: "interrupted" } as KinReconcileResult;
    }
    yield* finish(action, "succeeded", {
      ...(verdict === "done" ? {} : verdict.outcome),
      reconciled: true,
    });
    return { _tag: "finished", outcome: "succeeded" } as KinReconcileResult;
  });

  /** Steps 4–6, for an action this executor just claimed. */
  const runClaimed = Effect.fn("KinActionExecutor.runClaimed")(function* (
    action: KinPendingAction,
    grant: KinGrant,
    handler: KinActionHandler,
  ) {
    const failed = (error: KinExecError) =>
      finish(action, "failed", {
        error: failureText(error),
        ...(error.githubRequestId === undefined ? {} : { githubRequestId: error.githubRequestId }),
      }).pipe(
        Effect.as({ _tag: "finished", outcome: "failed", error: failureText(error) } as const),
      );
    const steps = Effect.gen(function* () {
      yield* handler.precheck(action);
      const pass = yield* hygiene.requirePassing(action.orgId).pipe(
        Effect.mapError(
          (error) =>
            new KinExecError({
              reason: "credential_check_failed",
              detail: error.failures.join(","),
            }),
        ),
      );
      // The stop switch, immediately before the side effect.
      if (yield* paused(action.orgId).pipe(Effect.orElseSucceed(() => true)))
        return yield* new KinExecError({ reason: "paused" });
      return yield* handler
        .run(action, { grant, payload: payloadOf(grant), pass })
        .pipe(
          Effect.catchDefect(() =>
            Effect.fail(new KinExecError({ reason: "unknown_outcome", detail: "handler defect" })),
          ),
        );
    });
    const result = yield* Effect.result(steps);
    if (Result.isSuccess(result)) {
      yield* finish(action, "succeeded", result.success);
      return { _tag: "finished", outcome: "succeeded" } satisfies KinExecuteResult;
    }
    const error = result.failure;
    if (error.reason !== "unknown_outcome") return yield* failed(error);
    const reconciled = yield* reconcileClaimed(action);
    return (
      reconciled._tag === "finished"
        ? { _tag: "finished", outcome: reconciled.outcome }
        : { _tag: "reconciling" }
    ) satisfies KinExecuteResult;
  });

  const execute = Effect.fn("KinActionExecutor.execute")(function* (
    ref: ActionRef,
  ): Effect.fn.Return<KinExecuteResult, Errors> {
    return yield* withOrgLock(
      ref.orgId,
      Effect.gen(function* () {
        const found = (yield* pending.approvedWithGrant(ref.orgId)).find(
          (item) => item.action.id === ref.actionId,
        );
        if (found === undefined) return { _tag: "skipped" } as KinExecuteResult;
        const { action, grant } = found;
        const voided = (reason: string) =>
          pending
            .transition({ ...ref, revision: action.revision, to: "voided", reason })
            .pipe(
              Effect.map((won): KinExecuteResult =>
                won ? { _tag: "voided", reason } : { _tag: "skipped" },
              ),
            );
        const handler = handlers.get(action.kind);
        if (Option.isNone(handler)) return yield* voided("unsupported_kind");
        // 1. Stop switch: stay approved until the grant lapses; the sweep then voids it.
        if (yield* paused(action.orgId))
          return { _tag: "held", reason: "paused" } as KinExecuteResult;
        // 2. The approver still meets the requirement (the claim re-checks key and grant expiry).
        const owner = yield* roles
          .isOwner({ orgId: action.orgId, personId: grant.approverHumanId })
          .pipe(Effect.option);
        if (Option.isNone(owner))
          return { _tag: "held", reason: "roles_unavailable" } as KinExecuteResult;
        if (!owner.value) return yield* voided("approver_not_owner");
        // Checked before the claim too, so a misconfigured host holds the grant instead of spending it.
        const check = yield* hygiene.requirePassing(action.orgId).pipe(Effect.flip, Effect.option);
        if (Option.isSome(check)) {
          const failures = check.value.failures.join(",");
          if (auditedHolds.get(action.id) !== failures) {
            auditedHolds.set(action.id, failures);
            yield* audit
              .append({
                orgId: action.orgId,
                event: "credential_check_failed",
                actionId: action.id,
                kind: action.kind,
                result: failures,
              })
              .pipe(Effect.catch((error) => Effect.logWarning("Kin audit not written", error)));
          }
          return { _tag: "held", reason: "credential_check_failed" } as KinExecuteResult;
        }
        auditedHolds.delete(action.id);
        // 3. The claim: one `kin_executions` row, whatever races or restarts.
        const claimed = yield* pending.claim({
          orgId: action.orgId,
          actionId: action.id,
          revision: action.revision,
          grantId: grant.id,
        });
        if (!claimed) return { _tag: "skipped" } as KinExecuteResult;
        const claimedAction: KinPendingAction = { ...action, state: "executing" };
        return yield* runClaimed(claimedAction, grant, handler.value);
      }),
    );
  });

  const reconcile = Effect.fn("KinActionExecutor.reconcile")(function* (ref: ActionRef) {
    return yield* withOrgLock(
      ref.orgId,
      Effect.gen(function* () {
        const found = (yield* pending.executingWithGrant()).find(
          (item) => item.action.orgId === ref.orgId && item.action.id === ref.actionId,
        );
        if (found === undefined) return { _tag: "skipped" } as KinReconcileResult;
        return yield* reconcileClaimed(found.action);
      }),
    );
  });

  const tick = Effect.gen(function* () {
    yield* pending.sweep();
    const approved = yield* pending.approvedWithGrant();
    return yield* Effect.forEach(
      approved,
      ({ action }) => {
        const ref = { orgId: action.orgId, actionId: action.id };
        return execute(ref).pipe(Effect.map((result) => ({ ref, result })));
      },
      { concurrency: "unbounded" },
    );
  }).pipe(Effect.withSpan("KinActionExecutor.tick"));

  return KinActionExecutor.of({ execute, reconcile, tick });
});

/**
 * The executor with its worker: startup reconciliation of `executing` rows (retried with backoff
 * while GitHub can't be read), then every approval as it lands, plus a minute tick for held ones.
 */
export const layer = Layer.effect(
  KinActionExecutor,
  Effect.gen(function* () {
    const executor = yield* make;
    const pending = yield* KinPendingActions;
    const approvals = yield* pending.approvals;
    const logged = <A, E, R>(what: string, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning(`Kin executor: ${what}`, Cause.pretty(cause)),
        ),
      );
    const reconcileUntilDecided = (ref: ActionRef) =>
      executor.reconcile(ref).pipe(
        Effect.repeat({
          schedule: RECONCILE_RETRY,
          while: (result) => result._tag === "unknown",
        }),
      );
    const settle = (
      results: ReadonlyArray<{ readonly ref: ActionRef; readonly result: KinExecuteResult }>,
    ) =>
      Effect.forEach(
        results.filter(({ result }) => result._tag === "reconciling"),
        ({ ref }) => Effect.forkScoped(logged("reconciliation failed", reconcileUntilDecided(ref))),
        { discard: true },
      );
    yield* pending.executingWithGrant().pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          ({ action }) => reconcileUntilDecided({ orgId: action.orgId, actionId: action.id }),
          { concurrency: "unbounded", discard: true },
        ),
      ),
      (effect) => logged("startup reconciliation failed", effect),
      Effect.forkScoped,
    );
    yield* PubSub.take(approvals).pipe(
      Effect.flatMap((ref) =>
        logged(
          "execution failed",
          executor.execute(ref).pipe(Effect.flatMap((result) => settle([{ ref, result }]))),
        ).pipe(Effect.forkScoped),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* logged("tick failed", executor.tick.pipe(Effect.flatMap(settle))).pipe(
      Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
      Effect.forkScoped,
    );
    return executor;
  }),
);

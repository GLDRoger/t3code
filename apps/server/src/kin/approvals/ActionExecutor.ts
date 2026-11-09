import type { KinGrant, KinOrgId, KinPendingAction } from "@t3tools/contracts";
import { decodeKinGrant } from "@t3tools/shared/kinGrant";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
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
import { KinExecutionNotices, type KinExecutionOutcome } from "./ExecutionNotices.ts";
import { KinOrgRoles } from "./GrantPorts.ts";
import { KinExecutionLedger, KinPendingActions, type ActionRef } from "./PendingActions.ts";

/** Held approvals are retried, and orphaned `executing` rows picked up, this often. */
const TICK_INTERVAL = "1 minute";
/** The expiry sweep runs on its own fiber, so a stuck execution can't hold it up. */
const SWEEP_INTERVAL = "1 minute";
/** Reconciliation that can't read GitHub retries until it can; it never re-runs the action. */
const RECONCILE_RETRY = Schedule.spaced("30 seconds");
// GitHub's edge answers 502 after ~10 s while a slow merge keeps running; 2 minutes after the
// write was sent covers that.
const NOT_DONE_AFTER_MS = 2 * 60 * 1000;

export type KinExecuteResult =
  /** Not `approved` with a live grant, or another executor claimed it first. */
  | { readonly _tag: "skipped" }
  /** The stop switch, the credential check or a missing configuration holds it until it lapses. */
  | { readonly _tag: "held"; readonly reason: string }
  | { readonly _tag: "voided"; readonly reason: string }
  | { readonly _tag: "finished"; readonly outcome: KinExecutionOutcome; readonly error?: string }
  /** The side effect may have landed; reconciliation decides, without a second run. */
  | { readonly _tag: "reconciling" };

export type KinReconcileResult =
  | { readonly _tag: "finished"; readonly outcome: KinExecutionOutcome }
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
    /** Reconciles until decided, retrying while GitHub can't tell. */
    readonly settle: (ref: ActionRef) => Effect.Effect<KinReconcileResult, Errors>;
    /** `execute`, then `settle` when the outcome is unknown. What the worker forks. */
    readonly run: (ref: ActionRef) => Effect.Effect<void, Errors>;
    /** Approved actions, and `executing` rows that no fiber in this process holds. */
    readonly pickup: Effect.Effect<
      { readonly approved: ReadonlyArray<ActionRef>; readonly orphaned: ReadonlyArray<ActionRef> },
      Errors
    >;
    readonly sweep: Effect.Effect<void, Errors>;
  }
>()("t3/kin/approvals/ActionExecutor/KinActionExecutor") {}

const failureText = (error: KinExecError) => error.message.slice(0, 500);
const keyOf = (ref: ActionRef) => `${ref.orgId}/${ref.actionId}`;
const refOf = (action: KinPendingAction): ActionRef => ({
  orgId: action.orgId,
  actionId: action.id,
});

export const make = Effect.gen(function* () {
  const pending = yield* KinPendingActions;
  const ledger = yield* KinExecutionLedger;
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
  // Actions a live fiber here is executing or reconciling; anything else `executing` is orphaned.
  const inFlight = new Map<string, number>();
  const holding =
    (ref: ActionRef) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const key = keyOf(ref);
        inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
        return effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const left = (inFlight.get(key) ?? 1) - 1;
              if (left === 0) inFlight.delete(key);
              else inFlight.set(key, left);
            }),
          ),
        );
      });
  // Why each action is held: one audit entry per action and reason, not one per tick, and the
  // reason the owner's notice names if the grant lapses. Entries go when the hold ends.
  const holds = new Map<string, string>();
  const held = Effect.fnUntraced(function* (
    action: KinPendingAction,
    reason: string,
    failures?: string,
  ): Effect.fn.Return<KinExecuteResult> {
    const why = failures === undefined ? reason : `${reason}: ${failures}`;
    if (holds.get(action.id) !== why) {
      holds.set(action.id, why);
      yield* audit
        .append({
          orgId: action.orgId,
          event: failures === undefined ? "execution_held" : "credential_check_failed",
          actionId: action.id,
          kind: action.kind,
          result: failures ?? `held: ${reason}`,
        })
        .pipe(Effect.catch((error) => Effect.logWarning("Kin audit not written", error)));
    }
    return { _tag: "held", reason };
  });

  const paused = (orgId: KinOrgId) =>
    isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  const finish = Effect.fn("KinActionExecutor.finish")(function* (
    action: KinPendingAction,
    outcome: KinExecutionOutcome,
    detail: KinOutcome & { readonly error?: string; readonly reconciled?: boolean },
  ) {
    const recorded = yield* ledger.finish({
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
        ...(detail.note === undefined ? {} : { note: detail.note }),
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

  /** `writeStartedAt`: when the side effect was sent, if it was. "Not done" counts once it's old. */
  const reconcileClaimed = Effect.fn("KinActionExecutor.reconcileClaimed")(function* (
    action: KinPendingAction,
    writeStartedAt: number | null,
  ): Effect.fn.Return<KinReconcileResult, Errors> {
    if (writeStartedAt === null) {
      // Stopped between the claim and the write: nothing was sent, so nothing can land.
      yield* finish(action, "failed", { error: "not_started", reconciled: true });
      return { _tag: "finished", outcome: "failed" } as KinReconcileResult;
    }
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
      if ((yield* Clock.currentTimeMillis) - writeStartedAt < NOT_DONE_AFTER_MS)
        return { _tag: "unknown" } as KinReconcileResult;
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

  /** Steps 4–7, for an action this executor just claimed. */
  const runClaimed = Effect.fn("KinActionExecutor.runClaimed")(function* (
    action: KinPendingAction,
    grant: KinGrant,
    handler: KinActionHandler,
  ) {
    let writeStartedAt: number | null = null;
    const failed = (error: KinExecError) =>
      finish(action, "failed", {
        error: failureText(error),
        ...(error.githubRequestId === undefined ? {} : { githubRequestId: error.githubRequestId }),
      }).pipe(
        Effect.as({ _tag: "finished", outcome: "failed", error: failureText(error) } as const),
      );
    // Everything but the live read happens first, so nothing sits between that read and the write.
    const steps = Effect.gen(function* () {
      const pass = handler.credentialCheck
        ? Option.some(
            yield* hygiene.requirePassing(action.orgId).pipe(
              Effect.mapError(
                (error) =>
                  new KinExecError({
                    reason: "credential_check_failed",
                    detail: error.failures.join(","),
                  }),
              ),
            ),
          )
        : Option.none();
      const usable = yield* ledger
        .signingKeyUsable(refOf(action))
        .pipe(Effect.mapError(() => new KinExecError({ reason: "unavailable", detail: "keys" })));
      if (!usable) return yield* new KinExecError({ reason: "revoked_key" });
      const owner = yield* roles
        .isOwner({ orgId: action.orgId, personId: grant.approverHumanId })
        .pipe(Effect.mapError(() => new KinExecError({ reason: "unavailable", detail: "roles" })));
      if (!owner) return yield* new KinExecError({ reason: "not_owner" });
      yield* handler.precheck(action);
      // The stop switch and the write's start time, immediately before the side effect.
      if (yield* paused(action.orgId).pipe(Effect.orElseSucceed(() => true)))
        return yield* new KinExecError({ reason: "paused" });
      const at = yield* Clock.currentTimeMillis;
      const marked = yield* ledger
        .writeStarting({ ...refOf(action), at })
        .pipe(Effect.orElseSucceed(() => false));
      if (!marked) return yield* new KinExecError({ reason: "unavailable", detail: "ledger" });
      writeStartedAt = at;
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
    const reconciled = yield* reconcileClaimed(action, writeStartedAt);
    return (
      reconciled._tag === "finished"
        ? { _tag: "finished", outcome: reconciled.outcome }
        : { _tag: "reconciling" }
    ) satisfies KinExecuteResult;
  });

  const executeLocked = Effect.fn("KinActionExecutor.executeLocked")(function* (
    ref: ActionRef,
  ): Effect.fn.Return<KinExecuteResult, Errors> {
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
    if (Option.isNone(handler))
      return handlers.unavailable.has(action.kind)
        ? yield* held(action, "not_configured")
        : yield* voided("unsupported_kind");
    // 1. Stop switch: stay approved until the grant lapses; the sweep then voids it.
    if (yield* paused(action.orgId)) return yield* held(action, "paused");
    // 2. The approver still meets the requirement (the claim re-checks key and grant expiry).
    const owner = yield* roles
      .isOwner({ orgId: action.orgId, personId: grant.approverHumanId })
      .pipe(Effect.option);
    if (Option.isNone(owner)) return yield* held(action, "roles_unavailable");
    if (!owner.value) return yield* voided("approver_not_owner");
    // Checked before the claim too, so a misconfigured host holds the grant instead of spending it.
    if (handler.value.credentialCheck) {
      const check = yield* hygiene.requirePassing(action.orgId).pipe(Effect.flip, Effect.option);
      if (Option.isSome(check))
        return yield* held(action, "credential_check_failed", check.value.failures.join(","));
    }
    // 3. The claim: one `kin_executions` row, whatever races or restarts.
    const claimed = yield* ledger.claim({
      orgId: action.orgId,
      actionId: action.id,
      revision: action.revision,
      grantId: grant.id,
    });
    if (!claimed) return { _tag: "skipped" } as KinExecuteResult;
    const claimedAction: KinPendingAction = { ...action, state: "executing" };
    return yield* runClaimed(claimedAction, grant, handler.value);
  });

  const execute = (ref: ActionRef) =>
    withOrgLock(ref.orgId, executeLocked(ref)).pipe(
      Effect.tap((result) =>
        result._tag === "held" ? Effect.void : Effect.sync(() => holds.delete(ref.actionId)),
      ),
      holding(ref),
      Effect.withSpan("KinActionExecutor.execute"),
    );

  const reconcile = Effect.fn("KinActionExecutor.reconcile")(function* (ref: ActionRef) {
    return yield* withOrgLock(
      ref.orgId,
      Effect.gen(function* () {
        const found = (yield* pending.executingWithGrant()).find(
          (item) => item.action.orgId === ref.orgId && item.action.id === ref.actionId,
        );
        if (found === undefined) return { _tag: "skipped" } as KinReconcileResult;
        return yield* reconcileClaimed(found.action, found.writeStartedAt);
      }),
    );
  });

  const settle = (ref: ActionRef) =>
    reconcile(ref).pipe(
      Effect.repeat({
        schedule: RECONCILE_RETRY,
        while: (result) => result._tag === "unknown",
      }),
      holding(ref),
    );

  const run = (ref: ActionRef) =>
    execute(ref).pipe(
      Effect.flatMap((result) => (result._tag === "reconciling" ? settle(ref) : Effect.void)),
      Effect.asVoid,
      holding(ref),
    );

  const pickup = Effect.gen(function* () {
    const free = (ref: ActionRef) => !inFlight.has(keyOf(ref));
    const approved = (yield* pending.approvedWithGrant()).map(({ action }) => refOf(action));
    const executing = (yield* pending.executingWithGrant()).map(({ action }) => refOf(action));
    return { approved: approved.filter(free), orphaned: executing.filter(free) };
  }).pipe(Effect.withSpan("KinActionExecutor.pickup"));

  // A grant that lapsed while held: the owner learns why it never ran.
  const lapsed = Effect.fnUntraced(function* (ref: ActionRef) {
    const reason = holds.get(ref.actionId);
    holds.delete(ref.actionId);
    if (reason === undefined) return;
    const action = yield* pending.get(ref);
    if (Option.isSome(action)) yield* notices.lapsed({ action: action.value, holdReason: reason });
  });
  const sweep = pending.sweep().pipe(
    Effect.flatMap(({ voided }) => Effect.forEach(voided, lapsed, { discard: true })),
    Effect.asVoid,
    Effect.withSpan("KinActionExecutor.sweep"),
  );

  return KinActionExecutor.of({ execute, reconcile, settle, run, pickup, sweep });
});

/**
 * The executor with its worker: every approval as it lands, a minute tick that retries held
 * approvals and reconciles orphaned `executing` rows (all of them at startup), and the expiry
 * sweep on its own schedule. Each execution is forked, so one stuck call holds up only its org.
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
    yield* logged("sweep failed", executor.sweep).pipe(
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
      Effect.forkScoped,
    );
    yield* PubSub.take(approvals).pipe(
      Effect.flatMap((ref) =>
        logged("execution failed", executor.run(ref)).pipe(Effect.forkScoped),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    const tick = executor.pickup.pipe(
      Effect.flatMap(({ approved, orphaned }) =>
        Effect.all([
          Effect.forEach(
            approved,
            (ref) => logged("execution failed", executor.run(ref)).pipe(Effect.forkScoped),
            { discard: true },
          ),
          Effect.forEach(
            orphaned,
            (ref) => logged("reconciliation failed", executor.settle(ref)).pipe(Effect.forkScoped),
            { discard: true },
          ),
        ]),
      ),
    );
    yield* logged("tick failed", tick).pipe(
      Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
      Effect.forkScoped,
    );
    return executor;
  }),
);

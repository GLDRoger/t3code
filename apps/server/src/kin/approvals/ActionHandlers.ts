import type {
  KinActionKind,
  KinGrant,
  KinGrantPayload,
  KinPendingAction,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { CredentialHygienePass } from "./CredentialHygiene.ts";

export const KinExecFailure = Schema.Literals([
  "head_moved",
  "base_changed",
  "not_open",
  "merge_queue_unsupported",
  "not_mergeable",
  "denied",
  "not_found",
  "rate_limited",
  "invalid",
  "unavailable",
  "credential_check_failed",
  "merge_token_missing",
  "paused",
  "grant_mismatch",
  "refused",
  // The side effect may have happened: the executor reconciles and never retries the run.
  "unknown_outcome",
]);
export type KinExecFailure = typeof KinExecFailure.Type;

export class KinExecError extends Schema.TaggedError<KinExecError>()("KinExecError", {
  reason: KinExecFailure,
  /** GitHub's message or the handler's own reason. Never a credential or a request body. */
  detail: Schema.optional(Schema.String),
  githubRequestId: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return this.detail === undefined ? this.reason : `${this.reason}: ${this.detail}`;
  }
}

/** What a finished run records: the merge commit for a merge, GitHub's request id when known. */
export interface KinOutcome {
  readonly mergeCommitSha?: string;
  readonly githubRequestId?: string;
}

/** Startup reconciliation's answer; a bare `"done"` is a success with nothing more to record. */
export type KinReconcileVerdict =
  | "done"
  | "not_done"
  | "unknown"
  | { readonly _tag: "done"; readonly outcome: KinOutcome };

export interface KinExecutionContext {
  /** The stored grant the claim consumed. */
  readonly grant: KinGrant;
  /** The owner-signed payload, decoded from `grant.compact` (already verified at submission). */
  readonly payload: Effect.Effect<KinGrantPayload, KinExecError>;
  /** A credential hygiene pass from just before `run`; the owner merge token needs it. */
  readonly pass: CredentialHygienePass;
}

/**
 * Spec section 6. Only `KinActionExecutor` calls these, and only for an action it has claimed, so
 * nothing a model, MCP tool or RPC sends reaches `run`.
 */
export interface KinActionHandler {
  readonly kind: KinActionKind;
  /** Re-reads live state after the claim; any failure ends the action `failed`. */
  readonly precheck: (action: KinPendingAction) => Effect.Effect<void, KinExecError>;
  /** The side effect. The stop switch was checked just before the executor called it. */
  readonly run: (
    action: KinPendingAction,
    context: KinExecutionContext,
  ) => Effect.Effect<KinOutcome, KinExecError>;
  /** After a crash mid-run: did the side effect land? `unknown` keeps the action `executing`. */
  readonly reconcile: (
    action: KinPendingAction,
  ) => Effect.Effect<KinReconcileVerdict, KinExecError>;
}

/** The executor's handler registry. Kinds with no handler are never executed. */
export class KinActionHandlers extends Context.Service<
  KinActionHandlers,
  {
    readonly get: (kind: KinActionKind) => Option.Option<KinActionHandler>;
    readonly kinds: ReadonlySet<KinActionKind>;
  }
>()("t3/kin/approvals/ActionHandlers/KinActionHandlers") {}

/** One handler per kind; registering a kind twice is a wiring bug. */
export const make = (handlers: ReadonlyArray<KinActionHandler>) => {
  const byKind = new Map<KinActionKind, KinActionHandler>();
  for (const handler of handlers) {
    if (byKind.has(handler.kind)) throw new Error(`Two Kin action handlers for ${handler.kind}`);
    byKind.set(handler.kind, handler);
  }
  return KinActionHandlers.of({
    get: (kind) => Option.fromNullishOr(byKind.get(kind)),
    kinds: new Set(byKind.keys()),
  });
};

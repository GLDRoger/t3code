import type {
  KinApprovalError,
  KinKeyThumbprint,
  KinOrgId,
  KinPendingAction,
  KinPersonId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type KinExecutionOutcome = "succeeded" | "failed" | "interrupted";

/**
 * Posts the result to the requesting lead's chat. The chat lives outside approvals, and this tag
 * lives outside `ActionExecutor.ts` so the chat side never imports the executor.
 */
export class KinExecutionNotices extends Context.Service<
  KinExecutionNotices,
  {
    readonly finished: (input: {
      readonly action: KinPendingAction;
      readonly outcome: KinExecutionOutcome;
      readonly mergeCommitSha?: string;
      readonly error?: string;
      /** Something the owner should know about a success, such as a head branch left in place. */
      readonly note?: string;
    }) => Effect.Effect<void>;
    /** An approval whose grant lapsed while the executor held it; `holdReason` says why. */
    readonly lapsed: (input: {
      readonly action: KinPendingAction;
      readonly holdReason: string;
    }) => Effect.Effect<void>;
  }
>()("t3/kin/approvals/ExecutionNotices/KinExecutionNotices") {}

/** A phone that started or stopped being able to approve, as `KinKeyNotices` tells the owner. */
export type KinKeyChange = {
  readonly orgId: KinOrgId;
  readonly ownerPersonId: KinPersonId;
  readonly thumbprint: KinKeyThumbprint;
  /** As the phone reported it: untrusted text. */
  readonly deviceLabel: string;
  readonly platform: string;
  readonly change: "added" | "removed";
  readonly at: number;
  /** Removing it left no phone that can approve. */
  readonly lastKey: boolean;
};

/**
 * Writes a fixed-text notice into the owner's own chat inside the caller's transaction, so it
 * lands exactly when the key change does; a failure rolls the change back. The push follows from
 * the stored message after commit. Tag here, layer in the chat module, as with `KinExecutionNotices`.
 */
export class KinKeyNotices extends Context.Service<
  KinKeyNotices,
  { readonly changed: (input: KinKeyChange) => Effect.Effect<void, KinApprovalError> }
>()("t3/kin/approvals/ExecutionNotices/KinKeyNotices") {}

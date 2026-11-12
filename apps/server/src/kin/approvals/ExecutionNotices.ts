import type { KinKeyThumbprint, KinOrgId, KinPendingAction } from "@t3tools/contracts";
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
  readonly thumbprint: KinKeyThumbprint;
  /** As the phone reported it: untrusted text. */
  readonly deviceLabel: string;
  readonly platform: string;
  readonly change: "allowed" | "removed";
  readonly at: number;
};

/**
 * Posts a fixed-text notice in the owner's chat with the chief of staff, which also pushes to
 * the owner's phones. Tag here, layer in the chat module, as with `KinExecutionNotices`.
 */
export class KinKeyNotices extends Context.Service<
  KinKeyNotices,
  { readonly changed: (input: KinKeyChange) => Effect.Effect<void> }
>()("t3/kin/approvals/ExecutionNotices/KinKeyNotices") {}

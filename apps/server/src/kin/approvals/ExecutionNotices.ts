import type { KinPendingAction } from "@t3tools/contracts";
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
  }
>()("t3/kin/approvals/ExecutionNotices/KinExecutionNotices") {}

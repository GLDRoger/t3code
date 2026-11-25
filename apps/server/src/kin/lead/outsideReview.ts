import type { KinGithubTrigger, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { boundReview } from "../github/boundReview.ts";

/**
 * A pull request to review by someone who can't write to its repo. Its turn is review-only: a
 * prompt of that pull request and nothing private (`LeadPrompt`), its own shared thread with no
 * web search, one tool, `kin_github_review` on that pull request as a comment, posted once per
 * head (`reviewAsk.ts` `postReview`), and the owner told by Kin, never by the model.
 */
export const isOutsideReview = (trigger: Pick<KinGithubTrigger, "kind" | "inside">) =>
  !trigger.inside && (trigger.kind === "review" || trigger.kind === "review_request");

/** Under `SHARED_THREAD_PREFIX`, so every shared-thread rule holds; it lists only `REVIEW_TOOLS`. */
export const REVIEW_THREAD_PREFIX = "kin-shared:review:";

/** What every tool but the review answers in that turn. */
export const REVIEW_REFUSAL =
  "This turn can only post its one review, with kin_github_review on this pull request. Nothing else ran.";

type Turn = { readonly orgId: KinOrgId; readonly wakeupId: string };

/** The outside review this turn was woken for, or undefined (`boundReview`). */
export const outsideReview = Effect.fn("KinOutsideReview.of")(function* (turn: Turn) {
  const bound = yield* boundReview(turn);
  return bound?.outside === true ? bound : undefined;
});

export const REVIEW_TOOLS: ReadonlySet<string> = new Set(["kin_github_review", "kin_github_diff"]);

/**
 * Whether `name` may run in an outside review turn; undefined when the turn isn't one. Where and
 * how the review posts is the write's own check (`postReview`).
 */
export const reviewToolAllowed = Effect.fn("KinOutsideReview.allowed")(
  function* (turn: Turn, name: string, _args: unknown) {
    const review = yield* outsideReview(turn);
    if (review === undefined) return undefined;
    return REVIEW_TOOLS.has(name);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin outside review check failed; refusing", { cause }).pipe(
      Effect.as<boolean | undefined>(false),
    ),
  ),
);

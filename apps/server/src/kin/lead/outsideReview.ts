import {
  KinChatError,
  type KinAgentId,
  type KinGithubTrigger,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { OUTSIDE_REFUSAL } from "./OutsideContent.ts";

/**
 * A pull request to review by someone who can't write to its repo. Its turn is review-only: it is
 * read as the team reads (`turnAudience`), runs on its own shared thread, and may call only
 * `REVIEW_TOOLS`, posting one review on that pull request per head.
 */
export const isOutsideReview = (trigger: Pick<KinGithubTrigger, "kind" | "inside">) =>
  !trigger.inside && (trigger.kind === "review" || trigger.kind === "review_request");

/** Under `SHARED_THREAD_PREFIX`, so every shared-thread rule holds; it lists only `REVIEW_TOOLS`. */
export const REVIEW_THREAD_PREFIX = "kin-shared:review:";

type Turn = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
};
type Review = { readonly repo: string; readonly number: number; readonly key: string };

/** The stored event `isOutsideReview` holds for, or undefined: each GitHub trigger has its own lane. */
export const outsideReview = Effect.fn("KinOutsideReview.of")(function* (turn: Turn) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<Review>`SELECT json_extract(json, '$.repo') AS repo,
      json_extract(json, '$.trigger.number') AS number, json_extract(json, '$.trigger.key') AS key
    FROM kin_events WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId}
      AND wakeup_id = ${turn.wakeupId} AND tag = 'github'
      AND json_extract(json, '$.trigger.inside') = 0
      AND json_extract(json, '$.trigger.kind') IN ('review', 'review_request')
    ORDER BY event_id LIMIT 1`;
  return row;
});

const postedKey = (review: Review) => `posted:${review.key}`;

const posted = Effect.fnUntraced(function* (orgId: KinOrgId, review: Review) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_github_handled
    WHERE org_id = ${orgId} AND trigger_key = ${postedKey(review)} LIMIT 1`;
  return rows.length > 0;
});

const field = (args: unknown, name: string) =>
  Predicate.hasProperty(args, name) ? args[name] : undefined;

const isPull = (review: Review, repo: unknown, number: unknown) =>
  typeof repo === "string" &&
  repo.toLowerCase() === review.repo.toLowerCase() &&
  number === review.number;

const PULL_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)\/?$/i;

type Condition = (
  orgId: KinOrgId,
  review: Review,
  args: unknown,
) => Effect.Effect<boolean, SqlError, SqlClient.SqlClient>;

export const REVIEW_TOOLS: Record<string, "allowed" | Condition> = {
  kin_github_review: (orgId, review, args) =>
    isPull(review, field(args, "repo"), field(args, "number"))
      ? Effect.map(posted(orgId, review), (done) => !done)
      : Effect.succeed(false),
  kin_github_link: (_orgId, review, args) => {
    const url = field(args, "url");
    const match = typeof url === "string" ? PULL_URL.exec(url.trim()) : null;
    return Effect.succeed(match !== null && isPull(review, match[1], Number(match[2])));
  },
  // `LeadMemory` reads only what the team can know in a shared turn.
  memory_search: "allowed",
  memory_read: "allowed",
};

/** Whether `name` may run in an outside review turn; undefined when the turn isn't one. */
export const reviewToolAllowed = Effect.fn("KinOutsideReview.allowed")(
  function* (turn: Turn, name: string, args: unknown) {
    const review = yield* outsideReview(turn);
    if (review === undefined) return undefined;
    const policy = Object.hasOwn(REVIEW_TOOLS, name) ? REVIEW_TOOLS[name] : undefined;
    if (policy === undefined) return false;
    if (policy === "allowed") return true;
    return yield* policy(turn.orgId, review, args);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin outside review check failed; refusing", { cause }).pipe(
      Effect.as<boolean | undefined>(false),
    ),
  ),
);

/**
 * Runs `post` once for the review an outside review turn was woken for, claimed before it posts
 * and given back when nothing was posted; any other turn's `post` runs as it is.
 */
export const reviewOnce = Effect.fn("KinOutsideReview.once")(function* <A, E, R>(
  turn: Turn,
  post: Effect.Effect<A | undefined, E, R>,
) {
  const review = yield* outsideReview(turn);
  if (review === undefined) return yield* post;
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  const claimed = yield* sql`INSERT INTO kin_github_handled (org_id, trigger_key, repo, number,
      agent_id, outcome, at)
    VALUES (${turn.orgId}, ${postedKey(review)}, ${review.repo.toLowerCase()}, ${review.number},
      ${turn.agentId}, 'posted', ${at})
    ON CONFLICT DO NOTHING RETURNING trigger_key`;
  if (claimed.length === 0)
    return yield* new KinChatError({ reason: "not_allowed", message: OUTSIDE_REFUSAL });
  const giveBack = sql`DELETE FROM kin_github_handled
    WHERE org_id = ${turn.orgId} AND trigger_key = ${postedKey(review)}`.pipe(Effect.ignore);
  return yield* post.pipe(
    Effect.tap((result) => (result === undefined ? giveBack : Effect.void)),
    Effect.onError(() => giveBack),
  );
});

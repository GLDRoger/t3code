import { githubWakeHasShell, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The one identity of a review of a pull request at one head, in `kin_github_handled`. */
export const headKey = (repo: string, number: number, headSha: string) =>
  `review:${repo.toLowerCase()}#${number}:${headSha}`;

/** Kept beside a head's row when its review was posted meaning to block: a requeued turn keeps it. */
export const blocksKey = (key: string) => `blocks:${key}`;

/**
 * A head row's `review_url` while a post of it was sent and GitHub's answer is unknown: it holds
 * the head as posted might have, so at worst no review goes out, never two.
 */
export const POSTING = "posting";

/** What a head row's `review_url` says: nothing posted, a post's link, or a post not known. */
export const receiptOf = (url: string | null) =>
  url === null
    ? ({ _tag: "none" } as const)
    : url === POSTING
      ? ({ _tag: "unknown" } as const)
      : ({ _tag: "posted", url } as const);

export interface BoundReview {
  readonly eventId: string;
  readonly repo: string;
  readonly number: number;
  /** The head admitted, which the post is placed on. */
  readonly head: string | undefined;
  /** The head's row, where the receipt is kept. */
  readonly key: string;
  readonly url: string | null;
  /** Someone in the company asked for it in Kin. */
  readonly asked: boolean;
  /** Its author can't write to the repo: COMMENT only, on that pull request only. */
  readonly outside: boolean;
}

/**
 * The one answer to "is this turn bound to one pull request at one head, and has it posted": a
 * review someone asked for, a re-review after new commits, or a review that cannot use the shell.
 * Each GitHub trigger has its own lane, so at most one such event.
 */
export const boundReview = Effect.fn("KinGitHubReview.bound")(function* (turn: {
  readonly orgId: KinOrgId;
  readonly wakeupId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    eventId: string;
    repo: string;
    number: number;
    key: string;
    head: string | null;
    asked: number;
    again: number;
    inside: number | null;
    ownerAuthored: number | null;
    outside: number;
  }>`SELECT event_id AS "eventId", json_extract(json, '$.repo') AS repo,
      json_extract(json, '$.trigger.number') AS number,
      json_extract(json, '$.trigger.key') AS key,
      json_extract(json, '$.trigger.pull.headSha') AS head,
      json_extract(json, '$.askedBy') IS NOT NULL AS asked,
      json_extract(json, '$.trigger.pull.reReview') IS NOT NULL AS again,
      json_extract(json, '$.trigger.inside') AS inside,
      json_extract(json, '$.trigger.ownerAuthored') AS "ownerAuthored",
      (json_extract(json, '$.trigger.inside') = 0
        AND json_extract(json, '$.trigger.kind') IN ('review', 'review_request')) AS outside
    FROM kin_events
    WHERE org_id = ${turn.orgId} AND wakeup_id = ${turn.wakeupId} AND tag = 'github'
      AND (json_extract(json, '$.askedBy') IS NOT NULL
        OR json_extract(json, '$.trigger.pull.reReview') IS NOT NULL
        OR json_extract(json, '$.trigger.kind') IN ('review', 'review_request'))
    ORDER BY event_id`;
  const event = rows.find(
    (row) =>
      row.asked === 1 ||
      row.again === 1 ||
      !githubWakeHasShell({
        inside: row.inside === 1,
        ownerAuthored: row.ownerAuthored === 1 ? true : undefined,
      }),
  );
  if (event === undefined) return undefined;
  const key = event.head === null ? event.key : headKey(event.repo, event.number, event.head);
  const [row] = yield* sql<{ url: string | null }>`SELECT review_url AS url
    FROM kin_github_handled WHERE org_id = ${turn.orgId} AND trigger_key = ${key}`;
  return {
    eventId: event.eventId,
    repo: event.repo,
    number: event.number,
    head: event.head ?? undefined,
    key,
    url: row?.url ?? null,
    asked: event.asked === 1,
    outside: event.outside === 1,
  } satisfies BoundReview;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { threshold, toMs } from "../thresholds.ts";
import {
  agentOrOwner,
  elapsed,
  hoursText,
  iso,
  measure,
  type SenseContext,
  type SensedFact,
} from "./shared.ts";
import { SENSE_CAP } from "./work.ts";

interface PullFactRow {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly author: string | null;
  readonly draft: number;
  readonly headSha: string | null;
  readonly openedAt: number;
  readonly reviewRequestedAt: number | null;
  readonly checks: string | null;
  readonly checksSha: string | null;
  readonly readyAt: number | null;
}

/** Open PRs in connected repos, as webhooks left them (`kin_pull_requests`); all go to Tech. */
export const codeSenses = Effect.fn("KinPulse.codeSenses")(function* (ctx: SenseContext) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = ctx;
  const openLong = yield* threshold(orgId, "pr_open_too_long_hours");
  const reviewWait = yield* threshold(orgId, "review_waiting_hours");
  const rows = yield* sql<PullFactRow>`SELECT repo, number, title, author, draft,
      head_sha AS "headSha", opened_at AS "openedAt", review_requested_at AS "reviewRequestedAt",
      checks, checks_sha AS "checksSha", ready_at AS "readyAt"
    FROM kin_pull_requests WHERE org_id = ${orgId} AND state = 'open' AND opened_at <= ${at}
    ORDER BY opened_at, repo, number LIMIT ${SENSE_CAP}`;
  const actor = agentOrOwner(ctx.tech);
  const facts: Array<SensedFact> = [];
  for (const row of rows) {
    const name = `${row.repo}#${row.number}`;
    const by = row.author === null ? "" : ` by ${row.author}`;
    const base = {
      family: "code" as const,
      subject: { kind: "pull_request" as const, key: name, title: row.title.slice(0, 280) || name },
      scope: {},
      actor,
      sensitive: false,
    };
    if (row.draft === 0 && row.openedAt <= at - toMs(openLong)) {
      const hours = elapsed(row.openedAt, at, "hours");
      facts.push({
        ...base,
        sense: "pr_open_long",
        key: `pr_open_long:${name}:opened=${row.openedAt}`,
        since: iso(row.openedAt + toMs(openLong)),
        measure: measure(hours, openLong),
        consequence: `PR ${name}${by} has been open ${hoursText(hours)}.`,
        wake: "sweep",
      });
    }
    if (row.checks === "failure")
      facts.push({
        ...base,
        sense: "pr_failing",
        key: `pr_failing:${name}:sha=${row.checksSha ?? row.headSha ?? "unknown"}`,
        since: iso(at),
        consequence: `PR ${name}${by} has failing checks on its latest commit.`,
        wake: "now",
      });
    if (
      row.draft === 0 &&
      row.reviewRequestedAt !== null &&
      row.reviewRequestedAt <= at - toMs(reviewWait)
    ) {
      const hours = elapsed(row.reviewRequestedAt, at, "hours");
      facts.push({
        ...base,
        sense: "pr_review_waiting",
        key: `pr_review_waiting:${name}:requested=${row.reviewRequestedAt}`,
        since: iso(row.reviewRequestedAt + toMs(reviewWait)),
        measure: measure(hours, reviewWait),
        consequence: `PR ${name}${by} has waited ${hoursText(hours)} for a review.`,
        wake: "sweep",
      });
    }
    if (row.readyAt !== null && row.readyAt <= at)
      facts.push({
        ...base,
        sense: "pr_ready",
        key: `pr_ready:${name}:sha=${row.headSha ?? "unknown"}`,
        since: iso(row.readyAt),
        consequence: `PR ${name}${by} is approved with green checks: offer the owner the merge.`,
        wake: "now",
      });
  }
  return facts;
});

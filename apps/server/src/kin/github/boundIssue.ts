import { KinChatError, type KinGithubTrigger, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { POSTING, receiptOf } from "./boundReview.ts";
import { sendIssueComment } from "./GitHubWatch.ts";
import { issueCommentText } from "./issueCommentText.ts";

export const isTriage = (kind: KinGithubTrigger["kind"]) =>
  kind === "triage" || kind === "triage_reply";

type Turn = { readonly orgId: KinOrgId; readonly wakeupId: string };
const decodeConversation = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ author: Schema.String, kin: Schema.Boolean })),
  ),
);

export const boundIssue = Effect.fn("KinGitHubIssue.bound")(function* (turn: Turn) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    eventId: string;
    repo: string;
    number: number;
    key: string;
    issueUrl: string;
    outside: number;
    author: string;
    conversation: string | null;
    kind: "triage" | "triage_reply";
    url: string | null;
  }>`SELECT e.event_id AS "eventId", json_extract(e.json, '$.repo') AS repo,
      json_extract(e.json, '$.trigger.number') AS number,
      json_extract(e.json, '$.trigger.key') AS key,
      json_extract(e.json, '$.trigger.url') AS "issueUrl",
      json_extract(e.json, '$.trigger.inside') = 0 AS outside,
      json_extract(e.json, '$.trigger.author') AS author,
      json_extract(e.json, '$.trigger.conversation') AS conversation,
      json_extract(e.json, '$.trigger.kind') AS kind, h.review_url AS url
    FROM kin_events e LEFT JOIN kin_github_handled h ON h.org_id = e.org_id
      AND h.trigger_key = json_extract(e.json, '$.trigger.key')
    WHERE e.org_id = ${turn.orgId} AND e.wakeup_id = ${turn.wakeupId} AND e.tag = 'github'
      AND json_extract(e.json, '$.trigger.item') = 'issue'
      AND json_extract(e.json, '$.trigger.kind') IN ('triage', 'triage_reply')
    ORDER BY e.event_id LIMIT 2`;
  const [event] = rows;
  if (event === undefined || rows.length !== 1) return undefined;
  return { ...event, outside: event.outside === 1 };
});

// Words under eval: change them only with the triage cases.
export const COMMENT_REFUSAL = {
  unbound:
    "kin_github_comment posts only the one comment a new issue's turn is for. Comment anywhere else with gh issue comment.",
  again: (ref: string) => `The comment on ${ref} is already posted. Nothing more was posted.`,
  unsure: (ref: string) =>
    `A comment on ${ref} was sent and GitHub never said whether it took it, so Kin sends no other. Nothing was posted.`,
  unknown: (ref: string) =>
    `GitHub didn't say whether it took the comment on ${ref}, so Kin won't send it again. It may be on the issue.`,
};
const COMMENT_NEXT =
  "Posted on the issue. Nothing you write now goes anywhere: write exactly NO_REPLY.";

export const CommentInput = Schema.Struct({
  body: Schema.String.annotate({ description: "Body in plain words, at most 2,000 characters." }),
  owner: Schema.optional(
    Schema.Literals(["security", "data_loss", "decision", "rule"]).annotate({
      description: "Only when the issue needs the owner.",
    }),
  ),
});
export const CommentResult = Schema.Struct({
  status: Schema.Literal("posted"),
  url: Schema.String,
  next: Schema.String,
  notes: Schema.optional(Schema.Array(Schema.String)),
});

export const triagedKey = (repo: string, number: number) =>
  `triaged:${repo.toLowerCase()}#${number}`;
export const ownerFlagKey = (key: string) => `owner:${key}`;
export const commentFailKey = (key: string) => `commentfail:${key}`;

const refuse = (message: string, reason: "not_allowed" | "unavailable" = "not_allowed") =>
  Effect.fail(new KinChatError({ reason, message }));

export const postIssueComment = Effect.fn("KinGitHubIssue.postComment")(function* (
  lead: Turn & { readonly agentId: string },
  input: typeof CommentInput.Type,
) {
  const bound = yield* boundIssue(lead);
  if (bound === undefined) return yield* refuse(COMMENT_REFUSAL.unbound);
  const sql = yield* SqlClient.SqlClient;
  const { eventId, key, number, outside } = bound;
  const repo = bound.repo.toLowerCase();
  const ref = `${repo}#${number}`;
  const callKey = `github-comment:${eventId}`;
  const already = (url: string | null) => {
    const receipt = receiptOf(url);
    return receipt._tag === "unknown" ? COMMENT_REFUSAL.unsure(ref) : COMMENT_REFUSAL.again(ref);
  };
  if (bound.url !== null) return yield* refuse(already(bound.url));

  const [agent] = yield* sql<{ name: string }>`SELECT name FROM kin_leads
    WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}`;
  let people: Set<string> | undefined;
  if (outside) {
    people = new Set([bound.author.toLowerCase()]);
    if (bound.kind === "triage_reply") {
      const [initial] = yield* sql<{
        author: string;
      }>`SELECT json_extract(json, '$.trigger.author') AS author
        FROM kin_events WHERE org_id = ${lead.orgId} AND dedupe_key = ${`poll:triage:${ref}`}
        AND tag = 'github' ORDER BY event_id LIMIT 1`;
      if (initial !== undefined) people.add(initial.author.toLowerCase());
      for (const comment of decodeConversation(bound.conversation ?? "[]").pipe((decoded) =>
        decoded._tag === "Some" ? decoded.value : [],
      ))
        if (!comment.kin) people.add(comment.author.toLowerCase());
    }
  }
  const comment = issueCommentText(input.body, agent?.name ?? "Agent", repo, people);
  if ("refusal" in comment) return yield* refuse(comment.refusal);

  const claimed = yield* sql.withTransaction(
    Effect.gen(function* () {
      const claimed = yield* sql`UPDATE kin_github_handled SET review_url = ${POSTING}
      WHERE org_id = ${lead.orgId} AND trigger_key = ${key} AND review_url IS NULL
      AND repo = ${repo} AND number = ${number} AND outcome = 'woke'
      AND EXISTS (SELECT 1 FROM kin_wakeups WHERE org_id = ${lead.orgId}
        AND wakeup_id = ${lead.wakeupId} AND agent_id = ${lead.agentId}
        AND status = 'running' AND aborted_at IS NULL)
      RETURNING trigger_key`;
      if (claimed.length === 0) return false;
      yield* sql`INSERT INTO kin_lead_tool_calls (org_id, wakeup_id, call_key, request_hash)
      VALUES (${lead.orgId}, ${lead.wakeupId}, ${callKey}, 'issue-comment') ON CONFLICT DO NOTHING`;
      return true;
    }),
  );
  if (!claimed) {
    const current = yield* boundIssue(lead);
    return yield* refuse(current?.url == null ? COMMENT_REFUSAL.unbound : already(current.url));
  }

  const save = (rowKey: string, outcome: string, at: number) =>
    sql`INSERT INTO kin_github_handled (org_id, trigger_key, repo, number, agent_id, outcome, at)
      VALUES (${lead.orgId}, ${rowKey}, ${repo}, ${number}, ${lead.agentId}, ${outcome}, ${at})
      ON CONFLICT (org_id, trigger_key) DO UPDATE SET outcome = excluded.outcome,
        at = MAX(kin_github_handled.at, excluded.at)`;

  const sent = yield* sendIssueComment(lead.orgId, { repo, number, outside, body: comment.body });
  switch (sent._tag) {
    case "posted":
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE kin_github_handled SET review_url = ${sent.url}
          WHERE org_id = ${lead.orgId} AND trigger_key = ${key}`;
          yield* save(triagedKey(repo, number), "posted", sent.createdAt);
          if (input.owner !== undefined)
            yield* save(ownerFlagKey(key), input.owner, sent.createdAt);
          yield* sql`DELETE FROM kin_github_handled WHERE org_id = ${lead.orgId}
          AND trigger_key = ${commentFailKey(key)}`;
        }),
      );
      return {
        status: "posted" as const,
        url: sent.url,
        next: COMMENT_NEXT,
        ...(comment.notes.length === 0 ? {} : { notes: comment.notes }),
      };
    case "refused":
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* save(commentFailKey(key), "failed", yield* Clock.currentTimeMillis);
          yield* sql`DELETE FROM kin_lead_tool_calls WHERE org_id = ${lead.orgId}
          AND wakeup_id = ${lead.wakeupId} AND call_key = ${callKey}`;
          yield* sql`UPDATE kin_github_handled SET review_url = NULL
          WHERE org_id = ${lead.orgId} AND trigger_key = ${key} AND review_url = ${POSTING}`;
        }),
      );
      return yield* refuse(sent.message, sent.reason);
    case "unknown":
      return yield* refuse(COMMENT_REFUSAL.unknown(ref), "unavailable");
  }
});

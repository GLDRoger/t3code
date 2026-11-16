import {
  KinChatError,
  KinOrgId,
  KinPersonId,
  KinRecordKey,
  RepoSlug,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientRequest } from "effect/http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import * as Scheduler from "../../scheduling/Scheduler.ts";
import { effectiveAudience, SHARED_GITHUB, turnChat } from "../lead/Audience.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { KinGithubRepoScope } from "../triggers/githubEvents.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { askOwner } from "../work/leadMoney.ts";
import type { Lead } from "../work/leadWork.ts";
import { writerFor } from "../work/leadWork.ts";
import { gitHubAnswer, gitHubRequest, repoPath } from "./githubRest.ts";
import { KinGitHubApp } from "./KinGitHubApp.ts";
import type { KinGitHubPermissionSet } from "./KinGitHubPermissions.ts";
import { NOT_CONNECTED } from "./KinRepoReads.ts";
import { TurnEvent } from "../lead/eventIds.ts";

const githubItem = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/i;
/** A GitHub issue or PR URL as `{ repo, kind, number }`; anything else is undefined. */
const parseGithubItem = (url: string) => {
  const match = githubItem.exec(url.trim());
  if (match === null) return undefined;
  return {
    repo: match[1]!,
    kind: match[2]!.toLowerCase() === "pull" ? ("pull_request" as const) : ("issue" as const),
    number: Number(match[3]),
  };
};

const ReviewComment = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
});
export const ReviewInput = Schema.Struct({
  repo: Schema.String.annotate({ description: "owner/name, from kin_github_repos." }),
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  body: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(30_000))),
  event: Schema.optional(Schema.Literals(["COMMENT", "REQUEST_CHANGES"])),
  comments: Schema.optional(Schema.Array(ReviewComment).check(Schema.isMaxLength(50))),
  proposal: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "A proposal this tool returned earlier: posts it once the owner confirmed.",
  }),
  sourceEventId: TurnEvent,
});
export const ReviewResult = Schema.Struct({
  status: Schema.Literals(["posted", "proposed", "waiting", "declined"]),
  proposal: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  next: Schema.String,
});
export const LinkInput = Schema.Struct({
  entry: KinRecordKey,
  url: TrimmedNonEmptyString.annotate({
    description: "A GitHub issue or pull request URL in a connected repo.",
  }),
  sourceEventId: TurnEvent,
});
export const LinkResult = Schema.Struct({ entry: Schema.String, linked: Schema.String });

/** What a PR worker starts from, read from GitHub as it is now. */
export interface PullTarget {
  readonly repo: RepoSlug;
  readonly number: number;
  readonly title: string;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  /** The head branch lives in this repo, so Kin can push to it. */
  readonly sameRepo: boolean;
  /** GitHub's unified diff, cut at `DIFF_CAP` characters. */
  readonly diff: string;
}

type Review = typeof ReviewInput.Type;
const StoredReview = Schema.fromJsonString(
  Schema.Struct({
    body: Schema.String,
    event: Schema.Literals(["COMMENT", "REQUEST_CHANGES"]),
    comments: Schema.Array(ReviewComment),
    commitId: Schema.NullOr(Schema.String),
  }),
);
const encodeStored = Schema.encodeSync(StoredReview);
const decodeStored = Schema.decodeUnknownOption(StoredReview);
const PullAnswer = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  head: Schema.Struct({
    sha: Schema.String,
    ref: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({ ref: Schema.String }),
});
const decodePullAnswer = Schema.decodeUnknownOption(PullAnswer);
const BACKFILL_PAGE = 100;
const decodeOpenPulls = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      number: Schema.Int,
      title: Schema.String,
      html_url: Schema.String,
      draft: Schema.optional(Schema.Boolean),
      created_at: Schema.String,
      user: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
      head: Schema.Struct({
        sha: Schema.String,
        ref: Schema.String,
        repo: Schema.optional(Schema.NullOr(Schema.Struct({ full_name: Schema.String }))),
      }),
    }),
  ),
);
const RepoAnswer = Schema.Struct({
  private: Schema.Boolean,
  owner: Schema.Struct({ login: Schema.String }),
});
const decodeRepoAnswer = Schema.decodeUnknownOption(RepoAnswer);
const isRepoSlug = Schema.is(RepoSlug);

/**
 * "Private and ours": GitHub says the repo is private and its owner is the account that owns
 * the Kin GitHub App. Anything else, a client's or a public repo, posts only on the owner's Confirm.
 */
const privateAndOurs = (
  repo: { readonly private: boolean; readonly owner: { readonly login: string } },
  appOwner: string | null,
) => repo.private && appOwner !== null && repo.owner.login.toLowerCase() === appOwner.toLowerCase();

const unavailable = (message: string) => new KinChatError({ reason: "unavailable", message });
const notFound = () =>
  new KinChatError({
    reason: "not_found",
    message: "No such repository, issue or PR, or it isn't in a connected repo.",
  });
const CARD_BODY = 1_400;
const DIFF_CAP = 150_000;
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export class KinPullRequestCare extends Context.Service<
  KinPullRequestCare,
  {
    readonly pull: (repo: string, number: number) => Effect.Effect<PullTarget, KinChatError>;
    /** Needs the lead's level gate, which posts the owner's card. */
    readonly review: (
      lead: Lead,
      input: Review,
    ) => Effect.Effect<typeof ReviewResult.Type, KinChatError, KinLevelGate>;
    readonly link: (
      lead: Lead,
      input: typeof LinkInput.Type,
    ) => Effect.Effect<typeof LinkResult.Type, KinChatError>;
    /**
     * Posts a review the owner confirmed on its card, exactly as stored, once: the tap's own
     * work. Nothing to post (not confirmed, or already posted) is no error.
     */
    readonly postConfirmed: (
      orgId: KinOrgId,
      postId: string,
    ) => Effect.Effect<string | undefined, KinChatError>;
    /**
     * Open PRs in the connected repos as GitHub has them now, for PRs no webhook has told Kin of
     * yet; a PR Kin holds as open that GitHub no longer lists is closed. Webhook state is kept.
     */
    readonly backfill: (orgId: KinOrgId) => Effect.Effect<number, KinChatError>;
    /** Closes each open issue linked to entries a merge closed; one failure never stops the rest. */
    readonly closeIssues: (
      orgId: KinOrgId,
      issues: ReadonlyArray<{ readonly repo: string; readonly number: number }>,
    ) => Effect.Effect<void>;
  }
>()("t3/kin/github/PullRequestCare/KinPullRequestCare") {}

const make = Effect.gen(function* () {
  const app = yield* KinGitHubApp;
  const client = yield* HttpClient.HttpClient;
  const scope = yield* KinGithubRepoScope;
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;

  const scoped = (repo: string) => {
    const wanted = repo.trim();
    const match = isRepoSlug(wanted)
      ? scope.repos.find((entry) => entry.toLowerCase() === wanted.toLowerCase())
      : undefined;
    return match === undefined ? Effect.fail(notFound()) : Effect.succeed(match as RepoSlug);
  };
  const tokenFor = (repo: RepoSlug, permissions: KinGitHubPermissionSet) =>
    app.installationToken({ repo, permissions, holder: "server" }).pipe(
      Effect.map((minted) => minted.token),
      Effect.mapError(() => unavailable("GitHub refused Kin's access to this repository.")),
    );
  const call = (
    token: Redacted.Redacted<string>,
    operation: string,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ) =>
    gitHubAnswer({
      client,
      operation,
      method,
      path,
      token,
      timeout: "30 seconds",
      ...(body === undefined ? {} : { body }),
    }).pipe(Effect.mapError(() => unavailable("GitHub didn't answer. Try again shortly.")));

  let appOwner: string | null | undefined;
  const ours = Effect.fn("KinPullRequestCare.ours")(function* (repo: RepoSlug) {
    if (appOwner === undefined)
      appOwner = yield* app.app.pipe(
        Effect.map((info) => info.owner?.login ?? null),
        Effect.orElseSucceed(() => null),
      );
    const token = yield* tokenFor(repo, { metadata: "read" });
    const answer = yield* call(token, "repos.get", "GET", repoPath(repo));
    const about = answer.status === 200 ? decodeRepoAnswer(answer.body) : Option.none();
    return Option.isSome(about) && privateAndOurs(about.value, appOwner ?? null);
  });

  const pull = Effect.fn("KinPullRequestCare.pull")(function* (named: string, number: number) {
    const repo = yield* scoped(named);
    const token = yield* tokenFor(repo, { pull_requests: "read" });
    const answer = yield* call(token, "pulls.get", "GET", `${repoPath(repo)}/pulls/${number}`);
    if (answer.status === 404) return yield* notFound();
    const found = answer.status === 200 ? decodePullAnswer(answer.body) : Option.none();
    if (Option.isNone(found)) return yield* unavailable("GitHub couldn't be read right now.");
    const { head, base, title } = found.value;
    const diff = yield* client
      .execute(
        gitHubRequest("GET", `${repoPath(repo)}/pulls/${number}`, token).pipe(
          HttpClientRequest.setHeader("accept", "application/vnd.github.diff"),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.status === 200 ? response.text : Effect.succeed(""),
        ),
        Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.succeed("") }),
        Effect.orElseSucceed(() => ""),
      );
    return {
      repo,
      number,
      title,
      headSha: head.sha,
      headRef: head.ref,
      baseRef: base.ref,
      sameRepo: head.repo?.full_name.toLowerCase() === repo.toLowerCase(),
      diff:
        diff.length <= DIFF_CAP
          ? diff
          : `${diff.slice(0, DIFF_CAP)}\n…[diff cut at ${DIFF_CAP} characters; read the rest in the worktree]`,
    } satisfies PullTarget;
  });

  /** Posts a review; inline comments GitHub can't place are folded into the body and sent again. */
  const post = Effect.fn("KinPullRequestCare.post")(function* (
    repo: RepoSlug,
    number: number,
    review: typeof StoredReview.Type,
  ) {
    const token = yield* tokenFor(repo, { pull_requests: "write" });
    const send = (body: string, comments: ReadonlyArray<typeof ReviewComment.Type>) =>
      call(token, "pulls.createReview", "POST", `${repoPath(repo)}/pulls/${number}/reviews`, {
        body,
        event: review.event,
        ...(review.commitId === null ? {} : { commit_id: review.commitId }),
        comments: comments.map((comment) => ({ ...comment, side: "RIGHT" })),
      });
    let answer = yield* send(review.body, review.comments);
    if (answer.status === 422 && review.comments.length > 0)
      answer = yield* send(
        [
          review.body,
          ...review.comments.map(
            (comment) => `**${comment.path}:${comment.line}**\n${comment.body}`,
          ),
        ].join("\n\n"),
        [],
      );
    const url =
      answer.status === 200 && typeof answer.body === "object" && answer.body !== null
        ? Reflect.get(answer.body, "html_url")
        : undefined;
    if (typeof url !== "string")
      return yield* unavailable(`GitHub didn't post the review (HTTP ${answer.status}).`);
    return url;
  });

  const postConfirmed: KinPullRequestCare["Service"]["postConfirmed"] = Effect.fn(
    "KinPullRequestCare.postConfirmed",
  )(function* (orgId, postId) {
    // Claimed by the move to posted, so a tap and the agent's call never both post it.
    const [claimed] = yield* sql<{ repo: string; number: number; json: string }>`UPDATE
        kin_pr_review_posts SET state = 'posted'
      WHERE org_id = ${orgId} AND post_id = ${postId} AND state = 'confirmed'
      RETURNING repo, number, review_json AS json`.pipe(Effect.orDie);
    if (claimed === undefined) return undefined;
    const release = sql`UPDATE kin_pr_review_posts SET state = 'confirmed'
      WHERE org_id = ${orgId} AND post_id = ${postId} AND url IS NULL`.pipe(Effect.orDie);
    const stored = Option.getOrUndefined(decodeStored(claimed.json));
    if (stored === undefined) {
      yield* release;
      return yield* unavailable("That proposal can't be read.");
    }
    const repo = yield* Effect.tapError(scoped(claimed.repo), () => release);
    const url = yield* Effect.tapError(post(repo, claimed.number, stored), () => release);
    yield* sql`UPDATE kin_pr_review_posts SET url = ${url}
      WHERE org_id = ${orgId} AND post_id = ${postId}`.pipe(Effect.orDie);
    return url;
  });

  const backfill: KinPullRequestCare["Service"]["backfill"] = Effect.fn(
    "KinPullRequestCare.backfill",
  )(function* (orgId) {
    const now = yield* Clock.currentTimeMillis;
    let found = 0;
    for (const repo of scope.repos) {
      if (!isRepoSlug(repo)) continue;
      const token = yield* tokenFor(repo, { pull_requests: "read" });
      const answer = yield* call(
        token,
        "pulls.list",
        "GET",
        `${repoPath(repo)}/pulls?state=open&per_page=${BACKFILL_PAGE}`,
      );
      const pulls = answer.status === 200 ? decodeOpenPulls(answer.body) : Option.none();
      if (Option.isNone(pulls)) continue;
      const slug = repo.toLowerCase();
      for (const pull of pulls.value) {
        const opened = Date.parse(pull.created_at);
        yield* sql`INSERT INTO kin_pull_requests (org_id, repo, number, title, author, url, draft,
            state, head_sha, head_ref, head_repo, opened_at, updated_at)
          VALUES (${orgId}, ${slug}, ${pull.number}, ${pull.title}, ${pull.user?.login ?? null},
            ${pull.html_url}, ${pull.draft === true ? 1 : 0}, 'open', ${pull.head.sha},
            ${pull.head.ref}, ${pull.head.repo?.full_name ?? null},
            ${Number.isFinite(opened) ? opened : now}, ${now})
          ON CONFLICT (org_id, repo, number) DO NOTHING`.pipe(Effect.orDie);
      }
      found += pulls.value.length;
      // A full list says which ones closed while no webhook reached Kin.
      if (pulls.value.length < BACKFILL_PAGE)
        yield* sql`UPDATE kin_pull_requests SET state = 'closed', ready_at = NULL,
            updated_at = ${now}
          WHERE org_id = ${orgId} AND repo = ${slug} AND state = 'open'
            AND number NOT IN ${sql.in(pulls.value.length === 0 ? [0] : pulls.value.map((pull) => pull.number))}`.pipe(
          Effect.orDie,
        );
    }
    return found;
  });

  const review: KinPullRequestCare["Service"]["review"] = Effect.fn("KinPullRequestCare.review")(
    function* (lead, input) {
      if (
        (yield* effectiveAudience(lead).pipe(Effect.provideService(SqlClient.SqlClient, sql))) !==
        "owner_only"
      )
        return yield* new KinChatError({ reason: "not_allowed", message: SHARED_GITHUB });
      const repo = yield* scoped(input.repo);
      if (input.proposal !== undefined) {
        const [row] = yield* sql<{ state: string; json: string; url: string | null }>`SELECT
            state, review_json AS json, url FROM kin_pr_review_posts
          WHERE org_id = ${lead.orgId} AND post_id = ${input.proposal}
            AND agent_id = ${lead.agentId} ORDER BY post_id`.pipe(Effect.orDie);
        if (row === undefined) return yield* notFound();
        if (row.state === "posted")
          return {
            status: "posted",
            url: row.url ?? "",
            next: "The owner's tap posted it; it is on the PR.",
          } as const;
        if (row.state === "declined")
          return {
            status: "declined",
            next: "The owner chose not to post it. Don't post it another way.",
          } as const;
        if (row.state === "open")
          return {
            status: "waiting",
            proposal: input.proposal,
            next: "The owner hasn't confirmed yet. Their tap wakes you; call again then.",
          } as const;
        yield* scoped(repo);
        const url = yield* postConfirmed(lead.orgId, input.proposal);
        return {
          status: "posted",
          url: url ?? "",
          next: "Posted. Say so in one line.",
        } as const;
      }
      if (input.body === undefined)
        return yield* new KinChatError({
          reason: "invalid_state",
          message: "A review needs a body, or a proposal to post.",
        });
      const target = yield* pull(repo, input.number);
      const stored = {
        body: input.body,
        event: input.event ?? "COMMENT",
        comments: input.comments ?? [],
        commitId: target.headSha,
      } as const;
      if (yield* ours(repo)) {
        const url = yield* post(repo, input.number, stored);
        return {
          status: "posted",
          url,
          next: "Posted on the PR: the repo is private and the company's. Say so in one line.",
        } as const;
      }
      const json = encodeStored(stored);
      const postId = `rv_${NodeCrypto.createHash("sha256")
        .update(`${lead.orgId}:${lead.agentId}:${repo}#${input.number}:${json}`)
        .digest("hex")
        .slice(0, 16)}`;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO kin_pr_review_posts (org_id, post_id, agent_id, repo, number,
          review_json, state, proposed_at)
        VALUES (${lead.orgId}, ${postId}, ${lead.agentId}, ${repo}, ${input.number}, ${json},
          'open', ${now})
        ON CONFLICT DO NOTHING`.pipe(Effect.orDie);
      const chat = yield* turnChat(lead).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orDie,
      );
      if (chat === undefined)
        return yield* unavailable("This turn has no chat to ask the owner in.");
      const notes = stored.comments.length;
      yield* askOwner(
        lead,
        {
          chatId: chat.chatId,
          clientMessageId: `kin-pr-review:${postId}`,
          question: `Post this review on ${repo}#${input.number}?`,
          detail: [
            `${target.title}`,
            `${stored.event === "REQUEST_CHANGES" ? "Requests changes" : "Comments"}${notes === 0 ? "" : `, with ${notes} line ${notes === 1 ? "comment" : "comments"}`}.`,
            clip(stored.body, CARD_BODY),
          ].join("\n"),
          yes: "Post it",
          no: "Don't post",
        },
        (widgetId) =>
          sql`UPDATE kin_pr_review_posts SET widget_id = ${widgetId}
            WHERE org_id = ${lead.orgId} AND post_id = ${postId} AND widget_id IS NULL`,
      ).pipe(Effect.mapError((error) => unavailable(error.message)));
      return {
        status: "proposed",
        proposal: postId,
        next: "Nothing is posted yet: this repo is public or not the company's. The owner sees it on a card; ask in one line to check it and tap Post it. Their tap posts exactly this review; you need not call again.",
      } as const;
    },
    Effect.provideService(SqlClient.SqlClient, sql),
  );

  const link: KinPullRequestCare["Service"]["link"] = Effect.fn("KinPullRequestCare.link")(
    function* (lead, input) {
      const item = parseGithubItem(input.url);
      if (item === undefined)
        return yield* new KinChatError({
          reason: "invalid_state",
          message: "That isn't a GitHub issue or pull request URL.",
        });
      const repo = yield* scoped(item.repo);
      const url = `https://github.com/${repo}/${item.kind === "issue" ? "issues" : "pull"}/${item.number}`;
      const [entry] = yield* sql<{ recordId: string; key: string }>`SELECT record_id AS "recordId",
          key FROM kin_records WHERE org_id = ${lead.orgId} AND key = ${input.entry}
        ORDER BY record_id`.pipe(Effect.orDie);
      if (entry === undefined)
        return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
      const writer = yield* writerFor(lead).pipe(Effect.orDie);
      yield* records.link(lead.orgId, writer, entry.recordId, {
        kind: item.kind === "issue" ? "url" : "pull_request",
        target: url,
        relation: "relates",
        label: item.kind === "issue" ? `Issue #${item.number}` : `PR #${item.number}`,
      });
      return { entry: entry.key, linked: url };
    },
    Effect.provideService(SqlClient.SqlClient, sql),
  );

  const closeIssue = Effect.fn("KinPullRequestCare.closeIssue")(
    function* (orgId: KinOrgId, issue: { readonly repo: string; readonly number: number }) {
      const repo = yield* scoped(issue.repo);
      const token = yield* tokenFor(repo, { issues: "write" });
      const answer = yield* call(
        token,
        "issues.update",
        "PATCH",
        `${repoPath(repo)}/issues/${issue.number}`,
        { state: "closed", state_reason: "completed" },
      );
      if (answer.status !== 200)
        yield* Effect.logWarning("Kin couldn't close an issue after its PR merged", {
          orgId,
          repo,
          number: issue.number,
          status: answer.status,
        });
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin issue close failed", { cause })),
  );
  const closeIssues: KinPullRequestCare["Service"]["closeIssues"] = (orgId, issues) =>
    Effect.forEach(issues, (issue) => closeIssue(orgId, issue), { discard: true });

  return KinPullRequestCare.of({ pull, review, postConfirmed, backfill, link, closeIssues });
});

export const layer = Layer.effect(KinPullRequestCare, make);

const off = () => Effect.fail(unavailable(NOT_CONNECTED));
const closeNothing: KinPullRequestCare["Service"]["closeIssues"] = Effect.fn(
  "KinPullRequestCare.closeNothing",
)(function* () {});
/** Without the Kin App: every call answers that GitHub isn't connected, and closing does nothing. */
export const notConnectedLayer = Layer.succeed(
  KinPullRequestCare,
  KinPullRequestCare.of({
    pull: off,
    review: off,
    postConfirmed: off,
    backfill: Effect.fn("KinPullRequestCare.noBackfill")(() => Effect.succeed(0)),
    link: off,
    closeIssues: closeNothing,
  }),
);

/**
 * An answer on a review card, in the tap's transaction, from the owner, a co-owner or the lead
 * of a project on that repo: Post it marks the proposal confirmed and returns it, for the tap to
 * post exactly what was stored once it commits. Any other card isn't ours.
 */
export const answerReviewCard = Effect.fn("KinPullRequestCare.answerCard")(function* (input: {
  readonly orgId: KinOrgId;
  readonly widgetId: string;
  readonly personId: string;
  readonly confirmed: boolean;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const coOwner = yield* ownerLevel(input.orgId, KinPersonId.make(input.personId));
  const [row] = yield* sql<{ postId: string; state: string; allowed: number }>`SELECT
      p.post_id AS "postId", p.state,
      (a.owner_person_id = ${input.personId} OR ${coOwner ? 1 : 0} = 1
        OR EXISTS (SELECT 1 FROM kin_records pr WHERE pr.org_id = p.org_id
          AND pr.register_id = 'projects' AND pr.state = 'open' AND pr.owner_kind = 'person'
          AND pr.owner_id = ${input.personId}
          AND EXISTS (SELECT 1 FROM json_each(pr.fields_json, '$.repos') r
            WHERE lower(r.value) = lower(p.repo)))) AS allowed
    FROM kin_pr_review_posts p
    JOIN kin_agents a ON a.org_id = p.org_id AND a.agent_id = p.agent_id
    WHERE p.org_id = ${input.orgId} AND p.widget_id = ${input.widgetId} ORDER BY p.post_id`;
  if (row === undefined || row.state !== "open" || row.allowed !== 1) return undefined;
  yield* sql`UPDATE kin_pr_review_posts
    SET state = ${input.confirmed ? "confirmed" : "declined"}, decided_at = ${input.now}
    WHERE org_id = ${input.orgId} AND post_id = ${row.postId} AND state = 'open'`;
  return input.confirmed ? row.postId : undefined;
});

const POST_TRIES = 3;

/**
 * PR care's own work on the shared scheduler: once per start, open PRs no webhook has reported
 * yet; and every tick, a review someone confirmed on its card is posted, exactly as stored.
 */
export const runtimeLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const care = yield* KinPullRequestCare;
    const ticks = yield* Scheduler.Scheduler;
    const sql = yield* SqlClient.SqlClient;
    const filled = new Set<string>();
    const tries = new Map<string, number>();
    yield* ticks.register(
      "kin-pr-care",
      Effect.gen(function* () {
        // Scheduler maintenance scans organizations; every call below is org-scoped.
        const orgs = yield* sql<{ orgId: string }>`SELECT org_id AS "orgId" FROM kin_orgs
          ORDER BY org_id`;
        for (const { orgId } of orgs) {
          if (filled.has(orgId)) continue;
          filled.add(orgId);
          yield* care
            .backfill(KinOrgId.make(orgId))
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Kin couldn't read open pull requests", { orgId, cause }),
              ),
            );
        }
        // Scheduler maintenance: confirmed reviews in every org, each posted in its own org.
        const confirmed = yield* sql<{ orgId: string; postId: string }>`SELECT org_id AS "orgId",
            post_id AS "postId" FROM kin_pr_review_posts WHERE state = 'confirmed'
          ORDER BY decided_at, post_id LIMIT 20`;
        for (const { orgId, postId } of confirmed) {
          const tried = tries.get(postId) ?? 0;
          // A review GitHub keeps refusing waits for the agent's own call, not every tick.
          if (tried >= POST_TRIES) continue;
          tries.set(postId, tried + 1);
          yield* care
            .postConfirmed(KinOrgId.make(orgId), postId)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Kin couldn't post a confirmed review", { postId, cause }),
              ),
            );
        }
      }).pipe(Effect.catch((cause) => Effect.logWarning("Kin PR care tick failed", { cause }))),
    );
  }),
);

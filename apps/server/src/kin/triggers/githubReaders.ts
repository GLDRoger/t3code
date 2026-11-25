import { type KinOrgId, RepoSlug } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type ApiAnswer, ghApiLayer, KinGitHubApi } from "../github/GitHubWatch.ts";
import {
  type GithubLinkState,
  KinDeferralGithubError,
  KinDeferralGithubReader,
  type KinDeferralGithubReaderShape,
} from "./deferralGithub.ts";
import {
  KinRoutineGithubReader,
  type KinRoutineGithubReaderShape,
  type KinRoutineGithubState,
} from "../lead/RoutineContent.ts";
import {
  type GithubItemState,
  KinWatchdogGithubError,
  KinWatchdogGithubReader,
  type KinWatchdogGithubReaderShape,
  watchedRepos,
} from "./watchdogs.ts";

const ITEMS_PER_QUERY = 50;
// `state` is aliased on pull requests: GraphQL refuses one name with two enum types.
const ITEM_FRAGMENT = `fragment KinItem on IssueOrPullRequest {
  __typename
  ... on Issue {
    number state
    assignees(first: 50) { pageInfo { hasNextPage } nodes { login } }
    closedByPullRequestsReferences(first: 50, includeClosedPrs: true) {
      pageInfo { hasNextPage } nodes { number repository { nameWithOwner } }
    }
  }
  ... on PullRequest {
    number pullState: state
    assignees(first: 50) { pageInfo { hasNextPage } nodes { login } }
    reviewRequests(first: 20) {
      pageInfo { hasNextPage } nodes { requestedReviewer { ... on User { login } } }
    }
    timelineItems(last: 50, itemTypes: [REVIEW_REQUESTED_EVENT]) {
      pageInfo { hasPreviousPage }
      nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } } }
    }
  }
}`;
const isItemNumber = (number: number) => Number.isSafeInteger(number) && number > 0;
// Only positive safe integers reach the aliases, so they can't carry anything else into the query.
export const itemsQuery = (numbers: ReadonlyArray<number>) =>
  `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${numbers
    .map((number) => `i${number}: issueOrPullRequest(number: ${number}) { ...KinItem }`)
    .join(" ")} } }\n${ITEM_FRAGMENT}`;

const NextPage = Schema.Struct({ hasNextPage: Schema.Boolean });
const Logins = Schema.Struct({
  pageInfo: NextPage,
  nodes: Schema.Array(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
});
const Reviewer = Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) }));
const RoutineReviewer = Schema.NullOr(
  Schema.Struct({
    login: Schema.optional(Schema.String),
    slug: Schema.optional(Schema.String),
  }),
);
const Issue = Schema.Struct({
  __typename: Schema.Literal("Issue"),
  number: Schema.Int,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  assignees: Logins,
  closedByPullRequestsReferences: Schema.Struct({
    pageInfo: NextPage,
    nodes: Schema.Array(
      Schema.NullOr(
        Schema.Struct({
          number: Schema.Int,
          repository: Schema.Struct({ nameWithOwner: Schema.String }),
        }),
      ),
    ),
  }),
});
const Pull = Schema.Struct({
  __typename: Schema.Literal("PullRequest"),
  number: Schema.Int,
  pullState: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  assignees: Logins,
  reviewRequests: Schema.Struct({
    pageInfo: NextPage,
    nodes: Schema.Array(Schema.NullOr(Schema.Struct({ requestedReviewer: Reviewer }))),
  }),
  timelineItems: Schema.Struct({
    pageInfo: Schema.Struct({ hasPreviousPage: Schema.Boolean }),
    nodes: Schema.Array(
      Schema.NullOr(
        Schema.Struct({
          createdAt: Schema.optional(Schema.String),
          requestedReviewer: Schema.optional(Reviewer),
        }),
      ),
    ),
  }),
});
const Item = Schema.Union([Issue, Pull]);
type Item = typeof Item.Type;
const GraphQlAnswer = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(Item))),
      }),
    ),
  ),
  errors: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String) }))),
});
const decodeAnswer = Schema.decodeUnknownOption(GraphQlAnswer);

export const ROUTINE_QUERY = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
  defaultBranchRef { name target { ... on Commit { statusCheckRollup { state } } } }
  pullRequests(states: [OPEN], first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
    pageInfo { hasNextPage }
    nodes { number title url isDraft reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } } }
  }
} }`;
const RoutineAnswer = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            defaultBranchRef: Schema.NullOr(
              Schema.Struct({
                name: Schema.String,
                target: Schema.NullOr(
                  Schema.Struct({
                    statusCheckRollup: Schema.optional(
                      Schema.NullOr(Schema.Struct({ state: Schema.String })),
                    ),
                  }),
                ),
              }),
            ),
            pullRequests: Schema.Struct({
              pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
              nodes: Schema.Array(
                Schema.NullOr(
                  Schema.Struct({
                    number: Schema.Int,
                    title: Schema.String,
                    url: Schema.String,
                    isDraft: Schema.Boolean,
                    reviewRequests: Schema.Struct({
                      nodes: Schema.Array(
                        Schema.NullOr(Schema.Struct({ requestedReviewer: RoutineReviewer })),
                      ),
                    }),
                  }),
                ),
              ),
            }),
          }),
        ),
      }),
    ),
  ),
  errors: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String) }))),
});
const decodeRoutineAnswer = Schema.decodeUnknownOption(RoutineAnswer);
const isRepoSlug = Schema.is(RepoSlug);

class KinGithubReadFailed extends Schema.TaggedError<KinGithubReadFailed>()("KinGithubReadFailed", {
  repo: Schema.String,
  reason: Schema.Literals(["rate_limited", "unavailable"]),
}) {}

const lowerState = (item: Item): GithubItemState["state"] => {
  const state = item.__typename === "Issue" ? item.state : item.pullState;
  return state === "OPEN" ? "open" : state === "MERGED" ? "merged" : "closed";
};

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Pending user review requests, each dated by its latest request event; undated ones are left out. */
function reviewRequestsOf(pull: typeof Pull.Type): GithubItemState["reviewRequests"] {
  const requestedAt = new Map<string, number>();
  for (const event of pull.timelineItems.nodes) {
    const login = event?.requestedReviewer?.login?.toLowerCase();
    const at = Date.parse(event?.createdAt ?? "");
    if (login !== undefined && Number.isFinite(at)) requestedAt.set(login, at);
  }
  return pull.reviewRequests.nodes.flatMap((request) => {
    const login = request?.requestedReviewer?.login;
    const at = login === undefined ? undefined : requestedAt.get(login.toLowerCase());
    return login === undefined || at === undefined ? [] : [{ login, requestedAt: at }];
  });
}

const isRateLimit = (
  answer: ApiAnswer,
  errors: ReadonlyArray<{ readonly type?: string | undefined }>,
) =>
  answer.status === 429 ||
  (answer.status === 403 &&
    (answer.headers["x-ratelimit-remaining"] === "0" ||
      answer.headers["retry-after"] !== undefined)) ||
  errors.some((error) => error.type === "RATE_LIMITED");

const make = Effect.gen(function* () {
  const api = yield* KinGitHubApi;
  const sql = yield* SqlClient.SqlClient;

  /** One GraphQL read as the owner; a read without his login answers status 0, so unavailable. */
  const graphql = Effect.fn("KinGithubReaders.graphql")(function* (repo: string, query: string) {
    const [owner, name] = repo.split("/");
    return yield* api.call({
      method: "POST",
      path: "graphql",
      body: { query, variables: { owner, name } },
    });
  });

  /** Read-only: the items GitHub knows among `numbers`, keyed by number. Never retried here. */
  const fetchItems = Effect.fn("KinGithubReaders.fetch")(function* (
    repo: string,
    numbers: ReadonlyArray<number>,
  ) {
    if (!isRepoSlug(repo)) return yield* new KinGithubReadFailed({ repo, reason: "unavailable" });
    const wanted = [...new Set(numbers.filter(isItemNumber))];
    const items = new Map<number, Item>();
    for (let start = 0; start < wanted.length; start += ITEMS_PER_QUERY) {
      const answer = yield* graphql(repo, itemsQuery(wanted.slice(start, start + ITEMS_PER_QUERY)));
      const body = decodeAnswer(answer.body);
      const errors = Option.isSome(body) ? (body.value.errors ?? []) : [];
      if (isRateLimit(answer, errors)) {
        yield* Effect.logWarning("Kin GitHub read rate-limited; skipping the repo for now", {
          repo,
        });
        return yield* new KinGithubReadFailed({ repo, reason: "rate_limited" });
      }
      const repository = Option.isSome(body) ? body.value.data?.repository : undefined;
      // NOT_FOUND only for numbers GitHub doesn't have; those come back null and are left out.
      if (
        answer.status !== 200 ||
        repository === undefined ||
        repository === null ||
        errors.some((error) => error.type !== "NOT_FOUND")
      )
        return yield* new KinGithubReadFailed({ repo, reason: "unavailable" });
      for (const item of Object.values(repository)) if (item !== null) items.set(item.number, item);
    }
    return items;
  });

  const deferral: KinDeferralGithubReaderShape = {
    readRepo: Effect.fn("KinGithubReaders.deferral")(
      function* (_orgId: KinOrgId, repo: string, numbers: ReadonlyArray<number>) {
        const states = new Map<number, Omit<GithubLinkState, "link">>();
        for (const item of (yield* fetchItems(repo, numbers)).values()) {
          const linked = item.__typename === "Issue" ? item.closedByPullRequestsReferences : null;
          if (item.assignees.pageInfo.hasNextPage || linked?.pageInfo.hasNextPage) continue;
          states.set(item.number, {
            state: lowerState(item),
            assignees: item.assignees.nodes.flatMap((node) => (node === null ? [] : [node.login])),
            linkedPrs: (linked?.nodes ?? []).flatMap((node) =>
              node === null || !sameRepo(node.repository.nameWithOwner, repo) ? [] : [node.number],
            ),
          });
        }
        return states;
      },
      (effect, orgId) =>
        effect.pipe(
          Effect.mapError(() => new KinDeferralGithubError({ orgId, reason: "unavailable" })),
        ),
    ),
  };

  const watchdog: KinWatchdogGithubReaderShape = {
    readRepo: Effect.fn("KinGithubReaders.watchdog")(
      function* (_orgId: KinOrgId, repo: string, numbers: ReadonlyArray<number>) {
        const items = yield* fetchItems(repo, numbers);
        return numbers.flatMap((number): ReadonlyArray<GithubItemState> => {
          const item = items.get(number);
          if (
            item === undefined ||
            (item.__typename === "PullRequest" &&
              (item.reviewRequests.pageInfo.hasNextPage ||
                item.timelineItems.pageInfo.hasPreviousPage))
          )
            return [];
          const kind = item.__typename === "Issue" ? "issue" : "pull";
          return [
            {
              number,
              kind,
              state: lowerState(item),
              reviewRequests: item.__typename === "PullRequest" ? reviewRequestsOf(item) : [],
            },
          ];
        });
      },
      (effect, orgId, repo) =>
        effect.pipe(
          Effect.mapError(() => new KinWatchdogGithubError({ orgId, repo, reason: "unavailable" })),
        ),
    ),
  };

  const readRoutineRepo = Effect.fn("KinGithubReaders.routineRepo")(function* (
    repo: string,
    login: string | null,
    includeTeams: boolean,
  ) {
    if (!isRepoSlug(repo)) return yield* new KinGithubReadFailed({ repo, reason: "unavailable" });
    const answer = yield* graphql(repo, ROUTINE_QUERY);
    const body = decodeRoutineAnswer(answer.body);
    const errors = Option.isSome(body) ? (body.value.errors ?? []) : [];
    if (isRateLimit(answer, errors))
      return yield* new KinGithubReadFailed({ repo, reason: "rate_limited" });
    const repository = Option.isSome(body) ? body.value.data?.repository : undefined;
    if (answer.status !== 200 || repository == null || errors.length > 0)
      return yield* new KinGithubReadFailed({ repo, reason: "unavailable" });
    const state = repository.defaultBranchRef?.target?.statusCheckRollup?.state;
    const branch = repository.defaultBranchRef?.name;
    return {
      truncated: repository.pullRequests.pageInfo.hasNextPage,
      reviews: repository.pullRequests.nodes.flatMap((pull) => {
        if (pull === null || pull.isDraft) return [];
        const reviewers = pull.reviewRequests.nodes.map((request) => request?.requestedReviewer);
        const direct =
          login !== null &&
          reviewers.some((reviewer) => reviewer?.login?.toLowerCase() === login.toLowerCase());
        const teams = includeTeams
          ? [...new Set(reviewers.flatMap((reviewer) => (reviewer?.slug ? [reviewer.slug] : [])))]
          : [];
        return direct || teams.length > 0
          ? [
              {
                repo,
                number: pull.number,
                title: pull.title,
                url: pull.url,
                ...(teams.length === 0 ? {} : { teams }),
              },
            ]
          : [];
      }),
      ciRed:
        branch !== undefined && (state === "FAILURE" || state === "ERROR")
          ? [{ repo, branch }]
          : [],
    };
  });

  const routine: KinRoutineGithubReaderShape = {
    read: Effect.fn("KinGithubReaders.routine")(function* (orgId: KinOrgId, login: string | null) {
      const reviews: Array<KinRoutineGithubState["reviews"][number]> = [];
      const ciRed: Array<KinRoutineGithubState["ciRed"][number]> = [];
      let failed = 0;
      let truncated = 0;
      const repos = yield* watchedRepos(orgId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const [watch] = yield* sql<{ login: string | null }>`SELECT login
        FROM kin_github_watch WHERE org_id = ${orgId}`.pipe(Effect.orElseSucceed(() => []));
      const includeTeams = login !== null && watch?.login?.toLowerCase() === login.toLowerCase();
      for (const repo of repos) {
        const result = yield* readRoutineRepo(repo, login, includeTeams).pipe(Effect.result);
        if (result._tag === "Failure") {
          failed++;
          yield* Effect.logWarning("Kin routine GitHub read failed", {
            orgId,
            repo,
            reason: result.failure.reason,
          });
          continue;
        }
        if (result.success.truncated) truncated++;
        reviews.push(...result.success.reviews);
        ciRed.push(...result.success.ciRed);
      }
      return {
        reviews,
        ciRed,
        failedRepos: failed,
        truncatedRepos: truncated,
        repos: repos.length,
      };
    }),
  };

  return Context.make(KinDeferralGithubReader, deferral).pipe(
    Context.add(KinWatchdogGithubReader, watchdog),
    Context.add(KinRoutineGithubReader, routine),
  );
});

/** The deferral, watchdog and routine readers, as the owner through his GitHub login. */
export const readersLayer = Layer.effectContext(make);
export const layer = readersLayer.pipe(Layer.provide(ghApiLayer));

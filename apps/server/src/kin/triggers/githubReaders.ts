import { type KinOrgId, RepoSlug } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/http";

import { gitHubAnswer, isGitHubRateLimit } from "../github/githubRest.ts";
import * as Keychain from "../github/Keychain.ts";
import * as KinGitHubApp from "../github/KinGitHubApp.ts";
import type { KinGitHubPermissionSet } from "../github/KinGitHubPermissions.ts";
import { KinGitHubScope } from "../github/KinGitHubScope.ts";
import {
  type GithubLinkState,
  KinDeferralGithubError,
  KinDeferralGithubReader,
  type KinDeferralGithubReaderShape,
} from "./deferralGithub.ts";
import { inRepoScope, KinGithubRepoScope, repoScopeLayer } from "./githubEvents.ts";
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
} from "./watchdogs.ts";

const ITEMS_PER_QUERY = 50;
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
const READ_PERMISSIONS = {
  issues: "read",
  pull_requests: "read",
} as const satisfies KinGitHubPermissionSet;

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

const ROUTINE_PERMISSIONS = {
  contents: "read",
  pull_requests: "read",
  checks: "read",
  statuses: "read",
} as const satisfies KinGitHubPermissionSet;
export const ROUTINE_QUERY = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
  defaultBranchRef { name target { ... on Commit { statusCheckRollup { state } } } }
  pullRequests(states: [OPEN], first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
    pageInfo { hasNextPage }
    nodes { number title url isDraft reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } } }
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
                        Schema.NullOr(Schema.Struct({ requestedReviewer: Reviewer })),
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
  reason: Schema.Literals(["out_of_scope", "token", "rate_limited", "unavailable"]),
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

const make = Effect.gen(function* () {
  const app = yield* KinGitHubApp.KinGitHubApp;
  const client = yield* HttpClient.HttpClient;
  const scope = yield* KinGithubRepoScope;
  const tokens = new Map<
    string,
    { readonly token: Redacted.Redacted<string>; readonly expiresAt: number }
  >();

  /** One read-only `server` token per repo and permission set, reused until shortly before expiry. */
  const tokenFor = Effect.fn("KinGithubReaders.token")(function* (
    repo: RepoSlug,
    permissions: KinGitHubPermissionSet = READ_PERMISSIONS,
  ) {
    const key = `${permissions === READ_PERMISSIONS ? "items" : "routine"}:${repo.toLowerCase()}`;
    const now = yield* Clock.currentTimeMillis;
    const cached = tokens.get(key);
    if (cached !== undefined && now < cached.expiresAt - TOKEN_REUSE_MARGIN_MS) return cached.token;
    tokens.delete(key);
    const minted = yield* app.installationToken({ repo, permissions, holder: "server" }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Kin GitHub read token refused", { repo, errorTag: error._tag }),
      ),
      Effect.mapError(() => new KinGithubReadFailed({ repo, reason: "token" })),
    );
    const expiresAt = Date.parse(minted.expiresAt);
    if (Number.isFinite(expiresAt)) tokens.set(key, { token: minted.token, expiresAt });
    return minted.token;
  });

  /** Read-only: the items GitHub knows among `numbers`, keyed by number. Never retried here. */
  const fetchItems = Effect.fn("KinGithubReaders.fetch")(function* (
    repo: string,
    numbers: ReadonlyArray<number>,
  ) {
    if (!isRepoSlug(repo) || !inRepoScope(scope.repos, repo))
      return yield* new KinGithubReadFailed({ repo, reason: "out_of_scope" });
    const wanted = [...new Set(numbers.filter(isItemNumber))];
    const items = new Map<number, Item>();
    if (wanted.length === 0) return items;
    const token = yield* tokenFor(repo);
    const [owner, name] = repo.split("/");
    for (let start = 0; start < wanted.length; start += ITEMS_PER_QUERY) {
      const answer = yield* gitHubAnswer({
        client,
        operation: "graphql.items",
        method: "POST",
        path: "/graphql",
        token,
        body: {
          query: itemsQuery(wanted.slice(start, start + ITEMS_PER_QUERY)),
          variables: { owner, name },
        },
      }).pipe(Effect.mapError(() => new KinGithubReadFailed({ repo, reason: "unavailable" })));
      if (
        answer.status === 401 ||
        (answer.status === 403 && answer.message === "Resource not accessible by integration")
      )
        tokens.delete(`items:${repo.toLowerCase()}`);
      const body = decodeAnswer(answer.body);
      const errors = Option.isSome(body) ? (body.value.errors ?? []) : [];
      if (isGitHubRateLimit(answer) || errors.some((error) => error.type === "RATE_LIMITED")) {
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

  /** Of the 50 latest-updated open PRs, those awaiting `login` directly (not via a team); plus CI. */
  const readRoutineRepo = Effect.fn("KinGithubReaders.routineRepo")(function* (
    repo: string,
    login: string | null,
  ) {
    if (!isRepoSlug(repo) || !inRepoScope(scope.repos, repo))
      return yield* new KinGithubReadFailed({ repo, reason: "out_of_scope" });
    const token = yield* tokenFor(repo, ROUTINE_PERMISSIONS);
    const [owner, name] = repo.split("/");
    const answer = yield* gitHubAnswer({
      client,
      operation: "graphql.routine",
      method: "POST",
      path: "/graphql",
      token,
      body: { query: ROUTINE_QUERY, variables: { owner, name } },
    }).pipe(Effect.mapError(() => new KinGithubReadFailed({ repo, reason: "unavailable" })));
    if (answer.status === 401 || answer.status === 403)
      tokens.delete(`routine:${repo.toLowerCase()}`);
    const body = decodeRoutineAnswer(answer.body);
    const errors = Option.isSome(body) ? (body.value.errors ?? []) : [];
    if (isGitHubRateLimit(answer) || errors.some((error) => error.type === "RATE_LIMITED"))
      return yield* new KinGithubReadFailed({ repo, reason: "rate_limited" });
    const repository = Option.isSome(body) ? body.value.data?.repository : undefined;
    if (answer.status !== 200 || repository == null || errors.length > 0)
      return yield* new KinGithubReadFailed({ repo, reason: "unavailable" });
    const state = repository.defaultBranchRef?.target?.statusCheckRollup?.state;
    const branch = repository.defaultBranchRef?.name;
    return {
      truncated: repository.pullRequests.pageInfo.hasNextPage,
      reviews: repository.pullRequests.nodes.flatMap((pull) =>
        pull === null ||
        pull.isDraft ||
        login === null ||
        !pull.reviewRequests.nodes.some(
          (request) =>
            (request?.requestedReviewer?.login ?? "").toLowerCase() === login.toLowerCase(),
        )
          ? []
          : [{ repo, number: pull.number, title: pull.title, url: pull.url }],
      ),
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
      for (const repo of scope.repos) {
        const result = yield* readRoutineRepo(repo, login).pipe(Effect.result);
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
        repos: scope.repos.length,
      };
    }),
  };

  return Context.make(KinDeferralGithubReader, deferral).pipe(
    Context.add(KinWatchdogGithubReader, watchdog),
    Context.add(KinRoutineGithubReader, routine),
  );
});

/** The deferral, watchdog and routine readers over `KinGitHubApp`; needs the App id and its key in the keychain. */
export const readersLayer = Layer.effectContext(make);

const decodeSecrets = Schema.decodeUnknownOption(
  Schema.fromJsonString(KinGitHubApp.KinGitHubAppSecrets),
);

/** The Kin App with its id, key check, scope and HTTP client; fails when the key is missing. */
export const appLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { appId } = yield* KinGitHubApp.KinGitHubAppConfig;
    const keychain = yield* Keychain.KinKeychain;
    const stored = yield* keychain.get("kin-github-app", appId);
    if (Option.isNone(Option.flatMap(stored, (value) => decodeSecrets(Redacted.value(value)))))
      return yield* new KinGitHubApp.KinGitHubAppNotConfiguredError({ appId });
  }),
).pipe(
  Layer.provideMerge(KinGitHubApp.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      KinGitHubApp.KinGitHubAppConfig.layer,
      KinGitHubScope.layer,
      FetchHttpClient.layer,
      Keychain.layer,
    ),
  ),
);

/**
 * The real readers when the Kin App is configured. Otherwise, or if the App can't be built, one
 * warning and the fail-closed defaults (deferrals ask, GitHub watchdogs wait).
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const appId = yield* Config.option(Config.String("KIN_GITHUB_APP_ID"));
    if (Option.isNone(appId)) {
      yield* Effect.logWarning(
        "Kin GitHub reads are off: KIN_GITHUB_APP_ID is unset, so deferrals ask and GitHub watchdogs wait",
      );
      return Layer.empty;
    }
    return readersLayer.pipe(
      Layer.provide(Layer.mergeAll(appLayer, repoScopeLayer)),
      Layer.catchCause((cause) =>
        Layer.effectDiscard(
          Effect.logWarning(
            "Kin GitHub reads are off: the Kin GitHub App is unavailable, so deferrals ask and GitHub watchdogs wait",
            Cause.pretty(cause),
          ),
        ),
      ),
    );
  }),
);

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

  /** One read-only `server` token per repo, reused until shortly before GitHub expires it. */
  const tokenFor = Effect.fn("KinGithubReaders.token")(function* (repo: RepoSlug) {
    const key = repo.toLowerCase();
    const now = yield* Clock.currentTimeMillis;
    const cached = tokens.get(key);
    if (cached !== undefined && now < cached.expiresAt - TOKEN_REUSE_MARGIN_MS) return cached.token;
    tokens.delete(key);
    const minted = yield* app
      .installationToken({ repo, permissions: READ_PERMISSIONS, holder: "server" })
      .pipe(
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
        tokens.delete(repo.toLowerCase());
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

  return Context.make(KinDeferralGithubReader, deferral).pipe(
    Context.add(KinWatchdogGithubReader, watchdog),
  );
});

/** Both readers over `KinGitHubApp`; needs the App id and its key in the keychain. */
export const readersLayer = Layer.effectContext(make);

const decodeSecrets = Schema.decodeUnknownOption(
  Schema.fromJsonString(KinGitHubApp.KinGitHubAppSecrets),
);

const appLayer = Layer.effectDiscard(
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

import { type KinOrgId, RepoSlug } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/http";

import { gitHubAnswer, isGitHubRateLimit } from "../github/githubRest.ts";
import * as Keychain from "../github/Keychain.ts";
import * as KinGitHubApp from "../github/KinGitHubApp.ts";
import type { KinGitHubPermissionSet } from "../github/KinGitHubPermissions.ts";
import { KinGitHubScope } from "../github/KinGitHubScope.ts";
import {
  type GithubRef,
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

// The deferral read runs under the org memory lock, so it gets far less than a watchdog sweep.
const DEFERRAL_READ_TIMEOUT = "10 seconds";
const WATCHDOG_READ_TIMEOUT = "30 seconds";
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
    assignees(first: 50) { nodes { login } }
    closedByPullRequestsReferences(first: 50, includeClosedPrs: true) { nodes { number } }
  }
  ... on PullRequest {
    number pullState: state
    assignees(first: 50) { nodes { login } }
    reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
    timelineItems(last: 50, itemTypes: [REVIEW_REQUESTED_EVENT]) {
      nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } } }
    }
  }
}`;
// Numbers are positive safe integers, so the aliases can't carry anything else into the query.
export const itemsQuery = (numbers: ReadonlyArray<number>) =>
  `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${numbers
    .map((number) => `i${number}: issueOrPullRequest(number: ${number}) { ...KinItem }`)
    .join(" ")} } }\n${ITEM_FRAGMENT}`;

const Logins = Schema.Struct({
  nodes: Schema.Array(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
});
const Reviewer = Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) }));
const Issue = Schema.Struct({
  __typename: Schema.Literal("Issue"),
  number: Schema.Int,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  assignees: Logins,
  closedByPullRequestsReferences: Schema.Struct({
    nodes: Schema.Array(Schema.NullOr(Schema.Struct({ number: Schema.Int }))),
  }),
});
const Pull = Schema.Struct({
  __typename: Schema.Literal("PullRequest"),
  number: Schema.Int,
  pullState: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  assignees: Logins,
  reviewRequests: Schema.Struct({
    nodes: Schema.Array(Schema.NullOr(Schema.Struct({ requestedReviewer: Reviewer }))),
  }),
  timelineItems: Schema.Struct({
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
  reason: Schema.Literals(["out_of_scope", "token", "rate_limited", "unavailable", "timeout"]),
}) {}

const lowerState = (item: Item): GithubItemState["state"] => {
  const state = item.__typename === "Issue" ? item.state : item.pullState;
  return state === "OPEN" ? "open" : state === "MERGED" ? "merged" : "closed";
};

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
    const token = yield* tokenFor(repo);
    const [owner, name] = repo.split("/");
    const items = new Map<number, Item>();
    for (let start = 0; start < numbers.length; start += ITEMS_PER_QUERY) {
      const answer = yield* gitHubAnswer({
        client,
        operation: "graphql.items",
        method: "POST",
        path: "/graphql",
        token,
        body: {
          query: itemsQuery(numbers.slice(start, start + ITEMS_PER_QUERY)),
          variables: { owner, name },
        },
      }).pipe(Effect.mapError(() => new KinGithubReadFailed({ repo, reason: "unavailable" })));
      if (answer.status === 401) tokens.delete(repo.toLowerCase());
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
    read: Effect.fn("KinGithubReaders.deferral")(
      function* (_orgId: KinOrgId, ref: GithubRef) {
        const item = (yield* fetchItems(ref.repo, [ref.number])).get(ref.number);
        if (item === undefined) return Option.none();
        return Option.some({
          state: lowerState(item),
          assignees: item.assignees.nodes.flatMap((node) => (node === null ? [] : [node.login])),
          linkedPrs:
            item.__typename === "Issue"
              ? item.closedByPullRequestsReferences.nodes.flatMap((node) =>
                  node === null ? [] : [node.number],
                )
              : [],
        });
      },
      (effect, orgId, ref) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: DEFERRAL_READ_TIMEOUT,
            orElse: () =>
              Effect.fail(new KinGithubReadFailed({ repo: ref.repo, reason: "timeout" })),
          }),
          Effect.mapError(() => new KinDeferralGithubError({ orgId, reason: "unavailable" })),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new KinDeferralGithubError({ orgId, reason: "not_found" })),
              onSome: Effect.succeed,
            }),
          ),
        ),
    ),
  };

  const watchdog: KinWatchdogGithubReaderShape = {
    readRepo: Effect.fn("KinGithubReaders.watchdog")(
      function* (_orgId: KinOrgId, repo: string, numbers: ReadonlyArray<number>) {
        const items = yield* fetchItems(repo, numbers);
        return numbers.flatMap((number): ReadonlyArray<GithubItemState> => {
          const item = items.get(number);
          if (item === undefined) return [];
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
          Effect.timeoutOrElse({
            duration: WATCHDOG_READ_TIMEOUT,
            orElse: () => Effect.fail(new KinGithubReadFailed({ repo, reason: "timeout" })),
          }),
          Effect.mapError(
            (failure) =>
              new KinWatchdogGithubError({
                orgId,
                repo,
                reason: failure.reason === "timeout" ? "timeout" : "unavailable",
              }),
          ),
        ),
    ),
  };

  return Context.make(KinDeferralGithubReader, deferral).pipe(
    Context.add(KinWatchdogGithubReader, watchdog),
  );
});

/** Both readers over `KinGitHubApp`; needs the App id and its key in the keychain. */
export const readersLayer = Layer.effectContext(make);

const appLayer = (appId: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const keychain = yield* Keychain.KinKeychain;
      if (Option.isNone(yield* keychain.get("kin-github-app", appId)))
        return yield* new KinGitHubApp.KinGitHubAppNotConfiguredError({ appId });
    }),
  ).pipe(
    Layer.provideMerge(KinGitHubApp.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(KinGitHubApp.KinGitHubAppConfig, { appId }),
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
      Layer.provide(Layer.mergeAll(appLayer(appId.value), repoScopeLayer)),
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

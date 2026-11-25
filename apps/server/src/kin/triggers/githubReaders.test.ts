// @effect-diagnostics nodeBuiltinImport:off -- reads GitHub's vendored GraphQL schema.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { buildSchema, parse, validate } from "graphql";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { ghApiOutput, ghApiStderr } from "../github/fakeGitHub.ts";
import { type ApiRequest, KinGitHubApi, parseGhApi } from "../github/GitHubWatch.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { KinDeferralGithubReader, readGithubLinks, readGithubLinkSets } from "./deferralGithub.ts";
import * as RoutineContent from "../lead/RoutineContent.ts";
import * as GithubReaders from "./githubReaders.ts";
import { KinWatchdogGithubReader } from "./watchdogs.ts";

const orgId = KinOrgId.make("org-1");
const REPO = "GLDRoger/t3code";
const NOW = Date.UTC(2026, 10, 8, 12);

const more = { pageInfo: { hasNextPage: false } };
const pr = (number: number, repo = REPO) => ({ number, repository: { nameWithOwner: repo } });
const closedIssue = {
  __typename: "Issue",
  number: 7,
  state: "CLOSED",
  assignees: { ...more, nodes: [{ login: "zoe" }, { login: "amir" }] },
  closedByPullRequestsReferences: {
    ...more,
    nodes: [pr(12), pr(9), pr(30, "someone/fork"), pr(31, REPO.toLowerCase())],
  },
};
const mergedPr = {
  __typename: "PullRequest",
  number: 9,
  pullState: "MERGED",
  assignees: { ...more, nodes: [] },
  reviewRequests: { ...more, nodes: [] },
  timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: [] },
};
const openPr = {
  __typename: "PullRequest",
  number: 11,
  pullState: "OPEN",
  assignees: { ...more, nodes: [{ login: "amir" }] },
  reviewRequests: {
    ...more,
    nodes: [{ requestedReviewer: { login: "Zoe" } }, { requestedReviewer: {} }],
  },
  timelineItems: {
    pageInfo: { hasPreviousPage: false },
    nodes: [
      { createdAt: "2026-11-01T00:00:00Z", requestedReviewer: { login: "zoe" } },
      { createdAt: "2026-11-05T00:00:00Z", requestedReviewer: { login: "zoe" } },
    ],
  },
};
const truncated = { pageInfo: { hasNextPage: true } };
const fixtures = new Map<number, unknown>([
  [7, closedIssue],
  [9, mergedPr],
  [11, openPr],
  [20, { ...closedIssue, number: 20, assignees: { ...closedIssue.assignees, ...truncated } }],
  [
    21,
    {
      ...closedIssue,
      number: 21,
      closedByPullRequestsReferences: {
        ...closedIssue.closedByPullRequestsReferences,
        ...truncated,
      },
    },
  ],
  [22, { ...openPr, number: 22, reviewRequests: { ...openPr.reviewRequests, ...truncated } }],
  [
    23,
    {
      ...openPr,
      number: 23,
      timelineItems: { ...openPr.timelineItems, pageInfo: { hasPreviousPage: true } },
    },
  ],
]);

interface FakeAnswer {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** GraphQL answers from `fixtures`; numbers it lacks come back null with NOT_FOUND, as GitHub does. */
const graphql = (request: ApiRequest): FakeAnswer => {
  const body = request.body;
  const query =
    typeof body === "object" && body !== null && "query" in body && typeof body.query === "string"
      ? body.query
      : "";
  const numbers = [...query.matchAll(/\bi(\d+): issueOrPullRequest/g)].map((m) => Number(m[1]));
  return {
    status: 200,
    body: {
      data: {
        repository: Object.fromEntries(numbers.map((n) => [`i${n}`, fixtures.get(n) ?? null])),
      },
      errors: numbers
        .filter((n) => !fixtures.has(n))
        .map((n) => ({ type: "NOT_FOUND", path: ["repository", `i${n}`] })),
    },
  };
};

const database = KinPersistence.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

/** The owner's watch covers `REPO`, as the poller would have stored it. */
const watching = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_github_watch (org_id, login, started_at, since_at, next_at, repos_json)
    VALUES (${orgId}, 'owner', 0, 0, 0, ${JSON.stringify([{ repo: REPO, fork: false }])})`;
});

/** GitHub as the owner's `gh` login, answering from `route`; `hang` never answers. */
const setup = (route: (request: ApiRequest) => FakeAnswer = graphql, hang = false) => {
  const requests: Array<ApiRequest> = [];
  const api = Layer.succeed(
    KinGitHubApi,
    KinGitHubApi.of({
      connected: () => Effect.succeed({ login: "owner", orgs: [] }),
      call: (request) =>
        hang
          ? Effect.never
          : Effect.sync(() => {
              requests.push(request);
              const routed = route(request);
              const answer = { ...routed, headers: routed.headers ?? {} };
              // As gh prints it: the body, then its error line on stderr, run together.
              return parseGhApi(ghApiOutput(answer) + ghApiStderr(request.path, answer));
            }),
    }),
  );
  const layer = GithubReaders.readersLayer.pipe(
    Layer.provideMerge(api),
    Layer.provideMerge(database),
  );
  return { requests, layer };
};

const readers = Effect.gen(function* () {
  const watchdog = yield* KinWatchdogGithubReader;
  assert.isNotNull(watchdog);
  return { deferral: yield* KinDeferralGithubReader, watchdog: watchdog! };
});

describe("Kin GitHub readers", () => {
  it("asks GitHub a query its schema accepts", () => {
    const schema = buildSchema(
      NodeFS.readFileSync(
        new URL(
          "../../../../../packages/source-control-github/schema/github.graphql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.deepStrictEqual(
      validate(schema, parse(GithubReaders.itemsQuery([7, 9]))).map((error) => error.message),
      [],
    );
    assert.deepStrictEqual(
      validate(schema, parse(GithubReaders.ROUTINE_QUERY)).map((error) => error.message),
      [],
    );
  });

  it.effect("reads a merged PR and a closed issue with one batched query as the owner", () => {
    const { requests, layer } = setup();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { watchdog } = yield* readers;
      const states = yield* watchdog.readRepo(orgId, REPO, [7, 9, 11, 404]);
      assert.deepStrictEqual(states, [
        { number: 7, kind: "issue", state: "closed", reviewRequests: [] },
        { number: 9, kind: "pull", state: "merged", reviewRequests: [] },
        {
          number: 11,
          kind: "pull",
          state: "open",
          reviewRequests: [{ login: "Zoe", requestedAt: Date.parse("2026-11-05T00:00:00Z") }],
        },
      ]);
      assert.deepStrictEqual(
        yield* readGithubLinks(orgId, ["https://github.com/GLDRoger/t3code/issues/7"]),
        [
          {
            link: "https://github.com/GLDRoger/t3code/issues/7",
            state: "closed",
            assignees: ["amir", "zoe"],
            linkedPrs: [9, 12, 31],
          },
        ],
      );
      assert.isNull(yield* readGithubLinks(orgId, ["GLDRoger/t3code#404"]));
      // A list GitHub cut short fails the item rather than reporting part of it.
      assert.deepStrictEqual(
        yield* readGithubLinkSets(orgId, [
          ["GLDRoger/t3code#20"],
          ["GLDRoger/t3code#21"],
          ["GLDRoger/t3code#22"],
        ]),
        [
          null,
          null,
          [{ link: "GLDRoger/t3code#22", state: "open", assignees: ["amir"], linkedPrs: [] }],
        ],
      );
      assert.deepStrictEqual(
        (yield* watchdog.readRepo(orgId, REPO, [20, 22, 23])).map(({ number }) => number),
        [20],
      );

      assert.deepStrictEqual(
        requests.map(({ method, path }) => `${method} ${path}`),
        Array.from({ length: 5 }, () => "POST graphql"),
      );
      assert.deepInclude(requests[0]?.body, { variables: { owner: "GLDRoger", name: "t3code" } });
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads PRs awaiting the owner's review and a red default branch for the brief", () => {
    const pull = (number: number, login: string, isDraft = false) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/${REPO}/pull/${number}`,
      isDraft,
      reviewRequests: { nodes: [{ requestedReviewer: { login } }, { requestedReviewer: {} }] },
    });
    const { layer } = setup(() => ({
      status: 200,
      body: {
        data: {
          repository: {
            defaultBranchRef: { name: "main", target: { statusCheckRollup: { state: "FAILURE" } } },
            pullRequests: {
              pageInfo: { hasNextPage: true },
              nodes: [
                pull(4, "Owner"),
                pull(5, "someone"),
                pull(6, "owner", true),
                {
                  ...pull(7, "someone"),
                  reviewRequests: {
                    nodes: [{ requestedReviewer: { slug: "invented-reviewers" } }],
                  },
                },
              ],
            },
          },
        },
      },
    }));
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* watching;
      const reader = yield* RoutineContent.KinRoutineGithubReader;
      assert.isNotNull(reader);
      assert.deepStrictEqual(yield* reader!.read(orgId, "owner"), {
        reviews: [
          { repo: REPO, number: 4, title: "PR 4", url: `https://github.com/${REPO}/pull/4` },
          {
            repo: REPO,
            number: 7,
            title: "PR 7",
            url: `https://github.com/${REPO}/pull/7`,
            teams: ["invented-reviewers"],
          },
        ],
        ciRed: [{ repo: REPO, branch: "main" }],
        failedRepos: 0,
        truncatedRepos: 1,
        repos: 1,
      });
      assert.deepStrictEqual((yield* reader!.read(orgId, "teammate")).reviews, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("counts an unreadable repo instead of failing the brief", () => {
    const { layer } = setup(() => ({ status: 502, body: {} }));
    return Effect.gen(function* () {
      yield* watching;
      const reader = yield* RoutineContent.KinRoutineGithubReader;
      assert.deepInclude(yield* reader!.read(orgId, "owner"), { failedRepos: 1, reviews: [] });
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    {
      name: "HTTP 403 with no remaining quota",
      answer: {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
        body: { message: "API rate limit exceeded" },
      },
    },
    {
      name: "GraphQL RATE_LIMITED",
      answer: { status: 200, body: { data: null, errors: [{ type: "RATE_LIMITED" }] } },
    },
    {
      name: "GraphQL RATE_LIMITED with gh's error line after the body",
      answer: {
        status: 200,
        body: {
          data: null,
          errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1." }],
        },
      },
    },
  ] satisfies ReadonlyArray<{ name: string; answer: FakeAnswer }>)(
    "counts a rate limit ($name) as a failed repo, once",
    ({ answer }) => {
      const { requests, layer } = setup(() => answer);
      return Effect.gen(function* () {
        const { deferral, watchdog } = yield* readers;
        assert.equal(
          (yield* watchdog.readRepo(orgId, REPO, [7, 9]).pipe(Effect.flip)).reason,
          "unavailable",
        );
        assert.equal(
          (yield* deferral.readRepo(orgId, REPO, [7]).pipe(Effect.flip)).reason,
          "unavailable",
        );
        assert.lengthOf(requests, 2);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("gives every deferral link one shared budget", () => {
    const { layer } = setup(graphql, true);
    return Effect.gen(function* () {
      const read = yield* readGithubLinkSets(orgId, [
        ["GLDRoger/t3code#7"],
        ["GLDRoger/t3code#9", "https://example.com/not-github"],
      ]).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      assert.deepStrictEqual(yield* Fiber.join(read), [null, null]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads nothing without the owner's GitHub login: deferrals ask", () => {
    const { layer } = setup(() => ({ status: 0, body: null }));
    return Effect.gen(function* () {
      const { deferral } = yield* readers;
      assert.equal(
        (yield* deferral.readRepo(orgId, REPO, [7]).pipe(Effect.flip)).reason,
        "unavailable",
      );
    }).pipe(Effect.provide(layer));
  });
});

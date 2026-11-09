// @effect-diagnostics nodeBuiltinImport:off -- reads GitHub's vendored GraphQL schema.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";
import { buildSchema, parse, validate } from "graphql";

import * as KinGitHubApp from "../github/KinGitHubApp.ts";
import { fakeGitHub, type FakeAnswer, type RecordedRequest } from "../github/testFakes.ts";
import { KinDeferralGithubReader, readGithubLinks } from "./deferralGithub.ts";
import { KinGithubRepoScope } from "./githubEvents.ts";
import * as GithubReaders from "./githubReaders.ts";
import { KinWatchdogGithubReader } from "./watchdogs.ts";

const orgId = KinOrgId.make("org-1");
const REPO = "GLDRoger/t3code";
const TOKEN = "ghs_reader_token_never_shown";
const NOW = Date.UTC(2026, 10, 8, 12);

const closedIssue = {
  __typename: "Issue",
  number: 7,
  state: "CLOSED",
  assignees: { nodes: [{ login: "zoe" }, { login: "amir" }] },
  closedByPullRequestsReferences: { nodes: [{ number: 12 }, { number: 9 }] },
};
const mergedPr = {
  __typename: "PullRequest",
  number: 9,
  pullState: "MERGED",
  assignees: { nodes: [] },
  reviewRequests: { nodes: [] },
  timelineItems: { nodes: [] },
};
const openPr = {
  __typename: "PullRequest",
  number: 11,
  pullState: "OPEN",
  assignees: { nodes: [{ login: "amir" }] },
  reviewRequests: {
    nodes: [{ requestedReviewer: { login: "Zoe" } }, { requestedReviewer: {} }],
  },
  timelineItems: {
    nodes: [
      { createdAt: "2026-11-01T00:00:00Z", requestedReviewer: { login: "zoe" } },
      { createdAt: "2026-11-05T00:00:00Z", requestedReviewer: { login: "zoe" } },
    ],
  },
};
const fixtures = new Map<number, unknown>([
  [7, closedIssue],
  [9, mergedPr],
  [11, openPr],
]);

/** GraphQL answers from `fixtures`; numbers it lacks come back null with NOT_FOUND, as GitHub does. */
const graphql = (request: RecordedRequest): FakeAnswer => {
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

const setup = (
  route: (request: RecordedRequest) => FakeAnswer = graphql,
  client?: Layer.Layer<HttpClient.HttpClient>,
) => {
  const mints: Array<Parameters<KinGitHubApp.KinGitHubApp["Service"]["installationToken"]>[0]> = [];
  const github = fakeGitHub(route);
  const app = Layer.succeed(
    KinGitHubApp.KinGitHubApp,
    KinGitHubApp.KinGitHubApp.of({
      app: Effect.die("unused"),
      installations: Effect.die("unused"),
      installationToken: (input) => {
        mints.push(input);
        return Effect.succeed({
          token: Redacted.make(TOKEN),
          repo: input.repo,
          expiresAt: "2026-11-08T13:00:00Z",
          permissions: { ...input.permissions, metadata: "read" },
        });
      },
    }),
  );
  const layer = GithubReaders.readersLayer.pipe(
    Layer.provide(app),
    Layer.provide(client ?? github.layer),
    Layer.provide(Layer.succeed(KinGithubRepoScope, { repos: [REPO] })),
  );
  return { mints, requests: github.requests, layer };
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
  });

  it.effect("reads a merged PR and a closed issue with one batched query and one token", () => {
    const { mints, requests, layer } = setup();
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
            linkedPrs: [9, 12],
          },
        ],
      );
      assert.isNull(yield* readGithubLinks(orgId, ["GLDRoger/t3code#404"]));

      assert.deepStrictEqual(
        requests.map(({ method, path }) => `${method} ${path}`),
        ["POST /graphql", "POST /graphql", "POST /graphql"],
      );
      assert.equal(requests[0]?.authorization, `Bearer ${TOKEN}`);
      assert.deepInclude(requests[0]?.body, { variables: { owner: "GLDRoger", name: "t3code" } });
      assert.deepStrictEqual(mints, [
        { repo: REPO, permissions: { issues: "read", pull_requests: "read" }, holder: "server" },
      ]);
      // Reused until five minutes before it expires, then minted again.
      yield* TestClock.adjust("56 minutes");
      yield* watchdog.readRepo(orgId, REPO, [9]);
      assert.lengthOf(mints, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails closed for a repo outside KIN_GITHUB_REPOS without calling GitHub", () => {
    const { mints, requests, layer } = setup();
    return Effect.gen(function* () {
      const { deferral, watchdog } = yield* readers;
      const read = yield* watchdog.readRepo(orgId, "other/repo", [7]).pipe(Effect.flip);
      assert.equal(read.reason, "unavailable");
      const one = yield* deferral.read(orgId, { repo: "other/repo", number: 7 }).pipe(Effect.flip);
      assert.equal(one.reason, "unavailable");
      assert.lengthOf(requests, 0);
      assert.lengthOf(mints, 0);
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
          (yield* deferral.read(orgId, { repo: REPO, number: 7 }).pipe(Effect.flip)).reason,
          "unavailable",
        );
        assert.lengthOf(requests, 2);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("bounds each read in time", () => {
    const hanging = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.never),
    );
    const { layer } = setup(graphql, hanging);
    return Effect.gen(function* () {
      const { deferral, watchdog } = yield* readers;
      const one = yield* deferral
        .read(orgId, { repo: REPO, number: 7 })
        .pipe(Effect.flip, Effect.forkChild);
      const batch = yield* watchdog.readRepo(orgId, REPO, [7]).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      assert.equal((yield* Fiber.join(one)).reason, "unavailable");
      yield* TestClock.adjust("20 seconds");
      assert.equal((yield* Fiber.join(batch)).reason, "timeout");
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the token out of logs and errors", () => {
    const lines: Array<string> = [];
    const logger = Logger.layer(
      [Logger.make(({ message }) => lines.push(JSON.stringify(message)))],
      { mergeWithExisting: false },
    );
    let call = 0;
    const answers: ReadonlyArray<FakeAnswer> = [
      { status: 401, body: { message: "Bad credentials" } },
      { status: 429, headers: { "retry-after": "60" }, body: { message: "slow down" } },
      { status: 500, body: { message: "boom" } },
    ];
    const { requests, layer } = setup(() => answers[call++ % answers.length]!);
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { deferral, watchdog } = yield* readers;
      const errors = [
        yield* watchdog.readRepo(orgId, REPO, [7]).pipe(Effect.flip),
        yield* watchdog.readRepo(orgId, REPO, [7]).pipe(Effect.flip),
        yield* deferral.read(orgId, { repo: REPO, number: 7 }).pipe(Effect.flip),
      ];
      assert.isTrue(requests.every((request) => request.authorization === `Bearer ${TOKEN}`));
      assert.isNotEmpty(lines);
      for (const text of [
        ...lines,
        ...errors.flatMap((error) => [JSON.stringify(error), String(error), error.message]),
      ])
        assert.notInclude(text, TOKEN);
    }).pipe(
      Effect.provide(Layer.merge(layer, logger)),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
    );
  });

  it.effect.each([
    { name: "no App id", config: {} },
    // A missing KIN_GITHUB_OWNER_LOGIN fails the App's scope, so the keychain is never read.
    { name: "an App that can't be built", config: { KIN_GITHUB_APP_ID: "123456" } },
  ])("keeps the fail-closed defaults with one warning for $name", ({ config }) => {
    const warnings: Array<string> = [];
    const logger = Logger.layer(
      [
        Logger.make(({ message, logLevel }) => {
          if (logLevel === "Warn") warnings.push(String(message));
        }),
      ],
      { mergeWithExisting: false },
    );
    return Effect.gen(function* () {
      assert.isNull(yield* KinWatchdogGithubReader);
      const read = yield* (yield* KinDeferralGithubReader)
        .read(orgId, { repo: REPO, number: 7 })
        .pipe(Effect.flip);
      assert.equal(read.reason, "unavailable");
      assert.lengthOf(
        warnings.filter((warning) => warning.includes("Kin GitHub reads are off")),
        1,
      );
    }).pipe(
      Effect.provide(
        GithubReaders.layer.pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
          Layer.provide(NodeServices.layer),
          Layer.provideMerge(logger),
        ),
      ),
    );
  });
});

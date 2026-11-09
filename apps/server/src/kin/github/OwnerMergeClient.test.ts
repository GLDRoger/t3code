import { assert, it } from "@effect/vitest";
import type { KinOrgId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import * as CredentialHygiene from "../approvals/CredentialHygiene.ts";
import * as OwnerMergeClient from "./OwnerMergeClient.ts";
import {
  fakeGitHub,
  memoryKeychain,
  scopeLayer,
  type FakeAnswer,
  type RecordedRequest,
} from "./testFakes.ts";

const ORG = "org_kin" as KinOrgId;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 8);
const TOKEN = Redacted.make("github_pat_fake_owner_merge_token");
const REPOS = ["GLDRoger/t3code", "GLDRoger/kin-memory"];
const expiration = (at: number) =>
  `${DateTime.formatIso(DateTime.makeUnsafe(at)).slice(0, 19).replace("T", " ")} UTC`;
const inThirtyDays = { "github-authentication-token-expiration": expiration(NOW + 30 * DAY) };

const NOT_ACCESSIBLE: FakeAnswer = {
  status: 403,
  body: { message: "Resource not accessible by personal access token" },
};
const repoBody = (repo: string, type = "Organization") => ({
  full_name: repo,
  owner: { login: repo.split("/")[0], type },
  permissions: { admin: false, push: true, pull: true },
});

/** A token with exactly Contents: write and Metadata: read on REPOS, as GitHub should answer. */
const narrowToken =
  (headers: Record<string, string>) =>
  (request: RecordedRequest): FakeAnswer => {
    if (request.path === "/user") return { status: 200, body: { login: "Nishchay" }, headers };
    if (request.path === "/user/repos?per_page=100") {
      return { status: 200, body: REPOS.map((full_name) => ({ full_name })) };
    }
    if (request.path === "/orgs/GLDRoger/rulesets") return NOT_ACCESSIBLE;
    const repo = REPOS.find((slug) => request.path.startsWith(`/repos/${slug}`));
    if (repo === undefined) return { status: 404 };
    if (request.path === `/repos/${repo}`) return { status: 200, body: repoBody(repo) };
    return NOT_ACCESSIBLE;
  };

const setup = (route: (request: RecordedRequest) => FakeAnswer) => {
  const keychain = memoryKeychain();
  const github = fakeGitHub(route);
  const layer = OwnerMergeClient.layer.pipe(
    Layer.provide(keychain.layer),
    Layer.provide(github.layer),
    Layer.provide(scopeLayer({ repos: REPOS })),
  );
  return { keychain, requests: github.requests, layer };
};

const save = (token = TOKEN, probePr?: number) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const client = yield* OwnerMergeClient.OwnerMergeClient;
    return yield* client.save({ orgId: ORG, token, probePr });
  });

/** A pass from a real hygiene check, which is the only way to get one. */
const pass = CredentialHygiene.CredentialHygiene.use((hygiene) => hygiene.requirePassing(ORG));
const withHygiene = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      CredentialHygiene.layer.pipe(
        Layer.provide(
          Layer.succeed(CredentialHygiene.T3GitHubIdentity, {
            identities: Effect.succeed({
              t3: Option.none(),
              ghAccounts: [],
              gitCredential: Option.none(),
              ssh: ["git@github.com: Permission denied (publickey)."],
            }),
          }),
        ),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        Layer.provide(scopeLayer({ repos: REPOS })),
      ),
    ),
  );

describe("OwnerMergeClient", () => {
  it.effect("probes the token, stores it, and warns in its last 7 days", () => {
    const { keychain, requests, layer } = setup(narrowToken(inThirtyDays));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* save(), { login: "Nishchay", expiresAt: NOW + 30 * DAY });
      assert.isTrue(
        requests.every((request) => request.authorization === `Bearer ${Redacted.value(TOKEN)}`),
      );
      assert.deepStrictEqual(
        requests.map((request) => `${request.method} ${request.path}`),
        [
          "GET /user",
          ...REPOS.flatMap((repo, index) => [
            `GET /repos/${repo}`,
            `GET /repos/${repo}/actions/permissions`,
            `GET /repos/${repo}/hooks`,
            `GET /repos/${repo}/actions/secrets`,
            `POST /repos/${repo}/pulls/1/reviews`,
            // Both repositories belong to one organization, probed once.
            ...(index === 0 ? ["GET /orgs/GLDRoger/rulesets"] : []),
          ]),
          "GET /user/repos?per_page=100",
        ],
      );
      // The review probe's body can't make a review even if the token could.
      assert.deepStrictEqual(requests.find((request) => request.method === "POST")?.body, {
        event: "KIN_PERMISSION_PROBE",
        commit_id: "0000000000000000000000000000000000000000",
      });
      assert.include(keychain.items.get(`kin-owner-merge/${ORG}`), Redacted.value(TOKEN));

      const client = yield* OwnerMergeClient.OwnerMergeClient;
      assert.deepInclude(yield* client.status(ORG), { _tag: "active", expiringSoon: false });
      yield* TestClock.setTime(NOW + 23 * DAY);
      assert.deepInclude(yield* client.status(ORG), { _tag: "active", expiringSoon: true });
      assert.strictEqual(
        Redacted.value(yield* withHygiene(pass.pipe(Effect.flatMap(client.token)))),
        Redacted.value(TOKEN),
      );

      // A pass made just before the token expires doesn't outlive it.
      yield* TestClock.setTime(NOW + 30 * DAY - 30_000);
      const earlier = yield* withHygiene(pass);
      yield* TestClock.setTime(NOW + 30 * DAY);
      assert.deepInclude(yield* client.status(ORG), { _tag: "expired", login: "Nishchay" });
      const error = yield* client.token(earlier).pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "OwnerMergeTokenMissingError", expired: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a stale hygiene pass", () => {
    const { layer } = setup(narrowToken(inThirtyDays));
    return Effect.gen(function* () {
      yield* save();
      const client = yield* OwnerMergeClient.OwnerMergeClient;
      const fresh = yield* withHygiene(pass);
      yield* TestClock.adjust("60 seconds");
      assert.isTrue(Exit.isSuccess(yield* client.token(fresh).pipe(Effect.exit)));
      yield* TestClock.adjust("1 millis");
      // Typed, so the executor ends the action `failed`: nothing was sent.
      assert.deepInclude(yield* client.token(fresh).pipe(Effect.flip), {
        _tag: "OwnerMergePassStaleError",
        ageMs: 60_001,
      });
      assert.throws(() => {
        (fresh.report as { checkedAt: unknown }).checkedAt = NOW + DAY;
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a forged hygiene pass", () => {
    const { layer } = setup(narrowToken(inThirtyDays));
    return Effect.gen(function* () {
      yield* save();
      const client = yield* OwnerMergeClient.OwnerMergeClient;
      const report = (yield* withHygiene(pass)).report;
      const Pass = CredentialHygiene.CredentialHygienePass as any;
      assert.throws(() => new Pass(ORG, report));
      assert.throws(() => new Pass(Symbol("CredentialHygienePass.issue"), ORG, report));
      const forgeries = [
        { orgId: ORG, report },
        Object.create(CredentialHygiene.CredentialHygienePass.prototype),
      ] as Array<CredentialHygiene.CredentialHygienePass>;
      for (const forged of forgeries) {
        assert.isTrue(Exit.hasDies(yield* client.token(forged).pipe(Effect.exit)));
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("probes the PR it's given, and skips the organization probe for a user's repo", () => {
    const { requests, layer } = setup((request) =>
      request.path === "/repos/GLDRoger/t3code" || request.path === "/repos/GLDRoger/kin-memory"
        ? { status: 200, body: repoBody(request.path.slice("/repos/".length), "User") }
        : narrowToken(inThirtyDays)(request),
    );
    return Effect.gen(function* () {
      yield* save(TOKEN, 42);
      const paths = requests.map((request) => request.path);
      assert.include(paths, "/repos/GLDRoger/t3code/pulls/42/reviews");
      assert.isFalse(paths.some((path) => path.startsWith("/orgs/")));
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    ["a classic token", Redacted.make("ghp_classic"), {}, "not_fine_grained"],
    ["no expiry", TOKEN, {}, "no_expiry"],
    [
      "an expiry past 90 days",
      TOKEN,
      { "github-authentication-token-expiration": expiration(NOW + 120 * DAY) },
      "lifetime_too_long",
    ],
    [
      "an expired token",
      TOKEN,
      { "github-authentication-token-expiration": "2026-11-01 00:00:00 +0000" },
      "expired",
    ],
  ] as const)("refuses %s and stores nothing", ([, token, headers, reason]) => {
    const { keychain, layer } = setup(narrowToken(headers));
    return Effect.gen(function* () {
      const error = yield* save(token).pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "OwnerMergeTokenRefusedError", reason });
      assert.notInclude(error.message, Redacted.value(token));
      assert.strictEqual(keychain.items.size, 0);
    }).pipe(Effect.provide(layer));
  });

  const answering =
    (path: string, answer: FakeAnswer) =>
    (request: RecordedRequest): FakeAnswer =>
      request.path === path ? answer : narrowToken(inThirtyDays)(request);

  it.effect.each([
    [
      "another person's token",
      answering("/user", { status: 200, body: { login: "Mallory" }, headers: inThirtyDays }),
      "wrong_owner",
      "Mallory",
    ],
    [
      "a token that can't read a scoped repository",
      answering("/repos/GLDRoger/kin-memory", { status: 404 }),
      "repo_unreachable",
      "GLDRoger/kin-memory: HTTP 404",
    ],
    [
      "a token that can't push",
      answering("/repos/GLDRoger/t3code", {
        status: 200,
        body: { ...repoBody("GLDRoger/t3code"), permissions: { push: false } },
      }),
      "cannot_push",
      "GLDRoger/t3code",
    ],
    [
      "a token with Administration",
      answering("/repos/GLDRoger/t3code/actions/permissions", { status: 200, body: {} }),
      "too_broad",
      "Administration on GLDRoger/t3code: HTTP 200",
    ],
    [
      "a token with Webhooks",
      answering("/repos/GLDRoger/kin-memory/hooks", { status: 200, body: [] }),
      "too_broad",
      "Webhooks on GLDRoger/kin-memory: HTTP 200",
    ],
    [
      "a token with Secrets",
      answering("/repos/GLDRoger/t3code/actions/secrets", { status: 200, body: {} }),
      "too_broad",
      "Secrets on GLDRoger/t3code: HTTP 200",
    ],
    [
      "a token with organization Administration",
      answering("/orgs/GLDRoger/rulesets", { status: 200, body: [] }),
      "too_broad",
      "Organization administration on GLDRoger: HTTP 200",
    ],
    [
      "a token that can review",
      answering("/repos/GLDRoger/t3code/pulls/1/reviews", { status: 422 }),
      "too_broad",
      "Pull requests on GLDRoger/t3code (PR #1): HTTP 422",
    ],
    [
      "a 403 that isn't GitHub's missing-permission answer",
      answering("/repos/GLDRoger/t3code/hooks", {
        status: 403,
        body: { message: "Must have admin rights to Repository." },
      }),
      "too_broad",
      "Webhooks on GLDRoger/t3code: HTTP 403",
    ],
    [
      "a review probe on a PR GitHub can't find",
      answering("/repos/GLDRoger/t3code/pulls/1/reviews", { status: 404 }),
      "probe_inconclusive",
      "Pull requests on GLDRoger/t3code (PR #1): HTTP 404",
    ],
    [
      "a broad token behind a rate-limit 403",
      answering("/repos/GLDRoger/t3code/hooks", {
        ...NOT_ACCESSIBLE,
        headers: { "x-ratelimit-remaining": "0" },
      }),
      "rate_limited",
      "Webhooks on GLDRoger/t3code: HTTP 403",
    ],
    [
      "a broad token behind a secondary rate limit",
      answering("/repos/GLDRoger/t3code/actions/permissions", {
        status: 403,
        body: { message: "You have exceeded a secondary rate limit." },
        headers: { "retry-after": "60" },
      }),
      "rate_limited",
      "Administration on GLDRoger/t3code: HTTP 403",
    ],
    [
      "a secondary rate limit with no rate-limit headers",
      answering("/repos/GLDRoger/t3code/hooks", {
        status: 403,
        body: { message: "You have exceeded a secondary rate limit." },
      }),
      "rate_limited",
      "Webhooks on GLDRoger/t3code: HTTP 403",
    ],
    [
      "a 429",
      answering("/repos/GLDRoger/t3code/actions/secrets", { status: 429 }),
      "rate_limited",
      "Secrets on GLDRoger/t3code: HTTP 429",
    ],
    [
      "a probe GitHub can't answer",
      answering("/repos/GLDRoger/t3code/hooks", { status: 500 }),
      "too_broad",
      "Webhooks on GLDRoger/t3code: HTTP 500",
    ],
    [
      "a token on other repositories",
      answering("/user/repos?per_page=100", {
        status: 200,
        body: [...REPOS, "Nishchay/dotfiles"].map((full_name) => ({ full_name })),
      }),
      "other_repos",
      "1",
    ],
  ] as const)("refuses %s and stores nothing", ([, route, reason, detail]) => {
    const { keychain, layer } = setup(route);
    return Effect.gen(function* () {
      const error = yield* save().pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "OwnerMergeTokenRefusedError", reason, detail });
      assert.notInclude(error.message, Redacted.value(TOKEN));
      assert.strictEqual(keychain.items.size, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to save while the repository list is empty", () => {
    const keychain = memoryKeychain();
    const layer = OwnerMergeClient.layer.pipe(
      Layer.provide(keychain.layer),
      Layer.provide(fakeGitHub(narrowToken(inThirtyDays)).layer),
      Layer.provide(scopeLayer({ repos: [] })),
    );
    return Effect.gen(function* () {
      const error = yield* save().pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "OwnerMergeTokenRefusedError", reason: "no_repos" });
      assert.strictEqual(keychain.items.size, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes only to the Kin repositories, with the exact SHA", () => {
    const { requests, layer } = setup(narrowToken(inThirtyDays));
    return Effect.gen(function* () {
      yield* save();
      const client = yield* OwnerMergeClient.OwnerMergeClient;
      const fresh = yield* withHygiene(pass);
      const before = requests.length;
      for (const answer of [
        yield* client.merge(fresh, {
          repo: "someone/else",
          number: 1,
          sha: "a".repeat(40),
          mergeMethod: "squash",
        }),
        yield* client.deleteBranch(fresh, { repo: "someone/else", branch: "main" }),
      ]) {
        assert.deepInclude(answer, { _tag: "refused", reason: "denied" });
      }
      assert.strictEqual(requests.length, before);
      yield* client.merge(fresh, {
        repo: REPOS[0]!,
        number: 7,
        sha: "a".repeat(40),
        mergeMethod: "merge",
      });
      assert.deepInclude(requests.at(-1), {
        method: "PUT",
        path: `/repos/${REPOS[0]}/pulls/7/merge`,
        authorization: `Bearer ${Redacted.value(TOKEN)}`,
        body: { sha: "a".repeat(40), merge_method: "merge" },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a missing token", () => {
    const { layer } = setup(narrowToken({}));
    return Effect.gen(function* () {
      const client = yield* OwnerMergeClient.OwnerMergeClient;
      assert.deepStrictEqual(yield* client.status(ORG), { _tag: "missing" });
    }).pipe(Effect.provide(layer));
  });
});

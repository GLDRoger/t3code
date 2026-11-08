import { assert, it } from "@effect/vitest";
import type { KinOrgId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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

/** A token with exactly Contents: write and Metadata: read on REPOS, as GitHub should answer. */
const narrowToken =
  (headers: Record<string, string>) =>
  (request: RecordedRequest): FakeAnswer => {
    if (request.path === "/user") return { status: 200, body: { login: "Nishchay" }, headers };
    if (request.path === "/user/repos?per_page=100") {
      return { status: 200, body: REPOS.map((full_name) => ({ full_name })) };
    }
    const repo = REPOS.find((slug) => request.path.startsWith(`/repos/${slug}`));
    if (repo === undefined) return { status: 404 };
    if (request.path === `/repos/${repo}`) return { status: 200, body: { full_name: repo } };
    return { status: 403, body: { message: "Resource not accessible by personal access token" } };
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

const save = (token = TOKEN) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const client = yield* OwnerMergeClient.OwnerMergeClient;
    return yield* client.save({ orgId: ORG, token });
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
          ...REPOS.flatMap((repo) => [
            `GET /repos/${repo}`,
            `GET /repos/${repo}/actions/permissions`,
            `GET /repos/${repo}/hooks`,
            `POST /repos/${repo}/pulls/1/reviews`,
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

      // A pass from an earlier check doesn't outlive the token.
      const earlier = yield* withHygiene(pass);
      yield* TestClock.setTime(NOW + 30 * DAY);
      assert.deepInclude(yield* client.status(ORG), { _tag: "expired", login: "Nishchay" });
      const error = yield* client.token(earlier).pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "OwnerMergeTokenMissingError", expired: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a forged hygiene pass", () => {
    const { layer } = setup(narrowToken(inThirtyDays));
    return Effect.gen(function* () {
      yield* save();
      const client = yield* OwnerMergeClient.OwnerMergeClient;
      const forged = { orgId: ORG } as unknown as CredentialHygiene.CredentialHygienePass;
      const exit = yield* client.token(forged).pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
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
      "a token that can review",
      answering("/repos/GLDRoger/t3code/pulls/1/reviews", { status: 422 }),
      "too_broad",
      "Pull requests on GLDRoger/t3code: HTTP 422",
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

  it.effect("reports a missing token", () => {
    const { layer } = setup(narrowToken({}));
    return Effect.gen(function* () {
      const client = yield* OwnerMergeClient.OwnerMergeClient;
      assert.deepStrictEqual(yield* client.status(ORG), { _tag: "missing" });
    }).pipe(Effect.provide(layer));
  });
});

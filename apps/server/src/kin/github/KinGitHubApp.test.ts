// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's crypto has no RSA key generation or verify.
import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import type { RepoSlug } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import * as GithubWebhooks from "../triggers/githubWebhooks.ts";
import * as AppHookClient from "./appHookClient.ts";
import * as KinGitHubApp from "./KinGitHubApp.ts";
import type { KinGitHubPermissionSet } from "./KinGitHubPermissions.ts";
import {
  fakeGitHub,
  memoryKeychain,
  scopeLayer,
  type FakeAnswer,
  type RecordedRequest,
} from "./testFakes.ts";

const APP_ID = "123456";
const REPO = "GLDRoger/t3code" as RepoSlug;
const NOW_MS = Date.UTC(2026, 10, 8, 12);
const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const setup = (
  route: (request: RecordedRequest) => FakeAnswer | undefined,
  options: { readonly withKey?: boolean; readonly selection?: "all" | "selected" } = {},
) => {
  const keychain = memoryKeychain(
    options.withKey === false
      ? {}
      : { [`kin-github-app/${APP_ID}`]: JSON.stringify({ privateKeyPem }) },
  );
  const github = fakeGitHub((request) => {
    if (request.method === "GET" && request.path === `/repos/${REPO}/installation`) {
      return {
        status: 200,
        body: { id: 77, repository_selection: options.selection ?? "selected" },
      };
    }
    return route(request) ?? { status: 404, body: { message: "Not Found" } };
  });
  const layer = KinGitHubApp.layer.pipe(
    Layer.provide(Layer.succeed(KinGitHubApp.KinGitHubAppConfig, { appId: APP_ID })),
    Layer.provide(keychain.layer),
    Layer.provide(github.layer),
    Layer.provide(scopeLayer({ repos: [REPO, "GLDRoger/kin-memory"] })),
  );
  return { requests: github.requests, layer };
};

const mint = (
  permissions: KinGitHubPermissionSet,
  options: { readonly repo?: RepoSlug; readonly holder?: KinGitHubApp.KinGitHubTokenHolder } = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);
    const app = yield* KinGitHubApp.KinGitHubApp;
    return yield* app.installationToken({
      repo: options.repo ?? REPO,
      permissions,
      holder: options.holder ?? "worker",
    });
  });

/** Own keys, as a JSON body carries them; an object literal's `__proto__` sets the prototype. */
const ownKey = (name: string, level: string): Record<string, string> =>
  JSON.parse(`{${JSON.stringify(name)}:${JSON.stringify(level)}}`);

const granted = (permissions: Record<string, string>, repositories = [REPO]) => ({
  status: 201,
  body: {
    token: "ghs_fake_installation_token",
    expires_at: "2026-11-08T13:00:00Z",
    permissions,
    repository_selection: "selected",
    repositories: repositories.map((full_name) => ({ full_name })),
  },
});

describe("KinGitHubApp.installationToken", () => {
  it.effect("mints a token for one repository with only the asked permissions", () => {
    const { requests, layer } = setup((request) =>
      request.method === "POST" && request.path === "/app/installations/77/access_tokens"
        ? granted({ contents: "read", metadata: "read" })
        : undefined,
    );
    return Effect.gen(function* () {
      const token = yield* mint({ contents: "read" });
      assert.strictEqual(Redacted.value(token.token), "ghs_fake_installation_token");
      assert.notInclude(String(token.token), "ghs_");
      assert.deepStrictEqual(token.permissions, { contents: "read", metadata: "read" });

      const post = requests.find((request) => request.method === "POST");
      assert.deepStrictEqual(post?.body, {
        repositories: ["t3code"],
        permissions: { contents: "read" },
      });
      const jwt = post?.authorization?.replace(/^Bearer /, "") ?? "";
      const [header, payload, signature] = jwt.split(".") as [string, string, string];
      assert.isTrue(
        NodeCrypto.verify(
          "sha256",
          Buffer.from(`${header}.${payload}`),
          publicKey,
          Buffer.from(signature, "base64url"),
        ),
      );
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      assert.deepStrictEqual(claims, {
        iss: APP_ID,
        iat: NOW_MS / 1000 - 60,
        exp: NOW_MS / 1000 + 540,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("mints contents: write only for Kin's own server holder", () => {
    const { layer } = setup((request) =>
      request.method === "POST" && request.path === "/app/installations/77/access_tokens"
        ? granted({ contents: "write", metadata: "read" })
        : undefined,
    );
    return Effect.gen(function* () {
      const token = yield* mint({ contents: "write" }, { holder: "server" });
      assert.deepStrictEqual(token.permissions, { contents: "write", metadata: "read" });
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    [{}, "a token must name the permissions it needs"],
    [{ administration: "write" }, "administration is not a Kin App permission"],
    [{ workflows: "write" }, "workflows is not a Kin App permission"],
    [{ secrets: "read" }, "secrets is not a Kin App permission"],
    [{ checks: "write" }, "checks: write exceeds the App's read"],
    [{ contents: "admin" }, "contents must be read or write"],
    [ownKey("toString", "read"), "toString is not a Kin App permission"],
    [ownKey("constructor", "read"), "constructor is not a Kin App permission"],
    [ownKey("__proto__", "read"), "__proto__ is not a Kin App permission"],
  ] as const)("refuses %j before calling GitHub", ([permissions, reason]) => {
    const { requests, layer } = setup(() => undefined);
    return Effect.gen(function* () {
      const error = yield* mint(permissions as KinGitHubPermissionSet).pipe(Effect.flip);
      assert.strictEqual(error._tag, "KinGitHubTokenNarrowingError");
      assert.deepInclude(error, { stage: "request", reason });
      assert.lengthOf(requests, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    [
      "a repository outside KIN_GITHUB_REPOS",
      { contents: "read" },
      { repo: "GLDRoger/other" as RepoSlug },
      "not a repository in KIN_GITHUB_REPOS",
    ],
    [
      "contents: write for a lead",
      { contents: "write" },
      { holder: "lead" },
      "an agent's token can't have contents: write",
    ],
    [
      "contents: write for a worker",
      { contents: "write" },
      { holder: "worker" },
      "an agent's token can't have contents: write",
    ],
  ] as const)("refuses %s before calling GitHub", ([, permissions, options, reason]) => {
    const { requests, layer } = setup(() => undefined);
    return Effect.gen(function* () {
      const error = yield* mint(permissions, options).pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "KinGitHubTokenNarrowingError", stage: "request", reason });
      assert.lengthOf(requests, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses an installation on all of the account's repositories without minting", () => {
    const { requests, layer } = setup(() => undefined, { selection: "all" });
    return Effect.gen(function* () {
      const error = yield* mint({ contents: "read" }).pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "KinGitHubTokenNarrowingError", stage: "installation" });
      assert.isFalse(requests.some((request) => request.method === "POST"));
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    ["more permission than asked", { contents: "read" }, granted({ contents: "write" })],
    [
      "admin where write was asked",
      { pull_requests: "write" },
      granted({ pull_requests: "admin" }),
    ],
    ["an extra permission", { contents: "read" }, granted({ contents: "read", issues: "write" })],
    [
      "a prototype-named permission",
      { contents: "read" },
      granted({ contents: "read", ...ownKey("toString", "write") }),
    ],
    ["every repository", { contents: "read" }, granted({ contents: "read" }, [])],
    [
      "another repository",
      { contents: "read" },
      granted({ contents: "read" }, ["GLDRoger/kin-memory" as RepoSlug]),
    ],
  ] as const)("revokes and refuses a token GitHub granted with %s", ([, asked, answer]) => {
    const { requests, layer } = setup((request) =>
      request.method === "POST"
        ? answer
        : request.method === "DELETE"
          ? { status: 204 }
          : undefined,
    );
    return Effect.gen(function* () {
      const error = yield* mint(asked).pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "KinGitHubTokenNarrowingError", stage: "granted" });
      assert.notInclude(error.message, "ghs_");
      const revoke = requests.find((request) => request.method === "DELETE");
      assert.deepStrictEqual(revoke && [revoke.path, revoke.authorization], [
        "/installation/token",
        "Bearer ghs_fake_installation_token",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "revokes a token whose answer doesn't decode, and logs a failed revoke without it",
    () => {
      const logged: Array<unknown> = [];
      const logger = Logger.make(({ message }) => {
        logged.push(message);
      });
      const { requests, layer } = setup((request) =>
        request.method === "POST"
          ? { status: 201, body: { token: "ghs_fake_installation_token", permissions: "odd" } }
          : request.method === "DELETE"
            ? { status: 500 }
            : undefined,
      );
      return Effect.gen(function* () {
        const error = yield* mint({ contents: "read" }).pipe(Effect.flip);
        assert.deepInclude(error, { _tag: "KinGitHubRequestError", stage: "decode", status: 201 });
        const revoke = requests.find((request) => request.method === "DELETE");
        assert.strictEqual(revoke?.authorization, "Bearer ghs_fake_installation_token");
        assert.include(JSON.stringify(logged), "Could not revoke a Kin App token");
        assert.notInclude(JSON.stringify(logged), "ghs_");
      }).pipe(
        Effect.provide(Layer.merge(layer, Logger.layer([logger], { mergeWithExisting: false }))),
      );
    },
  );

  it.effect("reports a missing private key without calling GitHub", () => {
    const { requests, layer } = setup(() => undefined, { withKey: false });
    return Effect.gen(function* () {
      const error = yield* mint({ contents: "read" }).pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "KinGitHubAppNotConfiguredError", appId: APP_ID });
      assert.lengthOf(requests, 0);
    }).pipe(Effect.provide(layer));
  });
});

describe("KinGitHubApp.installations", () => {
  it.effect("reads every page", () => {
    const installation = {
      account: { login: "GLDRoger" },
      repository_selection: "selected",
      permissions: {},
      events: [],
    };
    const { requests, layer } = setup((request) => {
      const page = /[?&]page=(\d+)/.exec(request.path)?.[1];
      const size = page === "1" ? 100 : page === "2" ? 1 : 0;
      return {
        status: 200,
        body: Array.from({ length: size }, (_, index) => ({ ...installation, id: index })),
      };
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const app = yield* KinGitHubApp.KinGitHubApp;
      assert.lengthOf(yield* app.installations, 101);
      assert.deepStrictEqual(
        requests.map((request) => request.path),
        ["/app/installations?per_page=100&page=1", "/app/installations?per_page=100&page=2"],
      );
    }).pipe(Effect.provide(layer));
  });
});

describe("the App hook client (github.app_hook.configure)", () => {
  it.effect("patches the App's own webhook with an App JWT and maps refusals", () => {
    const answers: Array<FakeAnswer> = [
      { status: 200, body: { url: "https://kin.example/hook", secret: "********" } },
      { status: 422, body: { message: "Validation Failed" } },
    ];
    const { requests, layer } = setup((request) =>
      request.method === "PATCH" ? answers.shift() : undefined,
    );
    const client = AppHookClient.layer.pipe(Layer.provide(layer));
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const hook = yield* GithubWebhooks.GithubAppHookClient;
      yield* hook.patchHookConfig({
        url: "https://kin.example/hook",
        content_type: "json",
        insecure_ssl: "0",
        secret: Redacted.make("whsec_fake"),
      });
      const [patch] = requests;
      assert.strictEqual(`${patch?.method} ${patch?.path}`, "PATCH /app/hook/config");
      assert.deepStrictEqual(patch?.body, {
        url: "https://kin.example/hook",
        content_type: "json",
        insecure_ssl: "0",
        secret: "whsec_fake",
      });
      // Signed by the App's key, not an installation token.
      const jwt = patch?.authorization?.replace(/^Bearer /, "") ?? "";
      const [header, payload, signature] = jwt.split(".") as [string, string, string];
      assert.isTrue(
        NodeCrypto.verify(
          "sha256",
          Buffer.from(`${header}.${payload}`),
          publicKey,
          Buffer.from(signature, "base64url"),
        ),
      );
      assert.strictEqual(JSON.parse(Buffer.from(payload, "base64url").toString()).iss, APP_ID);
      // No secret on the call: the field is left out rather than cleared.
      const refused = yield* hook
        .patchHookConfig({
          url: "https://kin.example/hook",
          content_type: "json",
          insecure_ssl: "0",
        })
        .pipe(Effect.flip);
      assert.notProperty(requests[1]?.body, "secret");
      assert.deepInclude(refused, { _tag: "GithubAppHookRefused", reason: "failed" });
    }).pipe(Effect.provide(client));
  });

  it.effect("is unavailable without the App's key, and never calls GitHub", () => {
    const { requests, layer } = setup(() => undefined, { withKey: false });
    return Effect.gen(function* () {
      const hook = yield* GithubWebhooks.GithubAppHookClient;
      const refused = yield* hook
        .patchHookConfig({
          url: "https://kin.example/hook",
          content_type: "json",
          insecure_ssl: "0",
        })
        .pipe(Effect.flip);
      assert.deepInclude(refused, { reason: "unavailable" });
      assert.lengthOf(requests, 0);
    }).pipe(Effect.provide(AppHookClient.layer.pipe(Layer.provide(layer))));
  });
});

// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's crypto has no RSA key generation or verify.
import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import type { RepoSlug } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import * as KinGitHubApp from "./KinGitHubApp.ts";
import type { KinGitHubPermissionSet } from "./KinGitHubPermissions.ts";
import { fakeGitHub, memoryKeychain, type FakeAnswer, type RecordedRequest } from "./testFakes.ts";

const APP_ID = "123456";
const REPO = "GLDRoger/t3code" as RepoSlug;
const NOW_MS = Date.UTC(2026, 10, 8, 12);
const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const setup = (
  route: (request: RecordedRequest) => FakeAnswer | undefined,
  options: { readonly withKey?: boolean } = {},
) => {
  const keychain = memoryKeychain(
    options.withKey === false
      ? {}
      : { [`kin-github-app/${APP_ID}`]: JSON.stringify({ privateKeyPem }) },
  );
  const github = fakeGitHub((request) => {
    if (request.method === "GET" && request.path === `/repos/${REPO}/installation`) {
      return { status: 200, body: { id: 77 } };
    }
    return route(request) ?? { status: 404, body: { message: "Not Found" } };
  });
  const layer = KinGitHubApp.layer.pipe(
    Layer.provide(Layer.succeed(KinGitHubApp.KinGitHubAppConfig, { appId: APP_ID })),
    Layer.provide(keychain.layer),
    Layer.provide(github.layer),
  );
  return { requests: github.requests, layer };
};

const mint = (permissions: KinGitHubPermissionSet) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);
    const app = yield* KinGitHubApp.KinGitHubApp;
    return yield* app.installationToken({ repo: REPO, permissions });
  });

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

  it.effect.each([
    [{}, "a token must name the permissions it needs"],
    [{ administration: "write" }, "administration is not a Kin App permission"],
    [{ workflows: "write" }, "workflows is not a Kin App permission"],
    [{ secrets: "read" }, "secrets is not a Kin App permission"],
    [{ checks: "write" }, "checks: write exceeds the App's read"],
    [{ contents: "admin" }, "contents must be read or write"],
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
    ["more permission than asked", granted({ contents: "write", metadata: "read" })],
    ["an extra permission", granted({ contents: "read", issues: "write" })],
    ["every repository", granted({ contents: "read" }, [])],
    ["another repository", granted({ contents: "read" }, ["GLDRoger/kin-memory" as RepoSlug])],
  ] as const)("revokes and refuses a token GitHub granted with %s", ([, answer]) => {
    const { requests, layer } = setup((request) =>
      request.method === "POST"
        ? answer
        : request.method === "DELETE"
          ? { status: 204 }
          : undefined,
    );
    return Effect.gen(function* () {
      const error = yield* mint({ contents: "read" }).pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "KinGitHubTokenNarrowingError", stage: "granted" });
      assert.notInclude(error.message, "ghs_");
      const revoke = requests.find((request) => request.method === "DELETE");
      assert.deepStrictEqual(revoke && [revoke.path, revoke.authorization], [
        "/installation/token",
        "Bearer ghs_fake_installation_token",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a missing private key without calling GitHub", () => {
    const { requests, layer } = setup(() => undefined, { withKey: false });
    return Effect.gen(function* () {
      const error = yield* mint({ contents: "read" }).pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "KinGitHubAppNotConfiguredError", appId: APP_ID });
      assert.lengthOf(requests, 0);
    }).pipe(Effect.provide(layer));
  });
});

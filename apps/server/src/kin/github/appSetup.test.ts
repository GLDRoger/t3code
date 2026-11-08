// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's crypto has no RSA key generation.
import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import recorded from "./__fixtures__/github-app.json" with { type: "json" };
import * as AppSetup from "./appSetup.ts";
import * as KinGitHubApp from "./KinGitHubApp.ts";
import { KIN_GITHUB_APP_EVENTS } from "./KinGitHubPermissions.ts";
import { fakeGitHub, memoryKeychain, scopeLayer, type FakeAnswer } from "./testFakes.ts";

const privateKeyPem = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const checkWith = (answers: { readonly app: unknown; readonly installations: unknown }) => {
  const github = fakeGitHub((request): FakeAnswer => {
    if (request.path === "/app") return { status: 200, body: answers.app };
    if (request.path === "/app/installations?per_page=100&page=1") {
      return { status: 200, body: answers.installations };
    }
    return { status: 404 };
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.UTC(2026, 10, 8));
    return yield* AppSetup.checkApp;
  }).pipe(
    Effect.provide(
      KinGitHubApp.layer.pipe(
        Layer.provide(Layer.succeed(KinGitHubApp.KinGitHubAppConfig, { appId: "123456" })),
        Layer.provide(
          memoryKeychain({ "kin-github-app/123456": JSON.stringify({ privateKeyPem }) }).layer,
        ),
        Layer.provide(github.layer),
        Layer.provide(scopeLayer()),
      ),
    ),
  );
};

const installation = recorded.installations[0]!;

describe("kin-github-app --check", () => {
  it.effect("passes the recorded App, whose permissions match the table", () =>
    Effect.gen(function* () {
      // The recording predates lane C's event list; its own events are a failing case below.
      const app = { ...recorded.app, events: [...KIN_GITHUB_APP_EVENTS] };
      const result = yield* checkWith({ app, installations: recorded.installations });
      assert.isTrue(result.ok);
      assert.include(result.lines, "  ok   contents                     write (table: write)");
      assert.include(result.lines, "Installation 77 on GLDRoger: selected repositories");
      assert.strictEqual(result.lines.at(-1), "PASS: permissions match the approvals spec table.");
    }),
  );

  it.effect("fails an App that gained Workflows or Administration, or lost a permission", () =>
    Effect.gen(function* () {
      const result = yield* checkWith({
        app: {
          ...recorded.app,
          permissions: {
            ...recorded.app.permissions,
            contents: "read",
            workflows: "write",
            administration: "read",
          },
        },
        installations: recorded.installations,
      });
      assert.isFalse(result.ok);
      assert.include(
        result.lines,
        "  FAIL contents                     read  (table: write) too_low",
      );
      assert.include(
        result.lines,
        "  FAIL workflows                    write (table: none) extra: a worker could add a workflow that reads repository secrets",
      );
      assert.include(
        result.lines,
        "  FAIL administration               read  (table: none) extra: could change branch rulesets, collaborators and settings",
      );
      assert.strictEqual(result.lines.at(-1), "FAIL: see above.");
    }),
  );

  it.effect.each([
    ["installed on every repository", [{ ...installation, repository_selection: "all" }]],
    [
      "an installation still on old permissions",
      [{ ...installation, permissions: { ...installation.permissions, issues: "read" } }],
    ],
    ["not installed", []],
  ] as const)("fails an App %s", ([, installations]) =>
    Effect.gen(function* () {
      const result = yield* checkWith({ app: recorded.app, installations });
      assert.isFalse(result.ok);
      assert.isTrue(result.lines.some((line) => line.includes("FAIL")));
    }),
  );

  it.effect.each([
    ["still on the recorded event set", () => recorded.app.events],
    ["subscribed to only some events", () => KIN_GITHUB_APP_EVENTS.slice(1)],
    ["subscribed to an extra event", () => [...KIN_GITHUB_APP_EVENTS, "member"]],
  ] as const)("fails an App %s", ([, events]) =>
    Effect.gen(function* () {
      const app = { ...recorded.app, events: [...events()] };
      const result = yield* checkWith({ app, installations: recorded.installations });
      assert.isFalse(result.ok);
      assert.isTrue(result.lines.some((line) => line.includes("FAIL")));
    }),
  );
});

describe("kin-github-app manifest conversion", () => {
  const conversion = {
    id: 123456,
    slug: "kin-gldroger",
    owner: { login: "GLDRoger" },
    pem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
    webhook_secret: "fake-webhook-secret",
    client_id: "Iv23liFakeClientId",
    client_secret: "fake-client-secret",
    permissions: recorded.app.permissions,
  };

  it.effect("puts the secrets in the keychain and prints only public facts", () => {
    const keychain = memoryKeychain();
    const github = fakeGitHub((request) =>
      request.method === "POST" && request.path === "/app-manifests/abc123/conversions"
        ? { status: 201, body: conversion }
        : { status: 404 },
    );
    return Effect.gen(function* () {
      const result = yield* AppSetup.completeManifest("abc123", "gldroger");
      assert.isTrue(result.ok);
      assert.strictEqual(github.requests[0]?.authorization, undefined);
      assert.deepStrictEqual(JSON.parse(keychain.items.get("kin-github-app/123456") ?? "{}"), {
        privateKeyPem: conversion.pem,
        webhookSecret: conversion.webhook_secret,
        clientId: conversion.client_id,
        clientSecret: conversion.client_secret,
      });
      const printed = result.lines.join("\n");
      for (const secret of ["PRIVATE KEY", "fake-webhook-secret", "fake-client-secret"]) {
        assert.notInclude(printed, secret);
      }
      assert.include(printed, "KIN_GITHUB_APP_ID=123456");
    }).pipe(Effect.provide(Layer.mergeAll(keychain.layer, github.layer)));
  });

  it.effect("refuses a malformed code without calling GitHub", () => {
    const keychain = memoryKeychain();
    const github = fakeGitHub(() => ({ status: 500 }));
    return Effect.gen(function* () {
      const result = yield* AppSetup.completeManifest("../../user", "GLDRoger");
      assert.isFalse(result.ok);
      assert.lengthOf(github.requests, 0);
      assert.strictEqual(keychain.items.size, 0);
    }).pipe(Effect.provide(Layer.mergeAll(keychain.layer, github.layer)));
  });

  it.effect.each([
    ["another owner", conversion, "Mallory"],
    [
      "permissions that differ from the table",
      { ...conversion, permissions: { ...conversion.permissions, workflows: "write" } },
      "GLDRoger",
    ],
  ] as const)("stores nothing for an App with %s", ([, answer, expectedOwner]) => {
    const keychain = memoryKeychain();
    const github = fakeGitHub(() => ({ status: 201, body: answer }));
    return Effect.gen(function* () {
      const result = yield* AppSetup.completeManifest("abc123", expectedOwner);
      assert.isFalse(result.ok);
      assert.strictEqual(keychain.items.size, 0);
      assert.notInclude(result.lines.join("\n"), "PRIVATE KEY");
    }).pipe(Effect.provide(Layer.mergeAll(keychain.layer, github.layer)));
  });
});

describe("kin-github-app loopback server", () => {
  it.each([
    ["127.0.0.1:47821", true],
    ["localhost:47821", true],
    ["127.0.0.1:1", false],
    ["evil.example:47821", false],
    [undefined, false],
  ] as const)("accepts Host %s: %s", (host, accepted) => {
    assert.strictEqual(AppSetup.isLoopbackHost(host, 47821), accepted);
  });
});

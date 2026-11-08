import { assert, it } from "@effect/vitest";
import type { KinOrgId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import * as OwnerMergeClient from "../github/OwnerMergeClient.ts";
import { fakeGitHub, memoryKeychain } from "../github/testFakes.ts";
import * as CredentialHygiene from "./CredentialHygiene.ts";

const ORG = "org_kin" as KinOrgId;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 8);

type Identity = Option.Option<{ readonly login: string; readonly source: string }> | "unreachable";

const setup = (input: {
  readonly identity: Identity;
  readonly env?: Record<string, string>;
  readonly mergeToken?: { readonly login: string; readonly expiresAt: number } | null;
}) => {
  const state = { identity: input.identity };
  const mergeToken =
    input.mergeToken === undefined
      ? { login: "Nishchay", expiresAt: NOW + 30 * DAY }
      : input.mergeToken;
  const keychain = memoryKeychain(
    mergeToken === null
      ? {}
      : {
          [`kin-owner-merge/${ORG}`]: JSON.stringify({
            token: "github_pat_fake",
            ...mergeToken,
            savedAt: NOW,
          }),
        },
  );
  const identity = Layer.succeed(
    CredentialHygiene.T3GitHubIdentity,
    CredentialHygiene.T3GitHubIdentity.of({
      current: Effect.suspend(() =>
        state.identity === "unreachable"
          ? Effect.fail(new CredentialHygiene.T3GitHubIdentityError({ cause: "offline" }))
          : Effect.succeed(state.identity),
      ),
    }),
  );
  const layer = CredentialHygiene.layer.pipe(
    Layer.provide(identity),
    Layer.provide(OwnerMergeClient.layer),
    Layer.provide(keychain.layer),
    Layer.provide(fakeGitHub(() => ({ status: 500 })).layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env ?? {} }))),
  );
  return { state, layer };
};

const bot = Option.some({ login: "kin-bot", source: "gh" });

const check = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const hygiene = yield* CredentialHygiene.CredentialHygiene;
  return yield* hygiene.check(ORG);
});

describe("CredentialHygiene", () => {
  it.effect("privileged execution is refused while the credential hygiene check fails", () => {
    const { state, layer } = setup({ identity: Option.some({ login: "nishchay", source: "gh" }) });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const hygiene = yield* CredentialHygiene.CredentialHygiene;
      let merges = 0;
      const execute = hygiene
        .requirePassing(ORG)
        .pipe(Effect.andThen(Effect.sync(() => void merges++)));

      const refused = yield* execute.pipe(Effect.flip);
      assert.deepStrictEqual(refused.failures, ["owner_identity"]);
      assert.strictEqual(merges, 0);

      state.identity = "unreachable";
      assert.deepStrictEqual((yield* execute.pipe(Effect.flip)).failures, ["identity_unknown"]);
      assert.strictEqual(merges, 0);

      state.identity = bot;
      yield* execute;
      assert.strictEqual(merges, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    [
      "T3 signed in as the owner",
      { identity: Option.some({ login: "NISHCHAY", source: "app" }) },
      ["owner_identity"],
    ],
    ["GH_TOKEN in the environment", { identity: bot, env: { GH_TOKEN: "ghp_x" } }, ["env_token"]],
    [
      "GITHUB_TOKEN in the environment",
      { identity: bot, env: { GITHUB_TOKEN: "x" } },
      ["env_token"],
    ],
    [
      "T3 using an environment token",
      { identity: Option.some({ login: "kin-bot", source: "env" }) },
      ["env_token"],
    ],
    ["the identity unreachable", { identity: "unreachable" }, ["identity_unknown"]],
    ["no merge token", { identity: bot, mergeToken: null }, ["merge_token_missing"]],
    [
      "an expired merge token",
      { identity: bot, mergeToken: { login: "Nishchay", expiresAt: NOW - 1 } },
      ["merge_token_expired"],
    ],
  ] as const)("fails with %s", ([, input, failures]) =>
    Effect.gen(function* () {
      const report = yield* check;
      assert.isFalse(report.passed);
      assert.deepStrictEqual(report.failures, failures);
    }).pipe(Effect.provide(setup(input).layer)),
  );

  it.effect("names environment tokens without their values", () =>
    Effect.gen(function* () {
      const report = yield* check;
      assert.deepStrictEqual(report.envTokenNames, ["GH_TOKEN"]);
      assert.notInclude(JSON.stringify(report), "ghp_secret_value");
    }).pipe(Effect.provide(setup({ identity: bot, env: { GH_TOKEN: "ghp_secret_value" } }).layer)),
  );

  it.effect("passes with the bot or no GitHub login, and warns 7 days before expiry", () =>
    Effect.gen(function* () {
      const quiet = yield* check.pipe(Effect.provide(setup({ identity: Option.none() }).layer));
      assert.deepInclude(quiet, { passed: true, failures: [], warnings: [], t3Login: null });

      const expiring = yield* check.pipe(
        Effect.provide(
          setup({ identity: bot, mergeToken: { login: "Nishchay", expiresAt: NOW + 6 * DAY } })
            .layer,
        ),
      );
      assert.deepInclude(expiring, {
        passed: true,
        warnings: ["merge_token_expiring"],
        t3Login: "kin-bot",
      });
    }),
  );
});

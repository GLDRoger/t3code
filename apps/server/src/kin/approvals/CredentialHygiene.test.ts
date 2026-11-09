import { assert, it } from "@effect/vitest";
import type { KinOrgId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import * as OwnerMergeClient from "../github/OwnerMergeClient.ts";
import { fakeGitHub, memoryKeychain, scopeLayer } from "../github/testFakes.ts";
import * as CredentialHygiene from "./CredentialHygiene.ts";

const ORG = "org_kin" as KinOrgId;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 8);
const sshHi = (login: string) =>
  `Hi ${login}! You've successfully authenticated, but GitHub does not provide shell access.`;
const SSH_DENIED = "git@github.com: Permission denied (publickey).";

type Identity =
  | {
      readonly t3?: ReadonlyArray<{ readonly login: string; readonly source: string }>;
      readonly gh?: ReadonlyArray<string>;
      readonly git?: Option.Option<string>;
      readonly ssh?: ReadonlyArray<string>;
    }
  | "unreachable";

const setup = (input: {
  readonly identity: Identity;
  readonly env?: Record<string, string>;
  readonly mergeToken?: { readonly login: string; readonly expiresAt: number } | null;
}) => {
  const state = { identity: input.identity, probes: 0 };
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
      identities: Effect.suspend(() => {
        state.probes += 1;
        // Takes a second, so a check that starts meanwhile shares it.
        return Effect.sleep("1 second");
      }).pipe(
        Effect.andThen(() =>
          state.identity === "unreachable"
            ? Effect.fail(new CredentialHygiene.T3GitHubIdentityError({ cause: "offline" }))
            : Effect.succeed({
                t3: state.identity.t3 ?? [],
                ghAccounts: state.identity.gh ?? [],
                gitCredential: state.identity.git ?? Option.none(),
                ssh: state.identity.ssh ?? [SSH_DENIED],
              }),
        ),
      ),
    }),
  );
  const layer = CredentialHygiene.layer.pipe(
    Layer.provide(identity),
    Layer.provide(OwnerMergeClient.layer),
    Layer.provide(keychain.layer),
    Layer.provide(fakeGitHub(() => ({ status: 500 })).layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env ?? {} }))),
    Layer.provide(scopeLayer()),
  );
  return { state, layer };
};

const bot: Identity = {
  t3: [{ login: "kin-bot", source: "gh" }],
  gh: ["kin-bot"],
  git: Option.some("Kin-Bot"),
  ssh: [sshHi("kin-bot"), SSH_DENIED],
};

const check = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const hygiene = yield* CredentialHygiene.CredentialHygiene;
  const running = yield* Effect.forkChild(hygiene.check(ORG));
  yield* TestClock.adjust("1 second");
  return yield* Fiber.join(running);
});

/** Runs `effect` past the probe's one-second wait. */
const settled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const running = yield* Effect.forkChild(effect);
    yield* TestClock.adjust("1 second");
    return yield* Fiber.join(running);
  });

describe("CredentialHygiene", () => {
  it.effect("privileged execution is refused while the credential hygiene check fails", () => {
    const { state, layer } = setup({
      identity: { t3: [{ login: "nishchay", source: "gh" }] },
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const hygiene = yield* CredentialHygiene.CredentialHygiene;
      let merges = 0;
      const execute = settled(hygiene.requirePassing(ORG)).pipe(
        Effect.andThen(Effect.sync(() => void merges++)),
      );

      const refused = yield* execute.pipe(Effect.flip);
      assert.deepStrictEqual(refused.failures, ["owner_identity"]);
      assert.strictEqual(merges, 0);

      state.identity = "unreachable";
      assert.deepStrictEqual((yield* execute.pipe(Effect.flip)).failures, ["identity_unknown"]);
      assert.strictEqual(merges, 0);

      state.identity = bot;
      yield* execute;
      assert.strictEqual(merges, 1);
      assert.strictEqual((yield* settled(hygiene.requirePassing(ORG))).orgId, ORG);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    [
      "T3 signed in as the owner",
      { identity: { t3: [{ login: "NISHCHAY", source: "app" }] } },
      ["owner_identity"],
    ],
    [
      "one of T3's credentials signed in as the owner",
      {
        identity: {
          ...bot,
          t3: [
            { login: "kin-bot", source: "settings" },
            { login: "Nishchay", source: "app" },
          ],
        },
      },
      ["owner_identity"],
    ],
    [
      "an inactive gh account that is the owner",
      { identity: { ...bot, gh: ["kin-bot", "Nishchay"] } },
      ["owner_identity"],
    ],
    [
      "the git credential helper signed in as the owner",
      { identity: { ...bot, git: Option.some("nishchay") } },
      ["owner_identity"],
    ],
    [
      "the configured owner with no merge token to compare",
      { identity: { gh: ["Nishchay"] }, mergeToken: null },
      ["merge_token_missing", "owner_identity"],
    ],
    [
      "an SSH key that signs in as the owner",
      { identity: { ...bot, ssh: [sshHi("kin-bot"), sshHi("Nishchay")] } },
      ["owner_identity"],
    ],
    [
      "an SSH key that isn't the bot's",
      { identity: { ...bot, ssh: [sshHi("GLDRoger/t3code")] } },
      ["non_bot_identity"],
    ],
    [
      "an SSH key ssh skipped for its file permissions",
      {
        identity: {
          ...bot,
          ssh: [
            `WARNING: UNPROTECTED PRIVATE KEY FILE!\nThis private key will be ignored.\nLoad key "/home/kin/.ssh/owner_ed25519": bad permissions\n${SSH_DENIED}`,
          ],
        },
      },
      ["identity_unknown"],
    ],
    [
      "an owner greeting after a bot greeting in one answer",
      { identity: { ...bot, ssh: [`${sshHi("kin-bot")}\n${sshHi("Nishchay")}`] } },
      ["owner_identity"],
    ],
    [
      "an SSH answer that can't be read",
      { identity: { ...bot, ssh: ["Host key verification failed."] } },
      ["identity_unknown"],
    ],
    ["no SSH answer at all", { identity: { ...bot, ssh: [] } }, ["identity_unknown"]],
    [
      "an SSH agent in the environment",
      { identity: bot, env: { SSH_AUTH_SOCK: "/tmp/agent.sock" } },
      ["env_token"],
    ],
    [
      "a gh account that isn't the bot",
      { identity: { ...bot, gh: ["kin-bot", "someone-else"] } },
      ["non_bot_identity"],
    ],
    [
      "T3 using a login that isn't the bot",
      { identity: { t3: [{ login: "someone-else", source: "app" }] } },
      ["non_bot_identity"],
    ],
    ["GH_TOKEN in the environment", { identity: bot, env: { GH_TOKEN: "ghp_x" } }, ["env_token"]],
    [
      "GITHUB_TOKEN in the environment",
      { identity: bot, env: { GITHUB_TOKEN: "x" } },
      ["env_token"],
    ],
    [
      "T3 using an environment token",
      { identity: { t3: [{ login: "kin-bot", source: "env" }] } },
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

  it.effect("checks share one probe for a minute; requirePassing always probes afresh", () => {
    const { state, layer } = setup({ identity: bot });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const hygiene = yield* CredentialHygiene.CredentialHygiene;
      const other = "org_other" as KinOrgId;
      const reports = yield* settled(
        Effect.all([hygiene.check(ORG), hygiene.check(other), hygiene.check(ORG)], {
          concurrency: "unbounded",
        }),
      );
      assert.deepStrictEqual(
        reports.map((report) => report.passed),
        [true, false, true],
      );
      assert.strictEqual(state.probes, 1);

      state.identity = { ...bot, gh: ["kin-bot", "Nishchay"] };
      assert.isTrue((yield* settled(hygiene.check(ORG))).passed);
      assert.strictEqual(state.probes, 1);
      // The gate before a side effect never reuses the cached pass.
      assert.deepStrictEqual(
        (yield* settled(hygiene.requirePassing(ORG)).pipe(Effect.flip)).failures,
        ["owner_identity"],
      );
      assert.strictEqual(state.probes, 2);

      yield* TestClock.adjust(CredentialHygiene.PROBE_CACHE_TTL);
      assert.isFalse((yield* settled(hygiene.check(ORG))).passed);
      assert.strictEqual(state.probes, 3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("names environment tokens without their values", () =>
    Effect.gen(function* () {
      const report = yield* check;
      assert.deepStrictEqual(report.envTokenNames, ["GH_TOKEN"]);
      assert.notInclude(JSON.stringify(report), "ghp_secret_value");
    }).pipe(Effect.provide(setup({ identity: bot, env: { GH_TOKEN: "ghp_secret_value" } }).layer)),
  );

  it.effect("passes with the bot or no GitHub login, and warns 7 days before expiry", () =>
    Effect.gen(function* () {
      const quiet = yield* check.pipe(Effect.provide(setup({ identity: {} }).layer));
      assert.deepInclude(quiet, {
        passed: true,
        failures: [],
        warnings: [],
        t3Login: null,
        identities: [],
      });

      const everywhere = yield* check.pipe(Effect.provide(setup({ identity: bot }).layer));
      assert.deepInclude(everywhere, { passed: true });
      assert.deepStrictEqual(everywhere.identities, [
        { source: "t3", login: "kin-bot" },
        { source: "gh", login: "kin-bot" },
        { source: "git_credential", login: "Kin-Bot" },
        { source: "ssh", login: "kin-bot" },
      ]);

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

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type KinOrgId,
  type VcsError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { VcsProcess, type VcsProcessInput, type VcsProcessOutput } from "../../vcs/VcsProcess.ts";
import * as OwnerMergeClient from "../github/OwnerMergeClient.ts";
import { fakeGitHub, memoryKeychain, scopeLayer } from "../github/testFakes.ts";
import * as CredentialHygiene from "./CredentialHygiene.ts";
import * as GitHubIdentityProbe from "./GitHubIdentityProbe.ts";
import * as T3GitHubCredential from "./T3GitHubCredential.ts";

const ORG = "org_kin" as KinOrgId;
const NOW = Date.UTC(2026, 10, 9);
const DAY = 24 * 60 * 60 * 1000;
const T3_TOKEN = "gho_t3_token";
const GIT_PASSWORD = "gho_git_helper_password_never_logged";
const KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n-----END OPENSSH PRIVATE KEY-----\n";
const sshHi = (login: string) =>
  `Hi ${login}! You've successfully authenticated, but GitHub does not provide shell access.`;
const SSH_DENIED = "git@github.com: Permission denied (publickey).";

type Run = Effect.Effect<VcsProcessOutput, VcsError>;
const answer = (input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}): Run =>
  Effect.succeed({
    exitCode: ChildProcessSpawner.ExitCode(input.exitCode ?? 0),
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
const missing = (command: string): Run =>
  Effect.fail(
    new VcsProcessSpawnError({
      operation: "test",
      command,
      cwd: "/",
      cause: PlatformError.systemError({ _tag: "NotFound", module: "test", method: "spawn" }),
    }),
  );
const timeout = (command: string) =>
  new VcsProcessTimeoutError({ operation: "test", command, cwd: "/", timeoutMs: 1 });
const ghStatus = (...logins: ReadonlyArray<string>) =>
  answer({
    stdout: JSON.stringify({
      hosts: {
        "github.com": logins.map((login, index) => ({
          state: "success",
          active: index === 0,
          host: "github.com",
          login,
          tokenSource: "keyring",
        })),
      },
    }),
  });
const gitFill = (password: string) =>
  answer({ stdout: `protocol=https\nhost=github.com\nusername=x\npassword=${password}\n` });

/** The machine the probe looks at. Each test changes what one source answers. */
interface Machine {
  t3: Option.Option<string> | "uninstalled";
  /** The login GitHub's `GET /user` names for each token; any other token gets a 401. */
  users: Record<string, string | number>;
  gh: Run;
  git: Run;
  /** Answers one SSH probe; `key` is the `-i` file, or undefined for the probe as is. */
  ssh: (key: string | undefined) => Run;
  keys: Record<string, string>;
}

const botMachine = (): Machine => ({
  t3: Option.some(T3_TOKEN),
  users: { [T3_TOKEN]: "kin-bot", [GIT_PASSWORD]: "kin-bot" },
  gh: ghStatus("kin-bot"),
  git: gitFill(GIT_PASSWORD),
  ssh: (key) => answer({ stderr: key === undefined ? sshHi("kin-bot") : SSH_DENIED }),
  keys: { id_ed25519: KEY, "id_ed25519.pub": "ssh-ed25519 AAAA kin-bot", config: "Host *\n" },
});

/** Builds the live probe over `machine` in a fresh home, and the check over that probe. */
const probe = (machine: Machine) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(home, ".ssh"));
    yield* fs.makeDirectory(path.join(home, ".ssh", "sockets"));
    for (const [name, text] of Object.entries(machine.keys)) {
      yield* fs.writeFileString(path.join(home, ".ssh", name), text);
    }
    const runs: Array<VcsProcessInput> = [];
    const vcs = VcsProcess.of({
      run: (input) => {
        runs.push(input);
        if (input.command === "gh") return machine.gh;
        if (input.command === "git") return machine.git;
        const key = input.args.indexOf("-i");
        return machine.ssh(key === -1 ? undefined : input.args[key + 1]);
      },
    });
    const github = fakeGitHub((request) => {
      const token = request.authorization?.replace(/^Bearer /, "") ?? "";
      const user = machine.users[token];
      return typeof user === "string"
        ? { status: 200, body: { login: user } }
        : { status: user ?? 401, body: { message: "Bad credentials" } };
    });
    const slot = Context.get(
      yield* Layer.build(T3GitHubCredential.slotLayer),
      T3GitHubCredential.T3GitHubCredential,
    );
    if (machine.t3 !== "uninstalled") {
      const t3 = machine.t3;
      yield* slot.install(
        Effect.succeed(
          Option.map(t3, (token) => ({ token: Redacted.make(token), source: "gh" as const })),
        ),
      );
    }
    const identity = yield* GitHubIdentityProbe.make.pipe(
      Effect.provideService(VcsProcess, vcs),
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(T3GitHubCredential.T3GitHubCredential, slot),
      Effect.provide(github.layer),
    );
    const keychain = memoryKeychain({
      [`kin-owner-merge/${ORG}`]: JSON.stringify({
        token: "github_pat_owner",
        login: "Nishchay",
        expiresAt: NOW + 30 * DAY,
        savedAt: NOW,
      }),
    });
    const hygiene = yield* Layer.build(
      CredentialHygiene.layer.pipe(
        Layer.provide(Layer.succeed(CredentialHygiene.T3GitHubIdentity, identity)),
        Layer.provide(OwnerMergeClient.layer),
        Layer.provide(keychain.layer),
        Layer.provide(fakeGitHub(() => ({ status: 500 })).layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        Layer.provide(scopeLayer()),
      ),
    );
    const check = Context.get(hygiene, CredentialHygiene.CredentialHygiene).check(ORG);
    return { identities: identity.identities, check, runs, home, requests: github.requests };
  });

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("GitHubIdentityProbe", () => {
  it.effect("reports all four sources, and the check passes with only the bot's login", () =>
    run(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { identities, check, runs, home } = yield* probe(botMachine());
        const found = yield* identities;
        const probed = [...runs];
        assert.deepStrictEqual(found, {
          t3: Option.some({ login: "kin-bot", source: "gh" }),
          ghAccounts: ["kin-bot"],
          gitCredential: Option.some("kin-bot"),
          ssh: [sshHi("kin-bot"), SSH_DENIED],
        });
        assert.deepInclude(yield* check, { passed: true, failures: [] });

        // One run per source, plus one per private key: not the public key, config or directory.
        assert.sameDeepMembers(
          probed.map((input) => [input.command, ...input.args]),
          [
            ["gh", "auth", "status", "--hostname", "github.com", "--json", "hosts"],
            ["git", "credential", "fill"],
            [...CredentialHygiene.GITHUB_SSH_PROBE],
            [
              ...CredentialHygiene.GITHUB_SSH_PROBE.slice(0, -1),
              "-o",
              "IdentitiesOnly=yes",
              "-i",
              path.join(home, ".ssh", "id_ed25519"),
              "git@github.com",
            ],
          ],
        );
        for (const input of probed) {
          assert.strictEqual(input.cwd, path.parse(home).root);
          assert.isAbove(input.timeoutMs ?? 0, 0);
          assert.isAbove(input.maxOutputBytes ?? 0, 0);
        }
        const git = probed.find((input) => input.command === "git");
        assert.strictEqual(git?.stdin, "protocol=https\nhost=github.com\n\n");
        assert.deepInclude(git?.env, { GIT_TERMINAL_PROMPT: "0" });
        for (const input of probed.filter((input) => input.command === "ssh")) {
          assert.deepInclude(input.env, { SSH_AUTH_SOCK: "" });
        }
      }),
    ),
  );

  it.effect("reads no login from sources that have none", () =>
    run(
      Effect.gen(function* () {
        const { identities, check } = yield* probe({
          ...botMachine(),
          t3: Option.none(),
          gh: missing("gh"),
          git: answer({
            exitCode: 128,
            stderr:
              "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
          }),
          ssh: () => answer({ stderr: SSH_DENIED }),
          keys: {},
        });
        assert.deepStrictEqual(yield* identities, {
          t3: Option.none(),
          ghAccounts: [],
          gitCredential: Option.none(),
          ssh: [SSH_DENIED],
        });
        assert.deepInclude(yield* check, { passed: true, identities: [] });
      }),
    ),
  );

  it.effect.each([
    ["T3's credential", { users: { [T3_TOKEN]: "Nishchay", [GIT_PASSWORD]: "kin-bot" } }],
    ["an inactive gh account", { gh: ghStatus("kin-bot", "Nishchay") }],
    ["the git credential helper", { users: { [T3_TOKEN]: "kin-bot", [GIT_PASSWORD]: "nishchay" } }],
    [
      "SSH without a key",
      {
        ssh: (key: string | undefined) =>
          answer({ stderr: key === undefined ? sshHi("Nishchay") : SSH_DENIED }),
      },
    ],
    [
      "one key in ~/.ssh",
      {
        ssh: (key: string | undefined) =>
          answer({
            stderr: key?.endsWith("owner_ed25519") === true ? sshHi("Nishchay") : SSH_DENIED,
          }),
        keys: { ...botMachine().keys, owner_ed25519: KEY },
      },
    ],
  ] as const)("fails as owner_identity when %s is the owner", ([, change]) =>
    run(
      Effect.gen(function* () {
        const { check } = yield* probe({ ...botMachine(), ...change });
        assert.deepInclude(yield* check, { passed: false, failures: ["owner_identity"] });
      }),
    ),
  );

  it.effect.each([
    ["T3's reader isn't installed", { t3: "uninstalled" }],
    ["GitHub refuses T3's credential", { users: { [GIT_PASSWORD]: "kin-bot" } }],
    ["gh is too old for --json", { gh: answer({ exitCode: 1, stderr: "unknown flag: --json" }) }],
    ["gh answers something else", { gh: answer({ stdout: "github.com\n  Logged in" }) }],
    ["gh times out", { gh: Effect.fail(timeout("gh")) }],
    [
      "git credential fill fails",
      { git: answer({ exitCode: 1, stderr: "fatal: credential helper crashed" }) },
    ],
    ["the helper's password is refused", { users: { [T3_TOKEN]: "kin-bot" } }],
    ["GitHub is down for the helper", { users: { [T3_TOKEN]: "kin-bot", [GIT_PASSWORD]: 502 } }],
    ["an SSH probe times out", { ssh: () => Effect.fail(timeout("ssh")) }],
  ] as const)("fails closed when %s", ([, change]) =>
    run(
      Effect.gen(function* () {
        const { identities, check } = yield* probe({ ...botMachine(), ...change } as Machine);
        const error = yield* identities.pipe(Effect.flip);
        assert.strictEqual(error._tag, "T3GitHubIdentityError");
        assert.deepInclude(yield* check, { passed: false, failures: ["identity_unknown"] });
      }),
    ),
  );

  it.effect("never puts the helper's password in a log, error or report", () => {
    const logged: Array<string> = [];
    const logger = Logger.make(({ message, cause }) => {
      logged.push(JSON.stringify(message), String(cause));
    });
    return run(
      Effect.gen(function* () {
        const seen: Array<string> = [];
        for (const users of [
          { [T3_TOKEN]: "kin-bot", [GIT_PASSWORD]: "kin-bot" },
          { [T3_TOKEN]: "kin-bot" },
          { [T3_TOKEN]: "kin-bot", [GIT_PASSWORD]: 500 },
        ]) {
          const { identities, check, requests } = yield* probe({ ...botMachine(), users });
          const result = yield* Effect.result(identities);
          seen.push(JSON.stringify(result), String(result), JSON.stringify(yield* check));
          yield* Effect.logWarning("probe", result);
          // It does reach GitHub, as a bearer token and nowhere else.
          assert.include(
            requests.map((request) => request.authorization),
            `Bearer ${GIT_PASSWORD}`,
          );
        }
        const haystack = [...seen, ...logged].join("\n");
        assert.include(haystack, "git_credential");
        assert.notInclude(haystack, GIT_PASSWORD);
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
    );
  });
});

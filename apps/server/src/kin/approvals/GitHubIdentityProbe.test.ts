import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type KinOrgId,
  type VcsError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { VcsProcess, type VcsProcessInput, type VcsProcessOutput } from "../../vcs/VcsProcess.ts";
import { credentialCheckBody } from "../chat/executionNotices.ts";
import * as OwnerMergeClient from "../github/OwnerMergeClient.ts";
import { fakeGitHub, memoryKeychain, scopeLayer } from "../github/testFakes.ts";
import * as CredentialHygiene from "./CredentialHygiene.ts";
import * as GitHubIdentityProbe from "./GitHubIdentityProbe.ts";
import * as T3GitHubCredential from "./T3GitHubCredential.ts";

const ORG = "org_kin" as KinOrgId;
const NOW = Date.UTC(2026, 10, 9);
const DAY = 24 * 60 * 60 * 1000;
const APP_TOKEN = "ghu_t3_app_token";
const SAVED_TOKEN = "ghp_t3_saved_token";
const GH_TOKEN = "gho_gh_keyring_token";
const OWNER_TOKEN = "gho_owner_token";
const GIT_PASSWORD = "gho_git_helper_password_never_logged";
const SSH_G_SECRET = "ssh_g_output_never_kept";
// What the fake `ssh-keygen -y -P ""` answers depends only on these contents.
const KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n-----END OPENSSH PRIVATE KEY-----\n";
const KEY_AFTER_NOTE = `# the bot's deploy key\n${KEY}`;
const PASSPHRASE_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nencrypted\n-----END OPENSSH PRIVATE KEY-----\n";
const UNLOADABLE_KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nloads only with 0600\n-----END RSA PRIVATE KEY-----\n";
const sshHi = (login: string) =>
  `Hi ${login}! You've successfully authenticated, but GitHub does not provide shell access.`;
const SSH_DENIED = "git@github.com: Permission denied (publickey).";
const HELPER_PROMPTS_OFF =
  "f() { exit 1 get: -c: line 1: syntax error: unexpected end of file\nfatal: could not read Username for 'https://github.com': terminal prompts disabled";
const NO_HELPER_PROMPTS_OFF =
  "fatal: could not read Username for 'https://github.com': terminal prompts disabled";

/** A Kin host's `~/.ssh/config` using every allowed directive. */
const USER_SSH_CONFIG = [
  "# Kin bot",
  "Host github.com",
  "  HostName github.com",
  "  User git",
  "  Port 22",
  "  IdentityFile ~/.ssh/id_ed25519 # the bot's key",
  "  IdentitiesOnly yes",
  "  IdentityAgent none",
  "  AddKeysToAgent no",
  "  ControlMaster no",
  "  ControlPath none",
  "  StrictHostKeyChecking yes",
  "  UserKnownHostsFile ~/.ssh/known_hosts",
  "Host *",
  "  ServerAliveInterval=30",
  "  ServerAliveCountMax 3",
  "  ConnectTimeout 10",
  '  COMPRESSION "no"',
  "Include config.d/*.conf",
].join("\n");
/** macOS's `/etc/ssh` as shipped, with relative includes. */
const SYSTEM_SSH = {
  ssh_config: "Include ssh_config.d/*\nHost *\n  SendEnv LANG LC_*\nInclude crypto.conf\n",
  "ssh_config.d/100-macos.conf": "Host *\n  SendEnv LANG\n",
  "crypto.conf": [
    "Ciphers ^aes128-gcm@openssh.com",
    "KexAlgorithms ^ecdh-sha2-nistp256",
    "MACs ^hmac-sha2-256",
    "HostKeyAlgorithms ^ssh-ed25519",
    "PubkeyAcceptedAlgorithms ^ssh-ed25519",
    "CASignatureAlgorithms ^ssh-ed25519",
    "HostbasedAcceptedAlgorithms ^ssh-ed25519",
    "HashKnownHosts yes",
    "GSSAPIAuthentication no",
  ].join("\n"),
};

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
const spawnFailure = (command: string, reason: "NotFound" | "PermissionDenied"): Run =>
  Effect.fail(
    new VcsProcessSpawnError({
      operation: "test",
      command,
      cwd: "/",
      cause: PlatformError.systemError({ _tag: reason, module: "test", method: "spawn" }),
    }),
  );
const missing = (command: string) => spawnFailure(command, "NotFound");
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

/** `git config --list --show-origin -z`; a null value is a bare boolean key. */
type GitEntry = readonly [key: string, value: string | null, origin?: string];
const GIT_FILE = "file:/Users/kin/.gitconfig";
const gitList = (...entries: ReadonlyArray<GitEntry>) =>
  answer({
    stdout: entries
      .map(
        ([key, value, origin]) =>
          `${origin ?? GIT_FILE}\0${key}${value === null ? "" : `\n${value}`}\0`,
      )
      .join(""),
  });
/** A Kin host's git config, with a key from every allowed group. */
const BOT_GIT: ReadonlyArray<GitEntry> = [
  ["credential.helper", "osxkeychain", "file:/Library/Developer/CommandLineTools/gitconfig"],
  ["user.name", "kin-bot"],
  ["user.email", "kin-bot@users.noreply.github.com"],
  ["core.autocrlf", "input"],
  ["core.bare", null],
  ["init.defaultbranch", "main"],
  ["color.ui", "auto"],
  ["alias.st", "status"],
  ["pull.rebase", "true"],
  ["push.autosetupremote", "true"],
  ["fetch.prune", "true"],
  ["merge.conflictstyle", "zdiff3"],
  ["diff.algorithm", "histogram"],
  ["filter.lfs.process", "git-lfs filter-process"],
  ["filter.lfs.required", "true"],
  // `VcsProcess` adds this to every run.
  ["safe.barerepository", "explicit", "command line:"],
];

const session = (
  token: string,
  input: { readonly expiresAt?: number | null; readonly refreshUntil?: number | null } = {},
) =>
  Option.some({
    accessToken: Redacted.make(token),
    accessTokenExpiresAt: input.expiresAt ?? null,
    refreshable: input.refreshUntil !== undefined,
    refreshTokenExpiresAt: input.refreshUntil ?? null,
  });
const stored = (
  input: Partial<T3GitHubCredential.T3StoredCredentials> = {},
): T3GitHubCredential.T3StoredCredentials => ({
  saved: Option.none(),
  app: Option.none(),
  account: Option.none(),
  providerEnvironments: [],
  projectRoots: [],
  ...input,
});
/** What the check asks the git helper about: the owner's login and the merge token's, both cases. */
const OWNER_LOGINS = ["Nishchay", "nishchay"];

/** The machine the probe looks at. Each test changes what one source answers. */
interface Machine {
  t3: T3GitHubCredential.T3StoredCredentials | "uninstalled";
  /** The server's environment; `<home>` stands for the home directory. */
  env: Record<string, string>;
  /** Whether the passwd entry names the home directory. */
  passwdHome: boolean;
  /** The login `GET /user` names for each token; a number is the status, `hang` never answers. */
  users: Record<string, string | number>;
  gh: Run;
  /** `gh auth token`, for the `--user` account or the active one. */
  ghToken: (account: string | undefined) => Run;
  gitConfig: Run;
  git: Run;
  /** `git credential fill` asked for one username. */
  gitFor: (username: string) => Run;
  /** Each project's `git config --local` and `--worktree`, by folder under the temp root. */
  repos: Record<string, { readonly local: Run; readonly worktree?: Run }>;
  /** `ssh -v -G`; by default it names `~/.ssh/config` and the system config when they exist. */
  sshG?: (paths: { readonly home: string; readonly etc: string }) => Run;
  /** Answers one SSH probe; `key` is the `-i` file, or undefined for the probe as is. */
  ssh: (key: string | undefined) => Run;
  /** Files under the home directory, by relative path. */
  files: Record<string, string>;
  /** Files under the system SSH folder, by relative path. */
  system: Record<string, string>;
}

const botMachine = (): Machine => ({
  t3: stored({ app: session(APP_TOKEN) }),
  env: {},
  passwdHome: true,
  users: { [APP_TOKEN]: "kin-bot", [GH_TOKEN]: "kin-bot", [GIT_PASSWORD]: "kin-bot" },
  gh: ghStatus("kin-bot"),
  ghToken: (account) =>
    account === undefined
      ? answer({ stdout: `${GH_TOKEN}\n` })
      : answer({
          exitCode: 1,
          stderr: `no oauth token found for github.com account ${account}\n`,
        }),
  gitConfig: gitList(...BOT_GIT),
  git: gitFill(GIT_PASSWORD),
  gitFor: () => answer({ exitCode: 128, stderr: NO_HELPER_PROMPTS_OFF }),
  repos: {},
  ssh: (key) => answer({ stderr: key === undefined ? sshHi("kin-bot") : SSH_DENIED }),
  files: {
    ".ssh/id_ed25519": KEY,
    ".ssh/id_ed25519.pub": "ssh-ed25519 AAAA kin-bot",
    ".ssh/config": USER_SSH_CONFIG,
    ".ssh/known_hosts": "github.com ssh-ed25519 AAAA\n",
  },
  system: SYSTEM_SSH,
});

/** `botMachine` with `lines` added to `~/.ssh/config`. */
const withSshConfig = (...lines: ReadonlyArray<string>): Partial<Machine> => ({
  files: { ...botMachine().files, ".ssh/config": [USER_SSH_CONFIG, ...lines].join("\n") },
});
/** `botMachine` with `lines` added to `/etc/ssh/ssh_config`. */
const withSystemConfig = (...lines: ReadonlyArray<string>): Partial<Machine> => ({
  system: { ...SYSTEM_SSH, ssh_config: [SYSTEM_SSH.ssh_config, ...lines].join("\n") },
});
const withGit = (...entries: ReadonlyArray<GitEntry>): Partial<Machine> => ({
  gitConfig: gitList(...BOT_GIT, ...entries),
});
/** `botMachine` with one project whose own `git config --local` lists `entries`. */
const withRepo = (...entries: ReadonlyArray<GitEntry>): Partial<Machine> => ({
  t3: stored({ app: session(APP_TOKEN), projectRoots: ["<root>/repo"] }),
  repos: {
    repo: {
      local: gitList(
        ...entries.map(([key, value, origin]): GitEntry => [
          key,
          value,
          origin ?? "file:.git/config",
        ]),
      ),
    },
  },
});
/** `ssh -v -G` naming `files` (under the temp root) after the user's config. */
const sshReads =
  (...files: ReadonlyArray<string>) =>
  ({ home }: { readonly home: string }) =>
    answer({
      stderr: [
        `debug1: Reading configuration data ${home}/.ssh/config`,
        ...files.map((file) => `debug1: Reading configuration data ${home}/../${file}`),
      ].join("\n"),
    });

/** A fake `ssh-keygen -y -P ""`, answering by the file's contents as OpenSSH does. */
const keygen = (fs: FileSystem.FileSystem, file: string): Run =>
  fs.readFileString(file).pipe(
    Effect.option,
    Effect.flatMap((text) => {
      if (Option.isNone(text)) {
        return answer({ exitCode: 255, stderr: `Load key "${file}": Permission denied` });
      }
      if (text.value === KEY || text.value === KEY_AFTER_NOTE) {
        return answer({ stdout: "ssh-ed25519 AAAA\n" });
      }
      const reason =
        text.value === PASSPHRASE_KEY
          ? "incorrect passphrase supplied to decrypt private key"
          : text.value === UNLOADABLE_KEY
            ? "bad permissions"
            : "invalid format";
      return answer({ exitCode: 255, stderr: `Load key "${file}": ${reason}` });
    }),
  );

const writeFiles = (root: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [name, text] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(root, name)), { recursive: true });
      yield* fs.writeFileString(path.join(root, name), text);
    }
  });

/** Builds the live probe over `machine` in a fresh home, and the check over that probe. */
const probe = (machine: Machine) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const home = path.join(root, "home");
    const etc = path.join(root, "etc", "ssh");
    const bin = path.join(root, "bin");
    yield* fs.makeDirectory(path.join(home, ".ssh", "sockets"), { recursive: true });
    yield* writeFiles(home, machine.files);
    yield* writeFiles(etc, machine.system);
    // The ssh agents would run; the fake runner answers for it.
    yield* writeFiles(bin, { ssh: "#!/bin/sh\n" });
    yield* fs.chmod(path.join(bin, "ssh"), 0o755);
    for (const repo of Object.keys(machine.repos)) {
      yield* fs.makeDirectory(path.join(root, repo), { recursive: true });
    }
    const sshG =
      machine.sshG?.({ home, etc }) ??
      answer({
        stdout: "user git\nhostname github.com\n",
        stderr: [
          "OpenSSH_10.5p1, LibreSSL 3.3.6",
          ...(".ssh/config" in machine.files
            ? [`debug1: Reading configuration data ${path.join(home, ".ssh", "config")}`]
            : []),
          ...("ssh_config" in machine.system
            ? [`debug1: Reading configuration data ${path.join(etc, "ssh_config")}`]
            : []),
        ].join("\n"),
      });
    const runs: Array<VcsProcessInput> = [];
    const vcs = VcsProcess.of({
      run: (input) => {
        runs.push(input);
        const [first] = input.args;
        if (input.command === "gh") {
          if (input.args[1] === "status") return machine.gh;
          const user = input.args.find((arg) => arg.startsWith("--user="));
          return machine.ghToken(user?.slice("--user=".length));
        }
        if (input.command === "git") {
          if (first === "-C") {
            const repo = machine.repos[path.relative(root, input.args[1] ?? "")];
            if (repo === undefined) return answer({ exitCode: 128, stderr: "no such repo" });
            return input.args.at(-1) === "--worktree" ? (repo.worktree ?? answer({})) : repo.local;
          }
          if (first === "config") return machine.gitConfig;
          const username = /^username=(.*)$/m.exec(input.stdin ?? "")?.[1];
          return username === undefined ? machine.git : machine.gitFor(username);
        }
        if (input.command === "ssh-keygen") return keygen(fs, input.args.at(-1) ?? "");
        if (input.args.includes("-G")) return sshG;
        const key = input.args.indexOf("-i");
        return machine.ssh(key === -1 ? undefined : input.args[key + 1]);
      },
    });
    const requests: Array<string | undefined> = [];
    const github = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request.headers.authorization);
        const user = machine.users[request.headers.authorization?.replace(/^Bearer /, "") ?? ""];
        if (user === "hang") return Effect.never;
        const body = typeof user === "string" ? { login: user } : { message: "Bad credentials" };
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(body), {
              status: typeof user === "string" ? 200 : (user ?? 401),
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      }),
    );
    const slot = Context.get(
      yield* Layer.build(T3GitHubCredential.slotLayer),
      T3GitHubCredential.T3GitHubCredential,
    );
    if (machine.t3 !== "uninstalled") {
      const t3 = machine.t3;
      const projectRoots = t3.projectRoots.map((dir) => dir.replace("<root>", root));
      yield* slot.install(Effect.succeed({ ...t3, projectRoots }));
    }
    const env = Object.fromEntries(
      Object.entries({ PATH: "<bin>", ...machine.env }).map(([name, value]) => [
        name,
        value.replace("<home>", home).replace("<bin>", bin).replace("<root>", root),
      ]),
    );
    const identity = yield* GitHubIdentityProbe.make.pipe(
      Effect.provideService(VcsProcess, vcs),
      Effect.provideService(HostProcess.PasswdHomeDirectory, machine.passwdHome ? home : null),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(HostProcess.Username, "kin"),
      Effect.provideService(HostProcess.UserId, 501),
      Effect.provideService(T3GitHubCredential.T3GitHubCredential, slot),
      Effect.provide(Layer.mergeAll(github, scopeLayer())),
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
        Layer.provide(Layer.succeed(HostProcess.Environment, {})),
        Layer.provide(scopeLayer()),
      ),
    );
    const check = Context.get(hygiene, CredentialHygiene.CredentialHygiene).check(ORG);
    return {
      identities: identity.identities({ ownerLogins: OWNER_LOGINS }),
      check,
      runs,
      home,
      root,
      bin,
      requests,
      slot,
    };
  });

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const argv = (input: VcsProcessInput) => [input.command, ...input.args];
const SSH_PROBE_OPTIONS = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "PubkeyAuthentication=yes",
  "-o",
  "ConnectTimeout=10",
];

describe("GitHubIdentityProbe", () => {
  it.effect("reports every source, and the check passes with only the bot's login", () =>
    run(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { identities, check, runs, home, root, bin } = yield* probe({
          ...botMachine(),
          env: { HOME: "<home>/" },
          t3: stored({
            app: session(APP_TOKEN),
            projectRoots: ["<root>/repo", "<root>/plain", "<root>/gone"],
            providerEnvironments: [{ instance: "codex", names: ["CODEX_HOME"] }],
          }),
          repos: {
            repo: {
              local: gitList(
                ["core.repositoryformatversion", "0", "file:.git/config"],
                ["user.email", "bot@example.com", "file:.git/config"],
                ["extensions.objectformat", "sha256", "file:.git/config"],
                ["remote.origin.url", "git@github.com:kin/app.git", "file:.git/config"],
                ["extensions.worktreeconfig", "true", "file:.git/config"],
              ),
              worktree: gitList(["core.sparsecheckout", "true", "file:.git/config.worktree"]),
            },
            plain: {
              local: answer({
                exitCode: 128,
                stderr: "fatal: --local can only be used inside a git repository",
              }),
            },
          },
        });
        const found = yield* identities;
        const probed = [...runs];
        assert.deepStrictEqual(found, {
          t3: [
            { login: "kin-bot", source: "app" },
            { login: "kin-bot", source: "gh" },
          ],
          ghAccounts: ["kin-bot"],
          gitCredential: Option.some("kin-bot"),
          gitCredentialFor: [],
          ssh: [sshHi("kin-bot"), SSH_DENIED],
          providerEnvironments: [{ instance: "codex", names: ["CODEX_HOME"] }],
        });
        assert.deepInclude(yield* check, { passed: true, failures: [], reasons: [] });

        const ssh = path.join(home, ".ssh");
        const config = path.join(ssh, "config");
        const sshBin = path.join(bin, "ssh");
        const repoConfig = (repo: string, scope: string) => [
          "git",
          "-C",
          path.join(root, repo),
          "config",
          "--list",
          "--show-origin",
          "-z",
          scope,
        ];
        assert.sameDeepMembers(probed.map(argv), [
          ["gh", "auth", "token", "--hostname", "github.com"],
          // The owner's login: a token for it means the owner is signed in to gh.
          ["gh", "auth", "token", "--hostname", "github.com", "--user=Nishchay"],
          ["gh", "auth", "status", "--hostname", "github.com", "--json", "hosts"],
          ["git", "config", "--list", "--show-origin", "-z"],
          // Once as is, then once per owner username.
          ["git", "credential", "fill"],
          ["git", "credential", "fill"],
          ["git", "credential", "fill"],
          // Each project's own config; `--worktree` only where it's turned on.
          repoConfig("repo", "--local"),
          repoConfig("repo", "--worktree"),
          repoConfig("plain", "--local"),
          // Which files the ssh on PATH reads.
          [sshBin, "-v", "-G", "git@github.com"],
          // Every file in ~/.ssh is offered to ssh-keygen; only loadable private keys are probed.
          ...["config", "id_ed25519", "id_ed25519.pub", "known_hosts"].map((name) => [
            "ssh-keygen",
            "-y",
            "-P",
            "",
            "-f",
            path.join(ssh, name),
          ]),
          // Only the validated config, with no shared connection and no agent (`SSH_AUTH_SOCK`).
          [sshBin, "-F", config, ...SSH_PROBE_OPTIONS, "git@github.com"],
          [
            sshBin,
            "-F",
            config,
            ...SSH_PROBE_OPTIONS,
            "-o",
            "IdentitiesOnly=yes",
            "-i",
            path.join(ssh, "id_ed25519"),
            "git@github.com",
          ],
        ]);
        const envs = {
          gh: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
          git: {
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: "",
            SSH_ASKPASS: "",
            GCM_INTERACTIVE: "never",
          },
          ssh: { SSH_AUTH_SOCK: "", SSH_ASKPASS: "", SSH_ASKPASS_REQUIRE: "never" },
          "ssh-keygen": { SSH_AUTH_SOCK: "", SSH_ASKPASS: "", SSH_ASKPASS_REQUIRE: "never" },
        };
        for (const input of probed) {
          assert.strictEqual(input.cwd, path.parse(home).root);
          assert.isAbove(input.timeoutMs ?? 0, 0);
          // Output past the cap fails the run instead of being cut short.
          assert.strictEqual(input.outputMode, "error");
          assert.strictEqual(input.maxOutputBytes, 64 * 1024);
          assert.deepStrictEqual(
            input.env,
            envs[path.basename(input.command) as keyof typeof envs],
          );
        }
        const fills = probed.filter((input) => input.args[0] === "credential");
        assert.deepStrictEqual(
          fills.map((input) => input.stdin),
          [
            "protocol=https\nhost=github.com\n\n",
            "protocol=https\nhost=github.com\nusername=Nishchay\n\n",
            "protocol=https\nhost=github.com\nusername=nishchay\n\n",
          ],
        );
      }),
    ),
  );

  it.effect("reads no login from sources that have none", () =>
    run(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { identities, check, requests, runs, bin } = yield* probe({
          ...botMachine(),
          // Both of the app session's tokens have lapsed, so GitHub accepts neither.
          t3: stored({ app: session(APP_TOKEN, { expiresAt: NOW - 2, refreshUntil: NOW - 1 }) }),
          ghToken: () => answer({ exitCode: 1, stderr: "no oauth token found for github.com\n" }),
          gh: missing("gh"),
          gitConfig: gitList(["user.name", "kin-bot"]),
          git: answer({ exitCode: 128, stderr: NO_HELPER_PROMPTS_OFF }),
          ssh: () => answer({ stderr: SSH_DENIED }),
          files: {},
          system: { ssh_config: "" },
        });
        assert.deepStrictEqual(yield* identities, {
          t3: [],
          ghAccounts: [],
          gitCredential: Option.none(),
          gitCredentialFor: [],
          ssh: [SSH_DENIED],
          providerEnvironments: [],
        });
        assert.deepInclude(yield* check, { passed: true, identities: [] });
        assert.deepStrictEqual(requests, []);
        // Without a `~/.ssh/config`, the probe reads none at all.
        assert.include(
          runs.map((input) => argv(input).join(" ")),
          [path.join(bin, "ssh"), "-F", "none", ...SSH_PROBE_OPTIONS, "git@github.com"].join(" "),
        );
      }),
    ),
  );

  it.effect("waits for the server to install T3's reader instead of failing at startup", () =>
    run(
      Effect.gen(function* () {
        const { identities, slot } = yield* probe({ ...botMachine(), t3: "uninstalled" });
        const early = yield* Effect.forkChild(identities);
        yield* TestClock.adjust("5 seconds");
        yield* slot.install(Effect.succeed(stored({ app: session(APP_TOKEN) })));
        assert.deepInclude((yield* Fiber.join(early)).t3, { login: "kin-bot", source: "app" });
      }),
    ),
  );

  it.effect.each([
    ["git is not installed", { gitConfig: missing("git") }],
    [
      "a project's own config has only repository keys",
      withRepo(
        ["core.bare", "false"],
        ["core.logallrefupdates", null],
        ["remote.origin.url", "https://github.com/kin/app.git"],
        ["remote.origin.pushurl", "ssh://git@github.com/kin/app.git"],
        ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        ["remote.origin.prune", "true"],
        ["remote.pushdefault", "origin"],
        ["branch.main.remote", "origin"],
        ["branch.main.merge", "refs/heads/main"],
        ["submodule.lib.url", "git@github.com:kin/lib.git"],
        ["submodule.lib.active", "true"],
        ["lfs.repositoryformatversion", "0"],
        ["extensions.worktreeconfig", "false"],
      ),
    ],
    [
      "a project folder is gone or isn't a repository",
      {
        t3: stored({ app: session(APP_TOKEN), projectRoots: ["<root>/gone", "<root>/plain"] }),
        repos: {
          plain: {
            local: answer({
              exitCode: 128,
              stderr: "fatal: --local can only be used inside a git repository",
            }),
          },
        },
      },
    ],
    [
      "ssh is in a later PATH folder, and a Homebrew system config ssh names is allowed",
      {
        env: { PATH: "<root>/empty:<bin>" },
        sshG: sshReads("brew/ssh_config"),
        files: { ...botMachine().files, "../brew/ssh_config": "Host *\n  SendEnv LANG\n" },
      },
    ],
    [
      "a later empty helper resets the list, as `gh auth setup-git` writes it",
      withGit(
        ["credential.https://github.com.helper", ""],
        ["credential.https://github.com.helper", "!gh auth git-credential"],
      ),
    ],
  ] as const)("passes when %s", ([, change]) =>
    run(
      Effect.gen(function* () {
        const { check } = yield* probe({ ...botMachine(), ...change } as Machine);
        assert.deepInclude(yield* check, { passed: true, failures: [] });
      }),
    ),
  );

  const ownerOn = (suffix: string) => (key: string | undefined) =>
    answer({ stderr: key?.endsWith(suffix) === true ? sshHi("Nishchay") : SSH_DENIED });

  it.effect.each([
    [
      "the token saved in Settings, behind a bot app sign-in",
      { t3: stored({ saved: Option.some(Redacted.make(OWNER_TOKEN)), app: session(APP_TOKEN) }) },
    ],
    [
      "the app sign-in, behind a bot token saved in Settings",
      { t3: stored({ saved: Option.some(Redacted.make(GH_TOKEN)), app: session(OWNER_TOKEN) }) },
    ],
    ["GH_TOKEN, which T3 would use", { env: { GH_TOKEN: OWNER_TOKEN } }],
    [
      "a gh keyring token gh auth status no longer lists",
      { ghToken: () => answer({ stdout: OWNER_TOKEN }) },
    ],
    [
      "the gh account Settings picks",
      {
        t3: stored({ app: session(APP_TOKEN), account: Option.some("kin-bot-2") }),
        ghToken: (account: string | undefined) =>
          answer({ stdout: account === "kin-bot-2" ? OWNER_TOKEN : GH_TOKEN }),
      },
    ],
    [
      "a gh token held for the owner's login",
      {
        ghToken: (account: string | undefined) =>
          answer({ stdout: account === "Nishchay" ? OWNER_TOKEN : GH_TOKEN }),
      },
    ],
    ["an inactive gh account", { gh: ghStatus("kin-bot", "Nishchay") }],
    ["the git credential helper", { git: gitFill(OWNER_TOKEN) }],
    [
      "the git helper's second account, asked for by username",
      {
        gitFor: (username: string) =>
          username === "Nishchay"
            ? gitFill(OWNER_TOKEN)
            : answer({ exitCode: 128, stderr: NO_HELPER_PROMPTS_OFF }),
      },
    ],
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
        ssh: ownerOn("owner_ed25519"),
        files: { ...botMachine().files, ".ssh/owner_ed25519": KEY },
      },
    ],
    [
      "a key with a note before its header",
      {
        ssh: ownerOn("owner_rsa"),
        files: { ...botMachine().files, ".ssh/owner_rsa": KEY_AFTER_NOTE },
      },
    ],
    [
      "a key in a folder of ~/.ssh",
      { ssh: ownerOn("work/owner"), files: { ...botMachine().files, ".ssh/work/owner": KEY } },
    ],
    [
      "a key two folders down in ~/.ssh",
      { ssh: ownerOn("a/b/owner"), files: { ...botMachine().files, ".ssh/a/b/owner": KEY } },
    ],
    [
      "a key outside ~/.ssh under a host alias",
      {
        ssh: ownerOn("keys/github_kin_501"),
        files: {
          ...withSshConfig(
            "Host github-owner",
            "  HostName github.com",
            "  IdentityFile %d/keys/github_%u_%i",
          ).files,
          "keys/github_kin_501": KEY,
        },
      },
    ],
    [
      "a key an included file names",
      {
        ssh: ownerOn("keys/included"),
        files: {
          ...botMachine().files,
          ".ssh/config.d/owner.conf": "Host ssh.github.com\n  IdentityFile ~/keys/included\n",
          "keys/included": KEY,
        },
      },
    ],
    [
      "a key the system SSH config names",
      {
        ssh: ownerOn("keys/system"),
        files: { ...botMachine().files, "keys/system": KEY },
        system: {
          ...SYSTEM_SSH,
          "ssh_config.d/200-owner.conf": "Host *\n  IdentityFile %d/keys/system\n",
        },
      },
    ],
  ] as const)("fails as owner_identity when %s is the owner", ([, change]) =>
    run(
      Effect.gen(function* () {
        const machine = { ...botMachine(), ...change } as Machine;
        const { check } = yield* probe({
          ...machine,
          users: { ...botMachine().users, [OWNER_TOKEN]: "Nishchay" },
        });
        const report = yield* check;
        assert.isFalse(report.passed);
        assert.include(report.failures, "owner_identity");
      }),
    ),
  );

  it.effect.each([
    // The host's environment.
    ["$HOME isn't the passwd home", { env: { HOME: "/Users/someone-else" } }, "home: $HOME isn't"],
    [
      "the passwd entry names no home",
      { passwdHome: false },
      "home: the passwd entry names no home",
    ],
    // T3.
    ["T3's reader isn't installed", { t3: "uninstalled" }, "t3: the reader isn't installed"],
    [
      "GitHub refuses T3's credential",
      { users: { [GH_TOKEN]: "kin-bot", [GIT_PASSWORD]: "kin-bot" } },
      "t3: ",
    ],
    [
      "GET /user names no login",
      { users: { ...botMachine().users, [APP_TOKEN]: "" } },
      "t3: GET /user named no login",
    ],
    [
      "GET /user never answers",
      { users: { ...botMachine().users, [APP_TOKEN]: "hang" } },
      "t3: GET /user timed out",
    ],
    [
      "T3's app sign-in needs a refresh to name its login",
      { t3: stored({ app: session(APP_TOKEN, { expiresAt: NOW - 1, refreshUntil: NOW + DAY }) }) },
      "t3: the app sign-in needs a refresh",
    ],
    [
      "gh auth token fails for another reason",
      { ghToken: () => answer({ exitCode: 1, stderr: "error connecting to keyring" }) },
      "t3: gh auth token exited 1",
    ],
    [
      "gh auth token prints nothing",
      { ghToken: () => answer({ stdout: "\n" }) },
      "t3: gh auth token printed no token",
    ],
    // gh.
    ["gh can't be started", { gh: spawnFailure("gh", "PermissionDenied") }, "VcsProcessSpawnError"],
    [
      "gh is too old for --json",
      { gh: answer({ exitCode: 1, stderr: "unknown flag: --json" }) },
      "gh: gh is older than 2.81",
    ],
    [
      "gh auth status says it isn't logged in",
      { gh: answer({ exitCode: 1, stderr: "You are not logged into any GitHub hosts." }) },
      "gh: gh auth status exited 1",
    ],
    [
      "gh answers something else",
      { gh: answer({ stdout: "github.com\n  Logged in" }) },
      "gh: gh auth status --json was unreadable",
    ],
    [
      "a gh account has no login",
      { gh: ghStatus("kin-bot", "") },
      "gh: an account isn't a GitHub login",
    ],
    [
      "a gh login is longer than GitHub allows",
      { gh: ghStatus("kin-bot", "a".repeat(40)) },
      "gh: an account isn't a GitHub login",
    ],
    [
      "a gh login isn't a GitHub login",
      { gh: ghStatus("kin-bot\nApproved actions run") },
      "gh: an account isn't a GitHub login",
    ],
    ["gh times out", { gh: Effect.fail(timeout("gh")) }, "gh: VcsProcessTimeoutError"],
    // git: the process and the helper.
    [
      "git can't be started",
      { gitConfig: spawnFailure("git", "PermissionDenied") },
      "git_credential: VcsProcessSpawnError",
    ],
    [
      "git config fails",
      { gitConfig: answer({ exitCode: 128, stderr: "fatal: bad config" }) },
      "git_credential: git config exited 128",
    ],
    [
      "git config's list is cut short",
      { gitConfig: answer({ stdout: `${GIT_FILE}\0user.name\nkin-bot` }) },
      "git_credential: git config --list was unreadable",
    ],
    [
      "more than one credential helper is configured",
      withGit(["credential.https://github.com.helper", "store"]),
      "git_credential: more than one credential helper",
    ],
    [
      "the configured helper answers nothing",
      { git: answer({ exitCode: 128, stderr: HELPER_PROMPTS_OFF }) },
      "git_credential: git credential fill exited 128",
    ],
    [
      "the helper answers without a password",
      { git: answer({ stdout: "username=kin-bot\n" }) },
      "git_credential: the helper answered without a password",
    ],
    [
      "the helper's password is refused",
      { users: { [APP_TOKEN]: "kin-bot", [GH_TOKEN]: "kin-bot" } },
      "git_credential: ",
    ],
    [
      "GitHub is down for the helper",
      { users: { ...botMachine().users, [GIT_PASSWORD]: 502 } },
      "git_credential: ",
    ],
    // git: keys outside the allowlist. A subsection can hold a URL with a token, so it never shows.
    ...(
      [
        ["include.path", "include.path"],
        ["includeif.gitdir:~/work/.path", "includeif.*.path"],
        ["http.extraheader", "http.extraheader"],
        ["http.https://github.com/.extraheader", "http.*.extraheader"],
        ["url.https://ghp_secret@github.com/.insteadof", "url.*.insteadof"],
        ["credential.username", "credential.username"],
        ["credential.https://github.com.username", "credential.*.username"],
        ["credential.https://gitlab.com.helper", "credential.*.helper"],
        ["core.askpass", "core.askpass"],
        ["core.sshcommand", "core.sshcommand"],
        ["core.gitproxy", "core.gitproxy"],
        ["core.fsmonitor", "core.fsmonitor"],
        ["core.hookspath", "core.hookspath"],
        ["gpg.program", "gpg.program"],
        ["gpg.ssh.program", "gpg.*.program"],
        ["commit.gpgsign", "commit.gpgsign"],
        ["ghp_0123456789abcdef0123456789abcdef01234567.x", "an unrecognised key"],
      ] as const
    ).map(
      ([key, shown]) =>
        [
          `git config sets ${key}`,
          withGit([key, "x"]),
          `git_credential: git config sets ${shown}`,
        ] as const,
    ),
    [
      "git config comes from GIT_CONFIG_PARAMETERS",
      withGit(["user.name", "kin-bot", "command line:"]),
      "git_credential: git config is set from the environment",
    ],
    [
      "git config comes from somewhere other than a file",
      withGit(["user.name", "kin-bot", "blob:HEAD:.gitconfig"]),
      "git_credential: git config comes from an unexpected source",
    ],
    // SSH: directives outside the allowlist, in any case and either form.
    ...(
      [
        ['Match exec "test -d ~/owner"', "Match"],
        ["Match host github.com", "Match"],
        ["ProxyCommand nc %h %p", "ProxyCommand"],
        ["PROXYCOMMAND=nc %h %p", "ProxyCommand"],
        ["ProxyJump bastion", "ProxyJump"],
        ["PKCS11Provider /usr/lib/opensc.so", "PKCS11Provider"],
        ["SecurityKeyProvider internal", "SecurityKeyProvider"],
        ["CertificateFile ~/.ssh/owner-cert.pub", "CertificateFile"],
        ["KnownHostsCommand /bin/cat", "KnownHostsCommand"],
        ["LocalCommand id", "LocalCommand"],
        ["PermitLocalCommand yes", "PermitLocalCommand"],
        ["CanonicalizeHostname yes", "CanonicalizeHostname"],
        ["SendEnv LANG", "SendEnv"],
        ["ghp_0123456789abcdef0123456789abcdef01234567", "an unrecognised directive"],
      ] as const
    ).map(
      ([line, name]) =>
        [
          `~/.ssh/config has ${line}`,
          withSshConfig(line),
          `ssh: ~/.ssh/config sets ${name}`,
        ] as const,
    ),
    ...(
      [
        ["ControlMaster auto", "ControlMaster"],
        ["ControlPath ~/.ssh/sockets/%C", "ControlPath"],
        [
          "IdentityAgent ~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
          "IdentityAgent",
        ],
        ["IdentityAgent SSH_AUTH_SOCK", "IdentityAgent"],
        ["AddKeysToAgent yes", "AddKeysToAgent"],
      ] as const
    ).map(
      ([line, name]) =>
        [
          `~/.ssh/config has ${line}`,
          withSshConfig(line),
          `ssh: ~/.ssh/config sets ${name} to a value other than the allowed one`,
        ] as const,
    ),
    [
      "an included file has a forbidden directive",
      { files: { ...botMachine().files, ".ssh/config.d/work.conf": "ProxyJump bastion\n" } },
      "ssh: ~/.ssh/config sets ProxyJump",
    ],
    [
      "a file included without a glob has a forbidden directive",
      {
        files: {
          ...withSshConfig("Include work").files,
          ".ssh/work": "Host *\n  IdentityAgent /tmp/agent\n",
        },
      },
      "ssh: ~/.ssh/config sets IdentityAgent",
    ],
    [
      "the system SSH config has Match",
      withSystemConfig("Match exec true"),
      "ssh: the system SSH config sets Match",
    ],
    [
      "a file the system SSH config includes has ProxyCommand",
      { system: { ...SYSTEM_SSH, "ssh_config.d/50-proxy.conf": "ProxyCommand nc %h %p\n" } },
      "ssh: the system SSH config sets ProxyCommand",
    ],
    ["a line has no directive", withSshConfig("= yes"), "ssh: ~/.ssh/config can't be parsed"],
    [
      "an Include includes itself",
      withSshConfig("Include config"),
      "ssh: ~/.ssh/config includes too many files",
    ],
    [
      "an Include uses a token",
      withSshConfig("Include %d/.ssh/more"),
      "ssh: an Include names a path the probe can't expand",
    ],
    [
      "an Include names another user's home",
      withSshConfig("Include ~nishchay/.ssh/config"),
      "ssh: an Include names a path the probe can't expand",
    ],
    [
      "an Include globs a folder",
      withSshConfig("Include */config"),
      "ssh: an Include names a path the probe can't expand",
    ],
    [
      "an Include names a folder",
      { files: { ...withSshConfig("Include keys").files, ".ssh/keys/k": KEY } },
      "ssh: ~/.ssh/config includes something that isn't a small file",
    ],
    [
      "~/.ssh/config is too large to check",
      withSshConfig(`# ${"x".repeat(64 * 1024)}`),
      "ssh: ~/.ssh/config includes something that isn't a small file",
    ],
    ...(
      [
        ["~/.ssh/github_%h", "a host token"],
        ["/keys/${USER}/id", "an environment variable"],
        ["~nishchay/.ssh/id", "another user's home"],
        ["keys/id", "a relative path"],
      ] as const
    ).map(
      ([file, what]) =>
        [
          `an IdentityFile uses ${what}`,
          withSshConfig(`IdentityFile ${file}`),
          "ssh: ~/.ssh/config has an IdentityFile the probe can't expand",
        ] as const,
    ),
    // SSH: arguments ssh's argv_split reads differently, which fail closed instead.
    ...(
      [
        ["Include 'config.d/owner conf'", "single quotes"],
        ["Include config.d/owner\\ conf", "a backslash"],
        ['IdentityFile "~/.ssh/a"b', "a quote that runs on"],
        ['IdentityFile a"b', "a quote inside an argument"],
        ['Include "config.d/owner', "an unterminated quote"],
        ["IdentityFile ~/.ssh/a#b", "a # inside an argument"],
      ] as const
    ).map(
      ([line, what]) =>
        [
          `~/.ssh/config uses ${what}`,
          withSshConfig(line),
          "ssh: ~/.ssh/config can't be parsed",
        ] as const,
    ),
    [
      "an Include without a glob names a file that doesn't exist",
      withSshConfig("Include owner.conf"),
      "ssh: ~/.ssh/config names a file that doesn't exist",
    ],
    [
      "a directive ssh doesn't know, which could be a pasted secret",
      withSshConfig("supersecretpassword"),
      "ssh: ~/.ssh/config sets an unrecognised directive",
    ],
    // SSH: the ssh on PATH, and the system config it reads.
    ["ssh isn't on PATH", { env: { PATH: "<root>/empty" } }, "ssh: ssh isn't on PATH"],
    [
      "PATH has a relative folder before ssh",
      { env: { PATH: "bin:<bin>" } },
      "ssh: PATH has a relative folder",
    ],
    [
      "the system config the ssh on PATH reads has ProxyCommand",
      {
        sshG: sshReads("brew/ssh_config"),
        files: { ...botMachine().files, "../brew/ssh_config": "ProxyCommand nc %h %p\n" },
      },
      "ssh: the system SSH config sets ProxyCommand",
    ],
    [
      "a file ssh reads doesn't exist",
      { sshG: sshReads("brew/ssh_config") },
      "ssh: the system SSH config names a file that doesn't exist",
    ],
    [
      "ssh -G names no config file",
      { sshG: () => answer({ stderr: "OpenSSH_10.5p1" }) },
      "ssh: ssh -G named no config",
    ],
    [
      "ssh -G fails",
      { sshG: () => answer({ exitCode: 255, stderr: "Bad configuration option" }) },
      "ssh: ssh -G exited 255",
    ],
    // git: the helper asked for the owner's username.
    [
      "the helper fails when asked for the owner's username",
      { gitFor: () => answer({ exitCode: 1, stderr: "keychain locked" }) },
      "git_credential: git credential fill exited 1",
    ],
    [
      "the helper answers for the owner's username without a password",
      { gitFor: () => answer({ stdout: "protocol=https\nhost=github.com\nusername=Nishchay\n" }) },
      "git_credential: the helper answered without a password",
    ],
    // git: keys only the repository allowlist refuses in the host's config.
    ...(
      [
        ["init.templatedir", "init.templatedir"],
        ["remote.origin.pushurl", "remote.*.pushurl"],
        ["url.core.example.com.insteadof", "url.*.insteadof"],
        ["url.user.example.com.insteadof", "url.*.insteadof"],
        ["filter.crypt.clean", "filter.*.clean"],
      ] as const
    ).map(
      ([key, shown]) =>
        [
          `git config sets ${key}`,
          withGit([key, "x"]),
          `git_credential: git config sets ${shown}`,
        ] as const,
    ),
    // git: a project's own config. A URL with a token never shows.
    ...(
      [
        ["credential.helper", "store", "credential.helper"],
        ["http.extraheader", "AUTHORIZATION: bearer ghp_x", "http.extraheader"],
        ["url.https://ghp_x@github.com/.insteadof", "https://github.com/", "url.*.insteadof"],
        ["include.path", "../owner.gitconfig", "include.path"],
        ["includeif.onbranch:main.path", "x", "includeif.*.path"],
        ["core.sshcommand", "ssh -i ~/owner", "core.sshcommand"],
        ["core.askpass", "/bin/owner", "core.askpass"],
        ["remote.origin.url", "https://x:ghp_secret@github.com/kin/app", "remote.*.url"],
        ["remote.origin.url", "https://ghp_secret@github.com/kin/app", "remote.*.url"],
        ["remote.origin.pushurl", "ssh://git:ghp_secret@github.com/k/a", "remote.*.pushurl"],
        ["remote.origin.url", "ext::sh -c owner", "remote.*.url"],
        ["remote.origin.url", "fd::7", "remote.*.url"],
        ["remote.origin.url", null, "remote.*.url"],
        ["remote.origin.uploadpack", "owner-upload", "remote.*.uploadpack"],
        ["remote.origin.vcs", "owner", "remote.*.vcs"],
        ["submodule.lib.url", "https://ghp_secret@github.com/kin/lib", "submodule.*.url"],
        ["submodule.lib.update", "!owner", "submodule.*.update"],
        ["gc.auto", "0", "gc.auto"],
      ] as const
    ).map(
      ([key, value, shown]) =>
        [
          `a project's own config sets ${key} to ${value ?? "nothing"}`,
          withRepo([key, value]),
          `git_repo: `,
          `repository config sets ${shown}`,
        ] as const,
    ),
    [
      "a project's worktree config sets a helper",
      {
        ...withRepo(["extensions.worktreeconfig", "true"]),
        repos: {
          repo: {
            local: gitList(["extensions.worktreeconfig", "true", "file:.git/config"]),
            worktree: gitList(["credential.helper", "store", "file:.git/config.worktree"]),
          },
        },
      },
      "repository config sets credential.helper",
    ],
    [
      "a project's git can't read it",
      {
        ...withRepo(),
        repos: {
          repo: { local: answer({ exitCode: 128, stderr: "fatal: detected dubious ownership" }) },
        },
      },
      "exited 128",
    ],
    [
      "there are more projects than the probe reads",
      {
        t3: stored({
          app: session(APP_TOKEN),
          projectRoots: Array.from({ length: 65 }, (_, index) => `<root>/p${index}`),
        }),
      },
      "git_repo: more than 64 projects",
    ],
    // SSH: keys and probes.
    [
      "a key needs a passphrase",
      { files: { ...botMachine().files, ".ssh/owner_ed25519": PASSPHRASE_KEY } },
      "ssh: a private key can't be loaded without a passphrase",
    ],
    [
      "a private key ssh won't load",
      { files: { ...botMachine().files, ".ssh/work/owner_rsa": UNLOADABLE_KEY } },
      "ssh: a private key can't be loaded without a passphrase",
    ],
    [
      "~/.ssh holds more than 32 keys",
      {
        files: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`.ssh/key_${index}`, KEY]),
        ),
      },
      "ssh: more than 32 private keys",
    ],
    [
      "an SSH probe times out",
      { ssh: () => Effect.fail(timeout("ssh")) },
      "ssh: VcsProcessTimeoutError",
    ],
  ] as const)("fails closed when %s", ([, change, ...reasons]) =>
    run(
      Effect.gen(function* () {
        const { identities, check } = yield* probe({ ...botMachine(), ...change } as Machine);
        const flipped = yield* Effect.forkChild(Effect.flip(identities));
        yield* TestClock.adjust("1 minute");
        const error = yield* Fiber.join(flipped);
        assert.strictEqual(error._tag, "T3GitHubIdentityError");
        // The fixed reason, so a case can't pass by failing for some other reason.
        for (const reason of reasons) assert.include(String(error.cause), reason);
        assert.notInclude(String(error.cause), "ghp_");
        const checked = yield* Effect.forkChild(check);
        yield* TestClock.adjust("1 minute");
        const report = yield* Fiber.join(checked);
        assert.deepInclude(report, { passed: false, failures: ["identity_unknown"] });
        // The same reason reaches the report, and so the audit entry and the owner's chat.
        assert.deepStrictEqual(report.reasons, [String(error.cause)]);
        assert.include(credentialCheckBody(ORG, report), String(error.cause));
      }),
    ),
  );

  it.effect("runs the first executable ssh on PATH for every probe", () =>
    run(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { identities, runs, bin } = yield* probe({
          ...botMachine(),
          env: { PATH: "<root>/noexec:<bin>" },
          // Not executable, so ssh wouldn't run it.
          files: { ...botMachine().files, "../noexec/ssh": "#!/bin/sh\n" },
        });
        yield* identities;
        const ssh = runs.filter((input) => path.basename(input.command) === "ssh");
        assert.isAbove(ssh.length, 2);
        for (const input of ssh) assert.strictEqual(input.command, path.join(bin, "ssh"));
      }),
    ),
  );

  it.effect("asks ssh which files it reads only after the user's config passes", () =>
    run(
      Effect.gen(function* () {
        const { identities, runs } = yield* probe({
          ...botMachine(),
          ...withSshConfig("ProxyJump bastion"),
        });
        yield* identities.pipe(Effect.flip);
        assert.isFalse(runs.some((input) => input.args.includes("-G")));
      }),
    ),
  );

  it.effect.each([
    // Search-only, so `~/.ssh/config` still reads but the folder can't be listed.
    ["~/.ssh can't be listed", ".ssh", 0o100],
    ["a key can't be read", ".ssh/id_ed25519", 0o000],
  ] as const)("fails closed when %s", ([reason, locked, mode]) =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { identities, home } = yield* probe(botMachine());
        yield* fs.chmod(path.join(home, locked), mode);
        const error = yield* identities.pipe(Effect.flip);
        yield* fs.chmod(path.join(home, locked), 0o700);
        assert.strictEqual(error._tag, "T3GitHubIdentityError");
        assert.include(String(error.cause), reason);
      }),
    ),
  );

  it.effect("never puts a credential in a log, error, span, report, audit entry or chat", () => {
    const logged: Array<string> = [];
    const logger = Logger.make(({ message, cause }) => {
      logged.push(JSON.stringify(message), String(cause));
    });
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const secrets = [GIT_PASSWORD, GH_TOKEN, APP_TOKEN, SAVED_TOKEN, OWNER_TOKEN, SSH_G_SECRET];
    return run(
      Effect.gen(function* () {
        const seen: Array<string> = [];
        const t3 = stored({
          saved: Option.some(Redacted.make(SAVED_TOKEN)),
          app: session(APP_TOKEN),
        });
        const users = {
          ...botMachine().users,
          [SAVED_TOKEN]: "kin-bot",
          [OWNER_TOKEN]: "Nishchay",
        };
        const ghToken = (account: string | undefined) =>
          answer({ stdout: account === "Nishchay" ? OWNER_TOKEN : GH_TOKEN });
        // A helper holding the owner's account too, and `ssh -G` printing config values.
        const gitFor = () => gitFill(OWNER_TOKEN);
        const sshG = ({ home, etc }: { readonly home: string; readonly etc: string }) =>
          answer({
            stdout: `identityfile ~/.ssh/${SSH_G_SECRET}\n`,
            stderr: [
              `debug1: ${SSH_G_SECRET}`,
              `debug1: Reading configuration data ${home}/.ssh/config`,
              `debug1: Reading configuration data ${etc}/ssh_config`,
            ].join("\n"),
          });
        for (const [index, change] of [
          {},
          // Each credential refused in turn, so its error path runs too.
          { users: { ...users, [GIT_PASSWORD]: 500 } },
          { users: { ...users, [GH_TOKEN]: 401 } },
          { users: { ...users, [SAVED_TOKEN]: 401 } },
          { users: { ...users, [OWNER_TOKEN]: 502 } },
        ].entries()) {
          const { identities, check, requests } = yield* probe({
            ...botMachine(),
            t3,
            users,
            ghToken,
            gitFor,
            sshG,
            ...change,
          });
          const result = yield* Effect.result(identities);
          const report = yield* check;
          seen.push(
            JSON.stringify(result),
            String(result),
            JSON.stringify(report),
            // What the executor writes to the audit log and posts to the owner's chat.
            report.failures.join(","),
            credentialCheckBody(ORG, report),
          );
          yield* Effect.logWarning("probe", result);
          // Each does reach GitHub, as a bearer token and nowhere else.
          if (index === 0) {
            for (const secret of secrets.filter((value) => value !== SSH_G_SECRET)) {
              assert.include(requests, `Bearer ${secret}`);
            }
          }
        }
        for (const span of spans) {
          seen.push(
            span.name,
            JSON.stringify([...span.attributes]),
            JSON.stringify(span.events),
            span.status._tag === "Ended" ? String(span.status.exit) : "",
          );
        }
        assert.isAbove(spans.length, 0);
        const haystack = [...seen, ...logged].join("\n");
        assert.include(haystack, "owner_identity");
        for (const secret of secrets) assert.notInclude(haystack, secret);
      }).pipe(
        Effect.withTracer(tracer),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });
});

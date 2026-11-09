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
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/http";
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
const APP_TOKEN = "ghu_t3_app_token";
const GH_TOKEN = "gho_gh_keyring_token";
const OWNER_TOKEN = "gho_owner_token";
const GIT_PASSWORD = "gho_git_helper_password_never_logged";
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
/** `ssh -G git@github.com` as OpenSSH prints it: identity files unexpanded. */
const sshG = (...extra: ReadonlyArray<string>) =>
  answer({
    stdout: [
      "user git",
      "hostname github.com",
      "port 22",
      ...extra,
      "identityfile ~/.ssh/id_rsa",
      "identityfile ~/.ssh/id_ed25519",
      "addkeystoagent false",
    ].join("\n"),
  });
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
  ...input,
});

/** The machine the probe looks at. Each test changes what one source answers. */
interface Machine {
  t3: T3GitHubCredential.T3StoredCredentials | "uninstalled";
  env: Record<string, string>;
  /** The login `GET /user` names for each token; a number is the status, `hang` never answers. */
  users: Record<string, string | number>;
  gh: Run;
  /** `gh auth token`, for the `--user` account or the active one. */
  ghToken: (account: string | undefined) => Run;
  gitHelpers: Run;
  git: Run;
  sshConfig: Run;
  /** Answers one SSH probe; `key` is the `-i` file, or undefined for the probe as is. */
  ssh: (key: string | undefined) => Run;
  /** Files under the home directory, by relative path. */
  files: Record<string, string>;
}

const botMachine = (): Machine => ({
  t3: stored({ app: session(APP_TOKEN) }),
  env: {},
  users: { [APP_TOKEN]: "kin-bot", [GH_TOKEN]: "kin-bot", [GIT_PASSWORD]: "kin-bot" },
  gh: ghStatus("kin-bot"),
  ghToken: () => answer({ stdout: `${GH_TOKEN}\n` }),
  gitHelpers: answer({ stdout: "credential.helper osxkeychain\n" }),
  git: gitFill(GIT_PASSWORD),
  sshConfig: sshG(),
  ssh: (key) => answer({ stderr: key === undefined ? sshHi("kin-bot") : SSH_DENIED }),
  files: {
    ".ssh/id_ed25519": KEY,
    ".ssh/id_ed25519.pub": "ssh-ed25519 AAAA kin-bot",
    ".ssh/config": "Host *\n",
    ".ssh/known_hosts": "github.com ssh-ed25519 AAAA\n",
  },
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

/** Builds the live probe over `machine` in a fresh home, and the check over that probe. */
const probe = (machine: Machine) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(home, ".ssh", "sockets"), { recursive: true });
    for (const [name, text] of Object.entries(machine.files)) {
      yield* fs.makeDirectory(path.dirname(path.join(home, name)), { recursive: true });
      yield* fs.writeFileString(path.join(home, name), text);
    }
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
        if (input.command === "git") return first === "config" ? machine.gitHelpers : machine.git;
        if (input.command === "ssh-keygen") return keygen(fs, input.args.at(-1) ?? "");
        if (first === "-G") return machine.sshConfig;
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
    if (machine.t3 !== "uninstalled") yield* slot.install(Effect.succeed(machine.t3));
    const identity = yield* GitHubIdentityProbe.make.pipe(
      Effect.provideService(VcsProcess, vcs),
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, machine.env),
      Effect.provideService(HostProcess.Username, "kin"),
      Effect.provideService(HostProcess.UserId, 501),
      Effect.provideService(T3GitHubCredential.T3GitHubCredential, slot),
      Effect.provide(github),
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
    return { identities: identity.identities, check, runs, home, requests, slot };
  });

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const argv = (input: VcsProcessInput) => [input.command, ...input.args];

describe("GitHubIdentityProbe", () => {
  it.effect("reports every source, and the check passes with only the bot's login", () =>
    run(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { identities, check, runs, home } = yield* probe(botMachine());
        const found = yield* identities;
        const probed = [...runs];
        assert.deepStrictEqual(found, {
          t3: [
            { login: "kin-bot", source: "app" },
            { login: "kin-bot", source: "gh" },
          ],
          ghAccounts: ["kin-bot"],
          gitCredential: Option.some("kin-bot"),
          ssh: [sshHi("kin-bot"), SSH_DENIED],
        });
        assert.deepInclude(yield* check, { passed: true, failures: [] });

        const ssh = path.join(home, ".ssh");
        assert.sameDeepMembers(probed.map(argv), [
          ["gh", "auth", "token", "--hostname", "github.com"],
          ["gh", "auth", "status", "--hostname", "github.com", "--json", "hosts"],
          ["git", "config", "--get-regexp", "^credential(\\..+)?\\.helper$"],
          ["git", "credential", "fill"],
          ["ssh", "-G", "git@github.com"],
          // Every file in ~/.ssh is offered to ssh-keygen; only loadable private keys are probed.
          ...["config", "id_ed25519", "id_ed25519.pub", "known_hosts"].map((name) => [
            "ssh-keygen",
            "-y",
            "-P",
            "",
            "-f",
            path.join(ssh, name),
          ]),
          [...CredentialHygiene.GITHUB_SSH_PROBE],
          [
            ...CredentialHygiene.GITHUB_SSH_PROBE.slice(0, -1),
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
          assert.deepStrictEqual(input.env, envs[input.command as keyof typeof envs]);
        }
        const git = probed.find((input) => input.args[0] === "credential");
        assert.strictEqual(git?.stdin, "protocol=https\nhost=github.com\n\n");
      }),
    ),
  );

  it.effect("reads no login from sources that have none", () =>
    run(
      Effect.gen(function* () {
        const { identities, check, requests } = yield* probe({
          ...botMachine(),
          // Both of the app session's tokens have lapsed, so GitHub accepts neither.
          t3: stored({ app: session(APP_TOKEN, { expiresAt: NOW - 2, refreshUntil: NOW - 1 }) }),
          ghToken: () => answer({ exitCode: 1, stderr: "no oauth token found for github.com\n" }),
          gh: missing("gh"),
          gitHelpers: answer({ exitCode: 1 }),
          git: answer({ exitCode: 128, stderr: NO_HELPER_PROMPTS_OFF }),
          ssh: () => answer({ stderr: SSH_DENIED }),
          files: {},
        });
        assert.deepStrictEqual(yield* identities, {
          t3: [],
          ghAccounts: [],
          gitCredential: Option.none(),
          ssh: [SSH_DENIED],
        });
        assert.deepInclude(yield* check, { passed: true, identities: [] });
        assert.deepStrictEqual(requests, []);
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
        t3: stored({ app: session(APP_TOKEN), account: Option.some("Nishchay") }),
        ghToken: (account: string | undefined) =>
          answer({ stdout: account === "Nishchay" ? OWNER_TOKEN : GH_TOKEN }),
      },
    ],
    ["an inactive gh account", { gh: ghStatus("kin-bot", "Nishchay") }],
    ["the git credential helper", { git: gitFill(OWNER_TOKEN) }],
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
        files: { ...botMachine().files, ".ssh/owner_ed25519": KEY },
      },
    ],
    [
      "a key with a note before its header",
      {
        ssh: (key: string | undefined) =>
          answer({ stderr: key?.endsWith("owner_rsa") === true ? sshHi("Nishchay") : SSH_DENIED }),
        files: { ...botMachine().files, ".ssh/owner_rsa": KEY_AFTER_NOTE },
      },
    ],
    [
      "a key in a folder of ~/.ssh",
      {
        ssh: (key: string | undefined) =>
          answer({ stderr: key?.endsWith("work/owner") === true ? sshHi("Nishchay") : SSH_DENIED }),
        files: { ...botMachine().files, ".ssh/work/owner": KEY },
      },
    ],
    [
      "a key outside ~/.ssh that ~/.ssh/config names for github.com",
      {
        sshConfig: sshG("identityfile %d/keys/github_%r_%u"),
        ssh: (key: string | undefined) =>
          answer({
            stderr: key?.endsWith("keys/github_git_kin") === true ? sshHi("Nishchay") : SSH_DENIED,
          }),
        files: { ...botMachine().files, "keys/github_git_kin": KEY },
      },
    ],
  ] as const)("fails as owner_identity when %s is the owner", ([, change]) =>
    run(
      Effect.gen(function* () {
        const { check } = yield* probe({
          ...botMachine(),
          ...change,
          users: { ...botMachine().users, [OWNER_TOKEN]: "Nishchay" },
        } as Machine);
        const report = yield* check;
        assert.isFalse(report.passed);
        assert.include(report.failures, "owner_identity");
      }),
    ),
  );

  it.effect.each([
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
    [
      "git can't be started",
      { gitHelpers: spawnFailure("git", "PermissionDenied") },
      "git_credential: VcsProcessSpawnError",
    ],
    [
      "git config fails",
      { gitHelpers: answer({ exitCode: 128, stderr: "fatal: bad config" }) },
      "git_credential: git config exited 128",
    ],
    [
      "more than one credential helper is configured",
      {
        gitHelpers: answer({
          stdout: "credential.helper store\ncredential.https://github.com.helper osxkeychain\n",
        }),
      },
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
    [
      "~/.ssh/config sets an IdentityAgent",
      {
        sshConfig: sshG(
          "identityagent /Users/kin/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
        ),
      },
      "ssh: an IdentityAgent is configured",
    ],
    [
      "~/.ssh/config sets a PKCS#11 provider",
      { sshConfig: sshG("pkcs11provider /usr/lib/opensc.so") },
      "ssh: a PKCS#11 provider is configured",
    ],
    [
      "an IdentityFile has a token the probe can't expand",
      { sshConfig: sshG("identityfile ~/.ssh/%C") },
      "ssh: an IdentityFile can't be expanded",
    ],
    [
      "an IdentityFile names another user's home",
      { sshConfig: sshG("identityfile ~nishchay/.ssh/id") },
      "ssh: an IdentityFile can't be expanded",
    ],
    [
      "ssh -G fails",
      { sshConfig: answer({ exitCode: 255, stderr: "line 2: Bad configuration option" }) },
      "ssh: ssh -G exited 255",
    ],
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
  ] as const)("fails closed when %s", ([, change, reason]) =>
    run(
      Effect.gen(function* () {
        const { identities, check } = yield* probe({ ...botMachine(), ...change } as Machine);
        const flipped = yield* Effect.forkChild(Effect.flip(identities));
        yield* TestClock.adjust("1 minute");
        const error = yield* Fiber.join(flipped);
        assert.strictEqual(error._tag, "T3GitHubIdentityError");
        // The fixed reason, so a case can't pass by failing for some other reason.
        assert.include(String(error.cause), reason);
        const checked = yield* Effect.forkChild(check);
        yield* TestClock.adjust("1 minute");
        assert.deepInclude(yield* Fiber.join(checked), {
          passed: false,
          failures: ["identity_unknown"],
        });
      }),
    ),
  );

  it.effect.each([
    // With no identity file from `ssh -G`, only the listing touches ~/.ssh.
    ["~/.ssh can't be listed", ".ssh", answer({ stdout: "user git\nhostname github.com\n" })],
    ["a key can't be read", ".ssh/id_ed25519", sshG()],
  ] as const)("fails closed when %s", ([reason, locked, sshConfig]) =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { identities, home } = yield* probe({ ...botMachine(), sshConfig });
        yield* fs.chmod(path.join(home, locked), 0o000);
        const error = yield* identities.pipe(Effect.flip);
        yield* fs.chmod(path.join(home, locked), 0o700);
        assert.strictEqual(error._tag, "T3GitHubIdentityError");
        assert.include(String(error.cause), reason);
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
          botMachine().users,
          { [APP_TOKEN]: "kin-bot", [GH_TOKEN]: "kin-bot" },
          { ...botMachine().users, [GIT_PASSWORD]: 500 },
        ]) {
          const { identities, check, requests } = yield* probe({ ...botMachine(), users });
          const result = yield* Effect.result(identities);
          seen.push(JSON.stringify(result), String(result), JSON.stringify(yield* check));
          yield* Effect.logWarning("probe", result);
          // It does reach GitHub, as a bearer token and nowhere else.
          assert.include(requests, `Bearer ${GIT_PASSWORD}`);
        }
        const haystack = [...seen, ...logged].join("\n");
        assert.include(haystack, "git_credential");
        assert.notInclude(haystack, GIT_PASSWORD);
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
    );
  });
});

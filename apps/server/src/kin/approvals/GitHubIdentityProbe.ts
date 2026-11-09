import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import { VcsProcess, type VcsProcessInput } from "../../vcs/VcsProcess.ts";
import { gitHubJson } from "../github/githubRest.ts";
import { KinGitHubScope } from "../github/KinGitHubScope.ts";
import {
  GITHUB_SSH_PROBE,
  T3GitHubIdentity,
  T3GitHubIdentityError,
  type T3GitHubIdentities,
} from "./CredentialHygiene.ts";
import {
  checkGitConfig,
  checkRepoGitConfig,
  expandIdentityFile,
  parseGitConfigList,
  parseSshConfig,
  sshConfigPaths,
  sshViolation,
} from "./HostConfigAllowlist.ts";
import { T3GitHubCredential, type T3StoredCredentials } from "./T3GitHubCredential.ts";

const HOST = "github.com";
const PROCESS_TIMEOUT_MS = 15_000;
// `GITHUB_SSH_PROBE` gives up connecting after 10 seconds; this also covers the handshake.
const SSH_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_SSH_KEYS = 32;
const MAX_SSH_FILES = 128;
/** `~/.ssh` and this many levels of folders below it. */
const SSH_DIR_DEPTH = 2;
const MAX_KEY_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SSH_CONFIG_FILES = 32;
const MAX_SSH_CONFIG_BYTES = 64 * 1024;
const MAX_PROJECT_ROOTS = 64;
const GLOB = /[*?[]/;
// Below `VcsProcess`'s four slots for non-git commands, which T3's own gh runs share.
const SSH_CONCURRENCY = 2;
const PRIVATE_KEY_MARKER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
// GitHub logins are at most 39 characters; managed users add `_shortcode` within that.
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const GH_NO_TOKEN = /^no oauth token found for github\.com( account \S+)?$/;
const GH_TOKEN_NAMES = ["GH_TOKEN", "GITHUB_TOKEN"];

// Every probe runs non-interactively: a prompt would hang until the timeout.
const GH_ENV = { GH_DEBUG: "", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GCM_INTERACTIVE: "never",
};
// Without the agent, each key answers for itself (`CredentialHygiene` fails on the agent anyway).
const SSH_ENV = { SSH_AUTH_SOCK: "", SSH_ASKPASS: "", SSH_ASKPASS_REQUIRE: "never" };

/** Names the source and a fixed reason only: process output can hold a credential. */
const unreadable = (source: string, reason: string) =>
  new T3GitHubIdentityError({ cause: `${source}: ${reason}` });

const isMissingCommand = (error: { readonly _tag: string; readonly cause?: unknown }) =>
  error._tag === "VcsProcessSpawnError" &&
  error.cause instanceof PlatformError.PlatformError &&
  error.cause.reason._tag === "NotFound";

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const GitHubUser = Schema.Struct({ login: Schema.String });
const GhAuthStatus = Schema.fromJsonString(
  Schema.Struct({
    hosts: Schema.Record(Schema.String, Schema.Array(Schema.Struct({ login: Schema.String }))),
  }),
);
const decodeGhAuthStatus = Schema.decodeUnknownOption(GhAuthStatus);

/**
 * `GITHUB_SSH_PROBE` with the ssh on PATH, reading only the user config the probe validated
 * (`none` without one). With `key`, ssh offers it before any other, so GitHub answers for that key.
 */
const sshProbe = (ssh: string, config: string, key?: string) => [
  ssh,
  "-F",
  config,
  ...GITHUB_SSH_PROBE.slice(1, -1),
  ...(key === undefined ? [] : ["-o", "IdentitiesOnly=yes", "-i", key]),
  ...GITHUB_SSH_PROBE.slice(-1),
];

/**
 * The live `T3GitHubIdentity` (spec section 12). It reports what each source answers and leaves
 * judging it to `CredentialHygiene`; any source it can't read fails the whole probe.
 */
export const make = Effect.gen(function* () {
  const vcs = yield* VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const t3Credential = yield* T3GitHubCredential;
  const { ownerLogin } = yield* KinGitHubScope;
  // ssh reads `~/.ssh` from the passwd entry while git and gh follow `$HOME`; `homeMatches` checks they agree.
  const home = (yield* HostProcess.PasswdHomeDirectory) ?? "";
  const environment = yield* HostProcess.Environment;
  const username = yield* HostProcess.Username;
  const userId = yield* HostProcess.UserId;

  // From the filesystem root, outside any repository, so no repository config picks the helper.
  const cwd = path.parse(path.resolve(home || "/")).root;

  const homeMatches = Effect.suspend(() => {
    if (home === "") return Effect.fail(unreadable("home", "the passwd entry names no home"));
    const env = environment.HOME;
    return env === undefined || path.resolve(env) === path.resolve(home)
      ? Effect.void
      : Effect.fail(unreadable("home", "$HOME isn't the passwd entry's home"));
  });
  const run = (
    input: Pick<
      VcsProcessInput,
      "operation" | "command" | "args" | "env" | "stdin" | "timeoutMs" | "concurrency"
    >,
  ) =>
    vcs.run({
      ...input,
      cwd,
      allowNonZeroExit: true,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      outputMode: "error",
    });

  const loginOf = (source: string, token: Redacted.Redacted<string>) =>
    gitHubJson({
      client,
      operation: `identity.${source}.user`,
      method: "GET",
      path: "/user",
      token,
      schema: GitHubUser,
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(unreadable(source, "GET /user timed out")),
      }),
      // A refused credential reaches no one today, but its holder can't be named: fail closed.
      Effect.mapError((error) =>
        error._tag === "T3GitHubIdentityError" ? error : unreadable(source, error.message),
      ),
      Effect.map((response) => response.body.login.trim()),
      Effect.filterOrFail(
        (login) => login !== "",
        () => unreadable(source, "GET /user named no login"),
      ),
    );

  /** `gh auth token`, which also reads keyring tokens that `gh auth status` no longer lists. */
  const ghToken = (account: string | undefined) =>
    run({
      operation: "KinGitHubIdentity.ghToken",
      command: "gh",
      args: [
        "auth",
        "token",
        "--hostname",
        HOST,
        ...(account === undefined ? [] : [`--user=${account}`]),
      ],
      env: GH_ENV,
      timeoutMs: PROCESS_TIMEOUT_MS,
      concurrency: { key: "gh", limit: 4 },
    }).pipe(
      Effect.catch((error) =>
        isMissingCommand(error) ? Effect.succeed(null) : Effect.fail(unreadable("t3", error._tag)),
      ),
      Effect.flatMap((output) => {
        if (output === null) return Effect.succeedNone;
        if (output.exitCode !== 0) {
          return GH_NO_TOKEN.test(output.stderr.trim())
            ? Effect.succeedNone
            : Effect.fail(unreadable("t3", `gh auth token exited ${output.exitCode}`));
        }
        const token = output.stdout.trim();
        return token === ""
          ? Effect.fail(unreadable("t3", "gh auth token printed no token"))
          : Effect.succeedSome(Redacted.make(token));
      }),
    );

  /** Every credential T3 holds, whichever it would pick and whether or not the host is enabled. */
  const t3 = Effect.fn("KinGitHubIdentity.t3")(function* (stored: T3StoredCredentials) {
    const now = yield* Clock.currentTimeMillis;
    const tokens: Array<{ readonly source: string; readonly token: Redacted.Redacted<string> }> =
      [];
    if (Option.isSome(stored.saved)) tokens.push({ source: "settings", token: stored.saved.value });
    if (Option.isSome(stored.app)) {
      const app = stored.app.value;
      if (app.accessTokenExpiresAt === null || now < app.accessTokenExpiresAt) {
        tokens.push({ source: "app", token: app.accessToken });
      } else if (
        app.refreshable &&
        (app.refreshTokenExpiresAt === null || now < app.refreshTokenExpiresAt)
      ) {
        // Refreshing here would spend the single-use refresh token T3 itself relies on.
        return yield* unreadable("t3", "the app sign-in needs a refresh to name its login");
      }
    }
    const fromEnv = GH_TOKEN_NAMES.map((name) => environment[name]?.trim() ?? "").find(
      (value) => value !== "",
    );
    if (fromEnv !== undefined) tokens.push({ source: "env", token: Redacted.make(fromEnv) });
    // The active account, the one Settings picks, and the owner's, which a token there makes present.
    const named = [...Option.toArray(stored.account), ownerLogin].filter(
      (account, index, all) =>
        all.findIndex((other) => other.toLowerCase() === account.toLowerCase()) === index,
    );
    for (const account of [undefined, ...named]) {
      const token = yield* ghToken(account);
      if (Option.isSome(token)) tokens.push({ source: "gh", token: token.value });
    }
    return yield* Effect.forEach(tokens, ({ source, token }) =>
      loginOf("t3", token).pipe(Effect.map((login) => ({ login, source }))),
    );
  });

  // `--json` lists every account, active or not, and exits 0 whatever their state (gh 2.81+).
  const ghAccounts = run({
    operation: "KinGitHubIdentity.gh",
    command: "gh",
    args: ["auth", "status", "--hostname", HOST, "--json", "hosts"],
    env: GH_ENV,
    timeoutMs: PROCESS_TIMEOUT_MS,
    // The key `GitHubCredentials` uses, so Kin's gh runs share its throttle.
    concurrency: { key: "gh", limit: 4 },
  }).pipe(
    Effect.catch((error) =>
      isMissingCommand(error) ? Effect.succeed(null) : Effect.fail(unreadable("gh", error._tag)),
    ),
    Effect.flatMap((output) => {
      if (output === null) return Effect.succeed<ReadonlyArray<string>>([]);
      if (output.exitCode !== 0) {
        return Effect.fail(
          unreadable(
            "gh",
            /unknown flag: --json/.test(output.stderr)
              ? "gh is older than 2.81"
              : `gh auth status exited ${output.exitCode}`,
          ),
        );
      }
      return Option.match(decodeGhAuthStatus(output.stdout), {
        onNone: () => Effect.fail(unreadable("gh", "gh auth status --json was unreadable")),
        onSome: (status) => {
          const logins = Object.entries(status.hosts)
            .filter(([host]) => host.trim().toLowerCase() === HOST)
            .flatMap(([, accounts]) => accounts.map((account) => account.login.trim()));
          // A login GitHub couldn't have issued could be anything; it never reaches the chat.
          return logins.every((login) => GITHUB_LOGIN.test(login))
            ? Effect.succeed<ReadonlyArray<string>>(logins)
            : Effect.fail(unreadable("gh", "an account isn't a GitHub login"));
        },
      });
    }),
  );

  /**
   * Every key git reads from `/`, checked against the allowlist: how many credential helpers it
   * would call for github.com, or null when git isn't installed.
   */
  const gitHelpers = run({
    operation: "KinGitHubIdentity.gitConfig",
    command: "git",
    args: ["config", "--list", "--show-origin", "-z"],
    env: GIT_ENV,
    timeoutMs: PROCESS_TIMEOUT_MS,
  }).pipe(
    Effect.catch((error) =>
      isMissingCommand(error)
        ? Effect.succeed(null)
        : Effect.fail(unreadable("git_credential", error._tag)),
    ),
    Effect.flatMap((output) => {
      if (output === null) return Effect.succeed(null);
      if (output.exitCode !== 0) {
        return Effect.fail(unreadable("git_credential", `git config exited ${output.exitCode}`));
      }
      const entries = parseGitConfigList(output.stdout);
      if (entries === null) {
        return Effect.fail(unreadable("git_credential", "git config --list was unreadable"));
      }
      const checked = checkGitConfig(entries);
      return checked._tag === "refused"
        ? Effect.fail(unreadable("git_credential", checked.reason))
        : Effect.succeed(checked.helpers);
    }),
  );

  const fill = (username?: string) =>
    run({
      operation: "KinGitHubIdentity.gitCredential",
      command: "git",
      args: ["credential", "fill"],
      stdin: `protocol=https\nhost=${HOST}\n${username === undefined ? "" : `username=${username}\n`}\n`,
      env: GIT_ENV,
      timeoutMs: PROCESS_TIMEOUT_MS,
    }).pipe(
      Effect.mapError((error) => unreadable("git_credential", error._tag)),
      Effect.map((output) => {
        const line = output.stdout.split("\n").find((entry) => entry.startsWith("password="));
        const password = line?.slice("password=".length).replace(/\r$/, "") ?? "";
        return {
          exitCode: output.exitCode,
          // git falls back to a terminal prompt, which is off, when no helper answers.
          promptsOff: /terminal prompts disabled/i.test(output.stderr),
          password: password === "" ? Option.none() : Option.some(Redacted.make(password)),
        };
      }),
    );

  /**
   * The login behind `git credential fill` for github.com, and which of `ownerLogins` the helper
   * also holds a password for: one helper can keep several accounts, and answers for the one asked.
   * The passwords stay in this pipeline: each is wrapped at once and only the first goes to GitHub.
   */
  const gitCredential = Effect.fn("KinGitHubIdentity.gitCredential")(function* (
    ownerLogins: ReadonlyArray<string>,
  ) {
    const helpers = yield* gitHelpers;
    if (helpers === null) return { login: Option.none<string>(), ownerHeld: [] };
    // `git credential fill` answers with the first helper's credential and hides the rest.
    if (helpers > 1) {
      return yield* unreadable("git_credential", "more than one credential helper is configured");
    }
    const answer = yield* fill();
    let login = Option.none<string>();
    if (answer.exitCode !== 0) {
      // With a helper configured, prompts being off also covers a crashed, locked or refusing one.
      if (!answer.promptsOff || helpers !== 0) {
        return yield* unreadable("git_credential", `git credential fill exited ${answer.exitCode}`);
      }
    } else if (Option.isNone(answer.password)) {
      return yield* unreadable("git_credential", "the helper answered without a password");
    } else {
      login = Option.some(yield* loginOf("git_credential", answer.password.value));
    }
    const ownerHeld: Array<string> = [];
    for (const username of ownerLogins) {
      if (!GITHUB_LOGIN.test(username)) {
        return yield* unreadable("git_credential", "an owner login isn't a GitHub login");
      }
      const held = yield* fill(username);
      // Asked for one account, prompts being off means the helper has none for it.
      if (held.exitCode !== 0 && held.promptsOff) continue;
      if (held.exitCode !== 0) {
        return yield* unreadable("git_credential", `git credential fill exited ${held.exitCode}`);
      }
      if (Option.isNone(held.password)) {
        return yield* unreadable("git_credential", "the helper answered without a password");
      }
      ownerHeld.push(username);
    }
    return { login, ownerHeld };
  });

  const repoConfig = (root: string, scope: "--local" | "--worktree") =>
    run({
      operation: "KinGitHubIdentity.repoConfig",
      command: "git",
      args: ["-C", root, "config", "--list", "--show-origin", "-z", scope],
      env: GIT_ENV,
      timeoutMs: PROCESS_TIMEOUT_MS,
    }).pipe(Effect.mapError((error) => unreadable("git_repo", error._tag)));

  /**
   * Each project's own git config, which agents working there read on top of the host's, checked
   * against the repository allowlist. A folder that's gone or isn't a repository has none.
   */
  const repositories = Effect.fn("KinGitHubIdentity.repositories")(function* (
    roots: ReadonlyArray<string>,
  ) {
    if (roots.length > MAX_PROJECT_ROOTS) {
      return yield* unreadable("git_repo", `more than ${MAX_PROJECT_ROOTS} projects`);
    }
    for (const root of roots) {
      const info = yield* fs.stat(root).pipe(
        Effect.asSome,
        Effect.catch((error) =>
          isNotFound(error)
            ? Effect.succeedNone
            : Effect.fail(unreadable("git_repo", `${root} can't be read`)),
        ),
      );
      if (Option.isNone(info) || info.value.type !== "Directory") continue;
      const scopes = ["--local", "--worktree"] as const;
      for (const scope of scopes) {
        const output = yield* repoConfig(root, scope);
        if (
          scope === "--local" &&
          output.exitCode !== 0 &&
          /--local can only be used inside a git repository/.test(output.stderr)
        ) {
          break;
        }
        if (output.exitCode !== 0) {
          return yield* unreadable("git_repo", `git config in ${root} exited ${output.exitCode}`);
        }
        const entries = parseGitConfigList(output.stdout);
        if (entries === null) {
          return yield* unreadable("git_repo", `git config in ${root} was unreadable`);
        }
        const checked = checkRepoGitConfig(entries);
        if (checked._tag === "refused") {
          return yield* unreadable("git_repo", `${root}: ${checked.reason}`);
        }
        if (!checked.worktreeConfig) break;
      }
    }
  });

  /** The files an `Include` pattern names, globbing its last path segment as ssh does. */
  const includeTargets = Effect.fn("KinGitHubIdentity.sshInclude")(function* (
    pattern: string,
    base: string,
  ) {
    const tilde = pattern === "~" || pattern.startsWith("~/") ? home + pattern.slice(1) : pattern;
    const full = path.isAbsolute(tilde) ? tilde : path.join(base, tilde);
    const dir = path.dirname(full);
    const name = path.basename(full);
    if (tilde.startsWith("~") || /%|\$\{/.test(full) || GLOB.test(dir) || name.includes("[")) {
      return yield* unreadable("ssh", "an Include names a path the probe can't expand");
    }
    if (!GLOB.test(name)) return { glob: false, files: [full] };
    const matcher = new RegExp(
      `^${name
        .replace(/[.+^$(){}|\\\]]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".")}$`,
    );
    const names = yield* fs
      .readDirectory(dir)
      .pipe(
        Effect.catch((error) =>
          isNotFound(error)
            ? Effect.succeed<Array<string>>([])
            : Effect.fail(unreadable("ssh", "an Include's folder can't be listed")),
        ),
      );
    // Like glob(3), `*` doesn't match a leading dot.
    const files = names
      .filter((entry) => (name.startsWith(".") || !entry.startsWith(".")) && matcher.test(entry))
      .toSorted()
      .map((entry) => path.join(dir, entry));
    return { glob: true, files };
  });

  /**
   * Reads one SSH config and every file it includes against the allowlist, and returns each
   * `IdentityFile` it names under any `Host`, or null when the file doesn't exist.
   */
  const readSshConfig = Effect.fn("KinGitHubIdentity.readSshConfig")(function* (
    top: string,
    options: {
      readonly system: boolean;
      /** Where relative includes resolve: `~/.ssh` for the user's config, ssh's own for the system's. */
      readonly base: string;
      readonly mustExist: boolean;
    },
  ) {
    const { system, base } = options;
    const label = system ? "the system SSH config" : "~/.ssh/config";
    const identityFiles: Array<string> = [];
    const files: Array<string> = [];
    let read = 0;
    const visit = Effect.fn("KinGitHubIdentity.readSshConfigFile")(function* (
      file: string,
      mustExist: boolean,
    ): Effect.fn.Return<boolean, T3GitHubIdentityError> {
      const info = yield* fs.stat(file).pipe(
        Effect.asSome,
        Effect.catch((error) =>
          isNotFound(error)
            ? Effect.succeedNone
            : Effect.fail(unreadable("ssh", `${label} can't be read`)),
        ),
      );
      // ssh skips a glob that matches nothing; a missing named file may be one ssh finds elsewhere.
      if (Option.isNone(info)) {
        return mustExist
          ? yield* unreadable("ssh", `${label} names a file that doesn't exist`)
          : false;
      }
      files.push(file);
      read += 1;
      // Each nested level reads a file, so this bounds the depth too.
      if (read > MAX_SSH_CONFIG_FILES) {
        return yield* unreadable("ssh", `${label} includes too many files`);
      }
      if (info.value.type !== "File" || Number(info.value.size) > MAX_SSH_CONFIG_BYTES) {
        return yield* unreadable("ssh", `${label} includes something that isn't a small file`);
      }
      const text = yield* fs
        .readFileString(file)
        .pipe(Effect.mapError(() => unreadable("ssh", `${label} can't be read`)));
      const directives = parseSshConfig(text);
      if (directives === null) return yield* unreadable("ssh", `${label} can't be parsed`);
      for (const directive of directives) {
        const violation = sshViolation(directive, system);
        if (violation !== undefined) return yield* unreadable("ssh", `${label} ${violation}`);
        if (directive.keyword === "identityfile") {
          for (const value of directive.args) {
            if (value.toLowerCase() === "none") continue;
            const expanded = expandIdentityFile(value, {
              home,
              username,
              ...(userId === undefined ? {} : { userId }),
            });
            if (expanded === undefined) {
              return yield* unreadable(
                "ssh",
                `${label} has an IdentityFile the probe can't expand`,
              );
            }
            identityFiles.push(expanded);
          }
        }
        if (directive.keyword === "include") {
          for (const pattern of directive.args) {
            const targets = yield* includeTargets(pattern, base);
            for (const target of targets.files) yield* visit(target, !targets.glob);
          }
        }
      }
      return true;
    });
    const exists = yield* visit(top, options.mustExist);
    return { exists, identityFiles, files };
  });

  const isRegularFile = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.catch((error) =>
        isNotFound(error)
          ? Effect.succeed(false)
          : Effect.fail(unreadable("ssh", "a key can't be read")),
      ),
    );

  /** Regular files in `~/.ssh` and its folders, to `SSH_DIR_DEPTH` levels. */
  const sshDirFiles = Effect.gen(function* () {
    const files: Array<string> = [];
    const walk = Effect.fn("KinGitHubIdentity.listSshDir")(function* (
      dir: string,
      depth: number,
    ): Effect.fn.Return<void, T3GitHubIdentityError> {
      const names = yield* fs
        .readDirectory(dir)
        .pipe(
          Effect.catch((error) =>
            depth === 0 && isNotFound(error)
              ? Effect.succeed<Array<string>>([])
              : Effect.fail(unreadable("ssh", "~/.ssh can't be listed")),
          ),
        );
      for (const name of names.toSorted()) {
        const file = path.join(dir, name);
        const info = yield* fs.stat(file).pipe(
          Effect.asSome,
          Effect.catch((error) =>
            isNotFound(error)
              ? Effect.succeedNone
              : Effect.fail(unreadable("ssh", "~/.ssh can't be listed")),
          ),
        );
        if (Option.isNone(info)) continue;
        if (info.value.type === "Directory" && depth < SSH_DIR_DEPTH) {
          yield* walk(file, depth + 1);
        } else if (info.value.type === "File") {
          files.push(file);
          if (files.length > MAX_SSH_FILES) {
            return yield* unreadable("ssh", `more than ${MAX_SSH_FILES} files in ~/.ssh`);
          }
        }
      }
    });
    yield* walk(path.join(home, ".ssh"), 0);
    return files;
  });

  /**
   * Whether `file` is a private key ssh can offer. `ssh-keygen -y -P ""` loads it as ssh does,
   * with no passphrase; a file it can't load that still holds a private key fails closed.
   */
  const isUsableKey = Effect.fn("KinGitHubIdentity.isUsableKey")(function* (file: string) {
    if (!(yield* isRegularFile(file))) return false;
    const loaded = yield* run({
      operation: "KinGitHubIdentity.sshKey",
      command: "ssh-keygen",
      args: ["-y", "-P", "", "-f", file],
      env: SSH_ENV,
      timeoutMs: PROCESS_TIMEOUT_MS,
    }).pipe(Effect.mapError((error) => unreadable("ssh", error._tag)));
    if (loaded.exitCode === 0) return true;
    const size = yield* fs.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.mapError(() => unreadable("ssh", "a key can't be read")),
    );
    if (size > MAX_KEY_FILE_BYTES)
      return yield* unreadable("ssh", "a file in ~/.ssh is too large to check");
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError(() => unreadable("ssh", "a key can't be read")));
    if (PRIVATE_KEY_MARKER.test(text) || /incorrect passphrase/.test(loaded.stderr)) {
      return yield* unreadable("ssh", "a private key can't be loaded without a passphrase");
    }
    return false;
  });

  const sshAnswer = (argv: ReadonlyArray<string>) =>
    run({
      operation: "KinGitHubIdentity.ssh",
      command: argv[0]!,
      args: argv.slice(1),
      env: SSH_ENV,
      timeoutMs: SSH_TIMEOUT_MS,
    }).pipe(
      Effect.mapError((error) => unreadable("ssh", error._tag)),
      Effect.map((output) =>
        [output.stdout, output.stderr].filter((text) => text !== "").join("\n"),
      ),
    );

  /**
   * The ssh agents run: the first on PATH, as an absolute path. Homebrew, MacPorts and Nix builds
   * each read their own system config, so the probe asks this one which files it reads.
   */
  const resolveSsh = Effect.gen(function* () {
    for (const dir of (environment.PATH ?? "").split(":")) {
      // An agent in another folder would find a different ssh.
      if (!path.isAbsolute(dir)) return yield* unreadable("ssh", "PATH has a relative folder");
      const candidate = path.join(dir, "ssh");
      const info = yield* fs.stat(candidate).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "File" && (info.value.mode & 0o111) !== 0) {
        return candidate;
      }
    }
    return yield* unreadable("ssh", "ssh isn't on PATH");
  });

  /** The files `ssh -v -G` reads, from its path lines only: its other output is never kept. */
  const sshConfigFiles = (ssh: string) =>
    run({
      operation: "KinGitHubIdentity.sshConfigFiles",
      command: ssh,
      args: ["-v", "-G", "git@github.com"],
      env: SSH_ENV,
      timeoutMs: PROCESS_TIMEOUT_MS,
    }).pipe(
      Effect.mapError((error) => unreadable("ssh", error._tag)),
      Effect.flatMap((output) => {
        if (output.exitCode !== 0) {
          return Effect.fail(unreadable("ssh", `ssh -G exited ${output.exitCode}`));
        }
        const files = sshConfigPaths(output.stderr);
        // Every ssh reads a system config, so none listed means the output wasn't understood.
        if (files.length === 0) return Effect.fail(unreadable("ssh", "ssh -G named no config"));
        if (files.length > MAX_SSH_CONFIG_FILES) {
          return Effect.fail(unreadable("ssh", "ssh -G named too many config files"));
        }
        return Effect.succeed(files);
      }),
    );

  const ssh = Effect.gen(function* () {
    const sshPath = yield* resolveSsh;
    const userConfig = path.join(home, ".ssh", "config");
    const fromUser = yield* readSshConfig(userConfig, {
      system: false,
      base: path.join(home, ".ssh"),
      mustExist: false,
    });
    // Asked only after the user's config passed, since `-G` evaluates it.
    const reported = yield* sshConfigFiles(sshPath);
    const seen = new Set(fromUser.files);
    const systemFiles = reported.filter((file) => !seen.has(file));
    const named = [...fromUser.identityFiles];
    for (const file of systemFiles) {
      if (seen.has(file)) continue;
      // Agents' ssh reads these after the user's config; the probe's `-F` skips them, so their
      // keys go by `-i`. Relative includes resolve against the main system config's folder.
      const fromSystem = yield* readSshConfig(file, {
        system: true,
        base: path.dirname(systemFiles[0]!),
        mustExist: true,
      });
      for (const read of fromSystem.files) seen.add(read);
      named.push(...fromSystem.identityFiles);
    }
    const files = [...new Set([...named, ...(yield* sshDirFiles)])];
    const usable = yield* Effect.forEach(files, isUsableKey, { concurrency: SSH_CONCURRENCY });
    const keys = files.filter((_, index) => usable[index]);
    if (keys.length > MAX_SSH_KEYS) {
      return yield* unreadable("ssh", `more than ${MAX_SSH_KEYS} private keys`);
    }
    const config = fromUser.exists ? userConfig : "none";
    const plain = yield* sshAnswer(sshProbe(sshPath, config));
    const perKey = yield* Effect.forEach(keys, (key) => sshAnswer(sshProbe(sshPath, config, key)), {
      concurrency: SSH_CONCURRENCY,
    });
    return [plain, ...perKey];
  });

  return T3GitHubIdentity.of({
    // T3's credentials first: until the server installs its reader, nothing is spawned.
    identities: Effect.fn("KinGitHubIdentity.identities")(function* ({ ownerLogins }) {
      yield* homeMatches;
      const stored = yield* t3Credential.read.pipe(
        Effect.mapError((error) => unreadable("t3", error.reason)),
      );
      const t3Identities = yield* t3(stored);
      const rest = yield* Effect.all(
        {
          ghAccounts,
          git: gitCredential(ownerLogins),
          repositories: repositories(stored.projectRoots),
          ssh,
        },
        { concurrency: "unbounded" },
      );
      return {
        t3: t3Identities,
        ghAccounts: rest.ghAccounts,
        gitCredential: rest.git.login,
        gitCredentialFor: rest.git.ownerHeld,
        ssh: rest.ssh,
        providerEnvironments: stored.providerEnvironments,
      } satisfies T3GitHubIdentities;
    }),
  });
});

export const layer = Layer.effect(T3GitHubIdentity, make);

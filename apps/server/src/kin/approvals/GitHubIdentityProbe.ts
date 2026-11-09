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
import {
  GITHUB_SSH_PROBE,
  T3GitHubIdentity,
  T3GitHubIdentityError,
  type T3GitHubIdentities,
} from "./CredentialHygiene.ts";
import { T3GitHubCredential } from "./T3GitHubCredential.ts";

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

/** `GITHUB_SSH_PROBE` offering only `key`, so GitHub answers for that key alone. */
const sshProbeWithKey = (key: string) => [
  ...GITHUB_SSH_PROBE.slice(0, -1),
  "-o",
  "IdentitiesOnly=yes",
  "-i",
  key,
  ...GITHUB_SSH_PROBE.slice(-1),
];

/** `ssh -G` prints `key value` lines with lower-case keys. */
const sshOptions = (text: string) =>
  text.split("\n").flatMap((line) => {
    const match = /^(\S+) (.*)$/.exec(line.replace(/\r$/, ""));
    return match === null ? [] : [{ key: match[1]!.toLowerCase(), value: match[2]! }];
  });

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
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const username = yield* HostProcess.Username;
  const userId = yield* HostProcess.UserId;

  // From the filesystem root, outside any repository, so no repository config picks the helper.
  const cwd = path.parse(home).root;
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
  const t3 = Effect.gen(function* () {
    const stored = yield* t3Credential.read.pipe(
      Effect.mapError((error) => unreadable("t3", error.reason)),
    );
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
    for (const account of [undefined, ...Option.toArray(stored.account)]) {
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

  /** Every configured helper, for any URL: null when git isn't installed. */
  const gitHelpers = run({
    operation: "KinGitHubIdentity.gitHelpers",
    command: "git",
    args: ["config", "--get-regexp", "^credential(\\..+)?\\.helper$"],
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
      // `git config` exits 1 when nothing matches.
      if (output.exitCode === 1 && output.stdout.trim() === "") return Effect.succeed([]);
      if (output.exitCode !== 0) {
        return Effect.fail(unreadable("git_credential", `git config exited ${output.exitCode}`));
      }
      // An empty value resets the list rather than naming a helper.
      return Effect.succeed(
        output.stdout
          .split("\n")
          .map((line) => line.replace(/^\S+/, "").trim())
          .filter((value) => value !== ""),
      );
    }),
  );

  // The password stays in this pipeline: it is wrapped at once, sent to GitHub and dropped.
  const gitCredential = Effect.gen(function* () {
    const helpers = yield* gitHelpers;
    if (helpers === null) return Option.none<string>();
    // `git credential fill` answers with the first helper's credential and hides the rest.
    if (helpers.length > 1) {
      return yield* unreadable("git_credential", "more than one credential helper is configured");
    }
    const output = yield* run({
      operation: "KinGitHubIdentity.gitCredential",
      command: "git",
      args: ["credential", "fill"],
      stdin: `protocol=https\nhost=${HOST}\n\n`,
      env: GIT_ENV,
      timeoutMs: PROCESS_TIMEOUT_MS,
    }).pipe(Effect.mapError((error) => unreadable("git_credential", error._tag)));
    if (output.exitCode !== 0) {
      // git falls back to a terminal prompt, which is off, when no helper answers. With a helper
      // configured that also covers a crashed, locked or refusing one, so it can't mean none.
      if (/terminal prompts disabled/i.test(output.stderr) && helpers.length === 0) {
        return Option.none<string>();
      }
      return yield* unreadable("git_credential", `git credential fill exited ${output.exitCode}`);
    }
    const line = output.stdout.split("\n").find((entry) => entry.startsWith("password="));
    const password = line?.slice("password=".length).replace(/\r$/, "") ?? "";
    if (password === "") {
      return yield* unreadable("git_credential", "the helper answered without a password");
    }
    return Option.some(yield* loginOf("git_credential", Redacted.make(password)));
  });

  /** `ssh -G`'s answer for github.com: the identity files it lists, and no agent or token. */
  const sshConfig = Effect.gen(function* () {
    const output = yield* run({
      operation: "KinGitHubIdentity.sshConfig",
      command: "ssh",
      args: ["-G", "git@github.com"],
      env: SSH_ENV,
      timeoutMs: PROCESS_TIMEOUT_MS,
    }).pipe(Effect.mapError((error) => unreadable("ssh", error._tag)));
    if (output.exitCode !== 0) {
      return yield* unreadable("ssh", `ssh -G exited ${output.exitCode}`);
    }
    const options = sshOptions(output.stdout);
    const option = (key: string) => options.find((entry) => entry.key === key)?.value;
    // `SSH_AUTH_SOCK` is the variable the probe empties; any other agent holds unseen keys.
    const agent = option("identityagent");
    if (agent !== undefined && agent !== "none" && agent !== "SSH_AUTH_SOCK") {
      return yield* unreadable("ssh", "an IdentityAgent is configured for github.com");
    }
    const pkcs11 = option("pkcs11provider");
    if (pkcs11 !== undefined && pkcs11 !== "none") {
      return yield* unreadable("ssh", "a PKCS#11 provider is configured for github.com");
    }
    // `ssh -G` prints identity files as written, with `~` and `%` tokens unexpanded.
    const tokens: Record<string, string | undefined> = {
      "%": "%",
      d: home,
      h: option("hostname"),
      n: HOST,
      p: option("port"),
      r: option("user"),
      u: username ?? undefined,
      i: userId === undefined ? undefined : String(userId),
    };
    const files: Array<string> = [];
    for (const { key, value } of options) {
      if (key !== "identityfile" || value === "none") continue;
      const tilde = value === "~" || value.startsWith("~/") ? home + value.slice(1) : value;
      let known = !tilde.startsWith("~") && !tilde.includes("${");
      const expanded = tilde.replace(/%(.?)/g, (_, token: string) => {
        const replacement = tokens[token];
        if (replacement === undefined) known = false;
        return replacement ?? "";
      });
      if (!known) return yield* unreadable("ssh", "an IdentityFile can't be expanded");
      files.push(path.resolve(cwd, expanded));
    }
    return files;
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
      command: argv[0] ?? "ssh",
      args: argv.slice(1),
      env: SSH_ENV,
      timeoutMs: SSH_TIMEOUT_MS,
    }).pipe(
      Effect.mapError((error) => unreadable("ssh", error._tag)),
      Effect.map((output) =>
        [output.stdout, output.stderr].filter((text) => text !== "").join("\n"),
      ),
    );

  const ssh = Effect.gen(function* () {
    const files = [...new Set([...(yield* sshConfig), ...(yield* sshDirFiles)])];
    const usable = yield* Effect.forEach(files, isUsableKey, { concurrency: SSH_CONCURRENCY });
    const keys = files.filter((_, index) => usable[index]);
    if (keys.length > MAX_SSH_KEYS) {
      return yield* unreadable("ssh", `more than ${MAX_SSH_KEYS} private keys`);
    }
    const plain = yield* sshAnswer(GITHUB_SSH_PROBE);
    const perKey = yield* Effect.forEach(keys, (key) => sshAnswer(sshProbeWithKey(key)), {
      concurrency: SSH_CONCURRENCY,
    });
    return [plain, ...perKey];
  });

  return T3GitHubIdentity.of({
    // T3's credentials first: until the server installs its reader, nothing is spawned.
    identities: Effect.gen(function* () {
      const t3Identities = yield* t3;
      const rest = yield* Effect.all(
        { ghAccounts, gitCredential, ssh },
        { concurrency: "unbounded" },
      );
      return { t3: t3Identities, ...rest } satisfies T3GitHubIdentities;
    }).pipe(Effect.withSpan("KinGitHubIdentity.identities")),
  });
});

export const layer = Layer.effect(T3GitHubIdentity, make);

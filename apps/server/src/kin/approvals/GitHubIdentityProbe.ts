import * as HostProcess from "@t3tools/shared/HostProcess";
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
import { GITHUB_SSH_PROBE, T3GitHubIdentity, T3GitHubIdentityError } from "./CredentialHygiene.ts";
import { T3GitHubCredential } from "./T3GitHubCredential.ts";

const HOST = "github.com";
const PROCESS_TIMEOUT_MS = 15_000;
// `GITHUB_SSH_PROBE` gives up connecting after 10 seconds; this also covers the handshake.
const SSH_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_SSH_KEYS = 32;
// Below `VcsProcess`'s four slots for non-git commands, which T3's own gh runs share.
const SSH_CONCURRENCY = 2;
const KEY_HEADER_BYTES = 64;
const PRIVATE_KEY_HEADER = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

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

  const t3 = t3Credential.read.pipe(
    Effect.mapError((error) => unreadable("t3", error.reason)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (held) =>
          loginOf("t3", held.token).pipe(
            Effect.map((login) => Option.some({ login, source: held.source })),
          ),
      }),
    ),
  );

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
        return /not logged in/i.test(output.stderr)
          ? Effect.succeed<ReadonlyArray<string>>([])
          : Effect.fail(
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
          return logins.includes("")
            ? Effect.fail(unreadable("gh", "an account has no login"))
            : Effect.succeed<ReadonlyArray<string>>(logins);
        },
      });
    }),
  );

  // The password stays in this pipeline: it is wrapped at once, sent to GitHub and dropped.
  const gitCredential = run({
    operation: "KinGitHubIdentity.gitCredential",
    command: "git",
    args: ["credential", "fill"],
    stdin: `protocol=https\nhost=${HOST}\n\n`,
    env: GIT_ENV,
    timeoutMs: PROCESS_TIMEOUT_MS,
  }).pipe(
    Effect.catch((error) =>
      isMissingCommand(error)
        ? Effect.succeed(null)
        : Effect.fail(unreadable("git_credential", error._tag)),
    ),
    Effect.flatMap((output) => {
      if (output === null) return Effect.succeed(Option.none<Redacted.Redacted<string>>());
      // With no helper answering, git falls back to a terminal prompt, which is turned off.
      if (output.exitCode !== 0) {
        return /terminal prompts disabled/i.test(output.stderr)
          ? Effect.succeed(Option.none<Redacted.Redacted<string>>())
          : Effect.fail(
              unreadable("git_credential", `git credential fill exited ${output.exitCode}`),
            );
      }
      const line = output.stdout.split("\n").find((entry) => entry.startsWith("password="));
      const password = line?.slice("password=".length).replace(/\r$/, "") ?? "";
      return password === ""
        ? Effect.fail(unreadable("git_credential", "the helper answered without a password"))
        : Effect.succeedSome(Redacted.make(password));
    }),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (password) => loginOf("git_credential", password).pipe(Effect.asSome),
      }),
    ),
  );

  /**
   * Regular files in `~/.ssh` that start like a private key, by their first bytes only. Keys
   * named only by `IdentityFile` under another `Host` alias in `~/.ssh/config`, or kept outside
   * `~/.ssh`, aren't found, so a login reachable only through them isn't probed.
   */
  const privateKeys = Effect.gen(function* () {
    const dir = path.join(home, ".ssh");
    const names = yield* fs
      .readDirectory(dir)
      .pipe(
        Effect.catch((error) =>
          isNotFound(error)
            ? Effect.succeed<Array<string>>([])
            : Effect.fail(unreadable("ssh", "~/.ssh can't be listed")),
        ),
      );
    const keys: Array<string> = [];
    for (const name of names.toSorted()) {
      if (name.endsWith(".pub")) continue;
      const file = path.join(dir, name);
      const unreadableKey = (error: PlatformError.PlatformError) =>
        isNotFound(error)
          ? Effect.succeed(false)
          : Effect.fail(unreadable("ssh", `~/.ssh/${name} can't be read`));
      const isFile = yield* fs.stat(file).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.catch(unreadableKey),
      );
      if (!isFile) continue;
      const isKey = yield* fs.open(file, { flag: "r" }).pipe(
        Effect.flatMap((handle) => handle.readAlloc(KEY_HEADER_BYTES)),
        Effect.map(
          Option.match({
            onNone: () => false,
            onSome: (bytes) => PRIVATE_KEY_HEADER.test(new TextDecoder().decode(bytes)),
          }),
        ),
        Effect.scoped,
        Effect.catch(unreadableKey),
      );
      if (isKey) keys.push(file);
    }
    if (keys.length > MAX_SSH_KEYS) {
      return yield* unreadable("ssh", `more than ${MAX_SSH_KEYS} private keys in ~/.ssh`);
    }
    return keys;
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
    const keys = yield* privateKeys;
    const plain = yield* sshAnswer(GITHUB_SSH_PROBE);
    const perKey = yield* Effect.forEach(keys, (key) => sshAnswer(sshProbeWithKey(key)), {
      concurrency: SSH_CONCURRENCY,
    });
    return [plain, ...perKey];
  });

  return T3GitHubIdentity.of({
    // T3's credential first: until the server installs its reader, nothing is spawned.
    identities: Effect.gen(function* () {
      const t3Identity = yield* t3;
      const rest = yield* Effect.all(
        { ghAccounts, gitCredential, ssh },
        { concurrency: "unbounded" },
      );
      return { t3: t3Identity, ...rest };
    }).pipe(Effect.withSpan("KinGitHubIdentity.identities")),
  });
});

export const layer = Layer.effect(T3GitHubIdentity, make);

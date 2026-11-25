import {
  KinChatError,
  type KinGitHubAccount,
  type KinGitHubConnectInput,
  type KinGitHubInput,
  type KinGitHubSignIn,
  type KinGitHubStatus,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as GitHubClient from "@t3tools/source-control-github/shared/definition";

import { ServerSettingsService } from "../../serverSettings.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { KinGhTool } from "./ghTool.ts";

/**
 * GitHub as the owner's own login on the host (repos-rethink design, slice 1). The server drives
 * `gh auth login` with a code the owner enters on GitHub, or a token he pasted; then
 * `gh auth setup-git` lets git use it, and the token is saved as T3's own GitHub token. `gh`
 * keeps the login where it always does: the OS keyring, or `hosts.yml` in its config folder.
 */

const HOST = "github.com";
const DEVICE_URL = "https://github.com/login/device";
/** GitHub's device codes last 15 minutes; gh gives up a little after. */
const CODE_LIFETIME_MS = 15 * 60_000;
const SIGN_IN_LIMIT = "16 minutes";
const ACCOUNT_TTL_MS = 60_000;
const MAX_OUTPUT = 512 * 1024;
/** What Kin keeps of one run's output, and whether it was cut. */
export const cappedOutput = (out: string) =>
  out.length > MAX_OUTPUT
    ? { out: out.slice(0, MAX_OUTPUT), truncated: true as const }
    : { out };
const LOGIN_ARGS = ["auth", "login", "--hostname", HOST, "--git-protocol", "https"];
/** `workflow` lets agents change CI files too; gh adds `repo`, `read:org` and `gist`. */
const DEVICE_ARGS = [...LOGIN_ARGS, "--web", "--scopes", "workflow"];

type People = ReadonlyArray<PersonIdentity>;

const fail = (reason: KinChatError["reason"], message: string) =>
  new KinChatError({ reason, message });
const notFound = fail("not_found", "Kin couldn't find that connection.");
const notOwner = fail("not_allowed", "Only the owner or a co-owner manages connections.");
const isChatError = Schema.is(KinChatError);

/** The code and page in gh's sign-in output, in either way gh words it. */
export const deviceCodeOf = (output: string): { code: string; url: string } | null => {
  const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(output)?.[1];
  if (code === undefined) return null;
  const url = /(https:\/\/[^\s]+\/login\/device)\b/.exec(output)?.[1] ?? DEVICE_URL;
  return { code, url };
};

/** Never repeat anything token-shaped, whatever gh printed. */
const scrub = (text: string) =>
  text
    .replace(/\b(gh[opusr]_|github_pat_)[A-Za-z0-9_]+/g, "[token]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/** Why a sign-in didn't finish, in the owner's words, from what gh said. */
export const signInFailure = (output: string): string => {
  const text = output.toLowerCase();
  if (text.includes("expired"))
    return "The code expired before GitHub was authorized. Connect again for a new code.";
  if (text.includes("access_denied") || text.includes("access denied"))
    return "The sign-in was declined on GitHub. Connect again if that wasn't meant.";
  if (text.includes("bad credentials") || text.includes("401"))
    return "GitHub didn't accept that token. Check it was copied whole and hasn't expired.";
  const scope = /missing required scope '([^']+)'/i.exec(output)?.[1];
  if (scope !== undefined)
    return `That token is missing the ${scope} scope. Make one with repo, read:org and workflow.`;
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && !deviceCodeOf(entry))
    .at(-1);
  return line === undefined
    ? "GitHub sign-in didn't finish."
    : `GitHub sign-in didn't finish: ${scrub(line)}`;
};

/** The scopes in `gh api -i user`'s headers. */
const scopesOf = (output: string) =>
  (/^x-oauth-scopes:\s*(.*)$/im.exec(output)?.[1] ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);

export class KinGitHubLogin extends Context.Service<
  KinGitHubLogin,
  {
    readonly status: (
      people: People,
      input: KinGitHubInput,
    ) => Effect.Effect<KinGitHubStatus, KinChatError>;
    readonly start: (
      people: People,
      input: KinGitHubConnectInput,
    ) => Effect.Effect<KinGitHubStatus, KinChatError>;
    readonly cancel: (
      people: People,
      input: KinGitHubInput,
    ) => Effect.Effect<KinGitHubStatus, KinChatError>;
    readonly disconnect: (
      people: People,
      input: KinGitHubInput,
    ) => Effect.Effect<KinGitHubStatus, KinChatError>;
    /** The connected login, for Kin's own use; no person is checked. */
    readonly account: () => Effect.Effect<KinGitHubAccount | null>;
    /** The folder with the `gh` Kin signs in with, for an agent session's PATH. */
    readonly ghDirectory: string;
    /** Whether gh holds a login; never fetches gh, so a host that never connected stays quiet. */
    readonly connected: () => Effect.Effect<boolean>;
    /** One `gh` run as the connected login: its exit code and output. Kin's GitHub watch reads with it. */
    readonly gh: (
      args: ReadonlyArray<string>,
      stdin?: string,
    ) => Effect.Effect<{
      readonly code: number;
      readonly out: string;
      /** The output ran past what Kin keeps of one run, and was cut there. */
      readonly truncated?: true;
    }>;
  }
>()("t3/kin/connections/GitHubLogin/KinGitHubLogin") {}

const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(
      (cause): cause is Exclude<E, KinChatError> => !isChatError(cause),
      (cause) =>
        Effect.logWarning("Kin's GitHub connection failed", { cause }).pipe(
          Effect.andThen(Effect.fail(fail("unavailable", "Kin couldn't reach its GitHub login."))),
        ),
    ),
  );

interface Pending {
  readonly signIn: KinGitHubSignIn;
  readonly fiber: Fiber.Fiber<void>;
}

/** `env` is added to every gh and git run; tests point HOME and gh's config at a scratch folder. */
export const make = Effect.fn("KinGitHubLogin.make")(function* (
  env: Readonly<Record<string, string>> = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const tool = yield* KinGhTool;
  const identity = yield* KinIdentity;
  const sql = yield* SqlClient.SqlClient;
  const refresh = yield* KinRefreshObserver;
  const layerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const pending = yield* Ref.make<Pending | null>(null);
  const failed = yield* Ref.make<string | null>(null);
  const cached = yield* Ref.make<{
    readonly at: number;
    readonly account: KinGitHubAccount | null;
  } | null>(null);
  const orgId = identity.owner.orgId;
  const touched = refresh.touch(orgId, "connections");

  const processEnv = {
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_DEBUG: "",
    // A token in the environment would outrank the login gh keeps.
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    // The owner opens the page on his own device, never a browser on the host.
    GH_BROWSER: "true",
    NO_COLOR: "1",
    ...env,
  };
  const command = (program: string, args: ReadonlyArray<string>, stdin?: string) =>
    ChildProcess.make(program, args, {
      env: processEnv,
      extendEnv: true,
      stdin: stdin === undefined ? "ignore" : Stream.make(new TextEncoder().encode(stdin)),
      forceKillAfter: "2 seconds",
    });
  /** One short gh or git run: its exit code and its output, stdout and stderr together. */
  const run = (program: string, args: ReadonlyArray<string>, stdin?: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command(program, args, stdin));
        const [out, code] = yield* Effect.all(
          [handle.all.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: 2 },
        );
        return { code: Number(code), ...cappedOutput(out) };
      }),
    ).pipe(
      Effect.timeout("1 minute"),
      Effect.orElseSucceed(() => ({ code: -1, out: "" })),
    );
  const gh = (args: ReadonlyArray<string>, stdin?: string) =>
    tool.ensure().pipe(Effect.flatMap((program) => run(program, args, stdin)));

  const owner = Effect.fn("KinGitHubLogin.owner")(function* (people: People, wanted: KinOrgId) {
    if (!people.some((person) => person.orgId === wanted)) return yield* notFound;
    const caller = people.find((person) => person.orgId === orgId);
    const isOwner =
      caller !== undefined &&
      (yield* ownerLevel(caller.orgId, caller.personId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orElseSucceed(() => false),
      ));
    if (wanted !== orgId || !isOwner) return yield* notOwner;
  });

  /** What GitHub says of the login gh holds now; null when gh holds none. */
  const probe = Effect.fn("KinGitHubLogin.probe")(function* () {
    const held = yield* gh(["auth", "token", "--hostname", HOST]);
    if (held.code !== 0 || held.out.trim() === "") return null;
    const user = yield* gh(["api", "-i", "user"]);
    if (user.code !== 0) {
      const stored = (yield* gh(["config", "get", "user", "--host", HOST])).out.trim();
      const lost = /HTTP 40[13]|bad credentials/i.test(user.out);
      return {
        login: stored === "" ? "your GitHub account" : stored,
        orgs: [],
        scopes: [],
        problem: lost
          ? "GitHub no longer accepts this login: it was revoked or lost access. Reconnect to sign in again."
          : "Kin couldn't reach GitHub to check this login just now.",
      } satisfies KinGitHubAccount;
    }
    const body = user.out.slice(user.out.indexOf("{"));
    const login = /"login"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? "";
    const orgs = yield* gh(["api", "user/orgs", "--paginate", "--jq", ".[].login"]);
    return {
      login,
      orgs:
        orgs.code === 0
          ? orgs.out
              .split("\n")
              .map((entry) => entry.trim())
              .filter(Boolean)
          : [],
      scopes: scopesOf(user.out),
      problem: null,
    } satisfies KinGitHubAccount;
  });

  const account: KinGitHubLogin["Service"]["account"] = Effect.fn("KinGitHubLogin.account")(
    function* () {
      const now = yield* Clock.currentTimeMillis;
      const last = yield* Ref.get(cached);
      if (last !== null && now - last.at < ACCOUNT_TTL_MS) return last.account;
      const found = yield* probe().pipe(
        Effect.catch((cause) =>
          isChatError(cause)
            ? Effect.succeed<KinGitHubAccount | null>(
                last?.account === null || last === null
                  ? null
                  : { ...last.account, problem: cause.message },
              )
            : Effect.die(cause),
        ),
      );
      yield* Ref.set(cached, { at: now, account: found });
      return found;
    },
  );
  const forget = Ref.set(cached, null);
  const connected: KinGitHubLogin["Service"]["connected"] = Effect.fn("KinGitHubLogin.connected")(
    function* () {
      const now = yield* Clock.currentTimeMillis;
      const last = yield* Ref.get(cached);
      if (last !== null && now - last.at < ACCOUNT_TTL_MS) return last.account !== null;
      if ((yield* tool.find()) === undefined) {
        yield* Ref.set(cached, { at: now, account: null });
        return false;
      }
      return (yield* account()) !== null;
    },
  );

  const view = Effect.fn("KinGitHubLogin.view")(function* () {
    const waiting = yield* Ref.get(pending);
    return {
      orgId,
      account: waiting === null ? yield* account() : ((yield* Ref.get(cached))?.account ?? null),
      signIn: waiting?.signIn ?? null,
      failed: yield* Ref.get(failed),
    } satisfies KinGitHubStatus;
  });

  // Kin's own layers don't carry the host's settings: the RPC handler provides them per call,
  // and a sign-in still running inherits them from the call that started it.
  const savedTokens = Effect.fn("KinGitHubLogin.savedTokens")(function* () {
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    if (Option.isNone(settings)) return undefined;
    const current = yield* settings.value.getSettings;
    const github = readSourceControlHostSettings(
      GitHubClient.settings,
      current.sourceControlHosts[GitHubClient.definition.kind],
    );
    return { service: settings.value, tokens: github.tokens };
  });
  /** T3's own GitHub token (Settings → Source control), so its PR features act as him too. */
  const saveToken = Effect.fn("KinGitHubLogin.saveToken")(function* (token: string) {
    const saved = yield* savedTokens();
    if (saved === undefined) return;
    yield* saved.service.updateSettings({
      sourceControlHosts: { github: { tokens: { ...saved.tokens, [HOST]: token } } },
    });
  });
  /** Removes T3's token only when it is the one this login saved. */
  const dropToken = Effect.fn("KinGitHubLogin.dropToken")(function* (token: string) {
    const saved = yield* savedTokens();
    if (saved === undefined || saved.tokens[HOST] !== token) return;
    const { [HOST]: _dropped, ...rest } = saved.tokens;
    yield* saved.service.updateSettings({ sourceControlHosts: { github: { tokens: rest } } });
  });

  /** After gh holds the new login: git uses it, T3 saves it, and no older account lingers. */
  const finish = Effect.fn("KinGitHubLogin.finish")(function* (previous: string | null) {
    const setup = yield* gh(["auth", "setup-git", "--hostname", HOST]);
    if (setup.code !== 0)
      yield* Effect.logWarning("Kin couldn't set git to use the GitHub login", {
        output: scrub(setup.out),
      });
    const token = (yield* gh(["auth", "token", "--hostname", HOST])).out.trim();
    if (token !== "") yield* saveToken(token);
    yield* forget;
    const now = yield* account();
    if (previous !== null && now !== null && previous !== now.login)
      yield* gh(["auth", "logout", "--hostname", HOST, "--user", previous]);
  });

  /** The login gh holds before a sign-in, so Reconnect can replace it. */
  const heldLogin = Effect.fn("KinGitHubLogin.heldLogin")(function* () {
    const stored = (yield* gh(["config", "get", "user", "--host", HOST])).out.trim();
    return stored === "" ? null : stored;
  });

  const refuseWhenConnected = Effect.fn("KinGitHubLogin.refuseWhenConnected")(function* () {
    yield* forget;
    const now = yield* account();
    if (now !== null && now.problem === null)
      return yield* fail(
        "invalid_state",
        `GitHub is already connected as ${now.login}. Disconnect it first to use another account.`,
      );
  });

  const withToken = Effect.fn("KinGitHubLogin.withToken")(function* (
    token: Redacted.Redacted<string>,
  ) {
    yield* refuseWhenConnected();
    const previous = yield* heldLogin();
    const result = yield* gh([...LOGIN_ARGS, "--with-token"], `${Redacted.value(token)}\n`);
    if (result.code !== 0) {
      const reason = signInFailure(result.out);
      yield* Ref.set(failed, reason);
      return yield* fail("invalid_state", reason);
    }
    yield* Ref.set(failed, null);
    yield* finish(previous);
  });

  /** gh runs until the owner authorizes, declines, or the code runs out. */
  const deviceFlow = Effect.fn("KinGitHubLogin.deviceFlow")(function* () {
    yield* refuseWhenConnected();
    const program = yield* tool.ensure();
    const previous = yield* heldLogin();
    const announced = yield* Deferred.make<{ code: string; url: string }, string>();
    const signIn = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command(program, DEVICE_ARGS));
        let output = "";
        yield* handle.all.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => {
            output = (output + chunk).slice(-MAX_OUTPUT);
            const found = deviceCodeOf(output);
            return found === null ? Effect.void : Deferred.succeed(announced, found);
          }),
        );
        return { code: Number(yield* handle.exitCode), output };
      }),
    ).pipe(
      Effect.timeout(SIGN_IN_LIMIT),
      Effect.orElseSucceed(() => ({ code: -1, output: "expired" })),
      Effect.flatMap(({ code, output }) =>
        Effect.gen(function* () {
          if (code === 0) {
            yield* finish(previous);
            yield* Ref.set(failed, null);
          } else yield* Ref.set(failed, signInFailure(output));
          yield* Deferred.fail(announced, output);
        }),
      ),
      Effect.ensuring(Ref.set(pending, null).pipe(Effect.andThen(touched))),
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin's GitHub sign-in stopped", { cause }).pipe(
          Effect.andThen(Ref.set(failed, "GitHub sign-in didn't finish.")),
        ),
      ),
    );
    const fiber = yield* Effect.forkIn(signIn, layerScope);
    const shown = yield* Deferred.await(announced).pipe(
      Effect.timeout("30 seconds"),
      Effect.option,
    );
    if (Option.isNone(shown)) {
      yield* Fiber.interrupt(fiber);
      const reason = (yield* Ref.get(failed)) ?? "GitHub didn't give Kin a sign-in code.";
      yield* Ref.set(failed, reason);
      return yield* fail("unavailable", reason);
    }
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.set(failed, null);
    yield* Ref.set(pending, {
      fiber,
      signIn: { ...shown.value, expiresAt: now + CODE_LIFETIME_MS },
    });
  });

  const start = Effect.fn("KinGitHubLogin.start")(function* (
    people: People,
    input: KinGitHubConnectInput,
  ) {
    yield* owner(people, input.orgId);
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(pending)) !== null) return;
        if (input.token !== undefined) yield* withToken(input.token);
        else yield* deviceFlow();
      }),
    );
    yield* touched;
    return yield* view();
  }, settle);

  const stopPending = Effect.gen(function* () {
    const waiting = yield* Ref.getAndSet(pending, null);
    if (waiting !== null) yield* Fiber.interrupt(waiting.fiber);
  });

  const cancel = Effect.fn("KinGitHubLogin.cancel")(function* (
    people: People,
    input: KinGitHubInput,
  ) {
    yield* owner(people, input.orgId);
    yield* lock.withPermits(1)(stopPending);
    yield* Ref.set(failed, null);
    yield* touched;
    return yield* view();
  }, settle);

  const disconnect = Effect.fn("KinGitHubLogin.disconnect")(function* (
    people: People,
    input: KinGitHubInput,
  ) {
    yield* owner(people, input.orgId);
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        yield* stopPending;
        const token = (yield* gh(["auth", "token", "--hostname", HOST])).out.trim();
        yield* gh(["auth", "logout", "--hostname", HOST]);
        // gh's setup-git lines, and the empty one before each that resets older helpers.
        for (const site of [HOST, `gist.${HOST}`])
          yield* run("git", [
            "config",
            "--global",
            "--unset-all",
            `credential.https://${site}.helper`,
            "^$|auth git-credential$",
          ]);
        if (token !== "") yield* dropToken(token);
        yield* Ref.set(failed, null);
        yield* forget;
      }),
    );
    yield* touched;
    return yield* view();
  }, settle);

  const status = Effect.fn("KinGitHubLogin.status")(function* (
    people: People,
    input: KinGitHubInput,
  ) {
    yield* owner(people, input.orgId);
    return yield* view();
  }, settle);

  return KinGitHubLogin.of({
    status,
    start,
    cancel,
    disconnect,
    account,
    connected,
    ghDirectory: tool.directory,
    gh: Effect.fn("KinGitHubLogin.gh")((args, stdin) =>
      gh(args, stdin).pipe(Effect.orElseSucceed(() => ({ code: -1, out: "" }))),
    ),
  });
});

/**
 * `KIN_DEV_FAKE_GITHUB=<dir>` (dev and kin-verify only): `<dir>/gh` stands in for gh, as
 * `fakeGh.sh` does, with HOME and gh's config under `<dir>`, so nothing touches this machine's own
 * GitHub login or git config.
 */
export const layer = Layer.effect(
  KinGitHubLogin,
  Effect.gen(function* () {
    const fake = yield* Config.String("KIN_DEV_FAKE_GITHUB").pipe(Config.withDefault(""));
    if (fake === "") return yield* make();
    yield* Effect.logWarning("Kin's GitHub login is the dev stand-in", { directory: fake });
    const stand = `${fake}/gh`;
    return yield* make({
      HOME: `${fake}/home`,
      XDG_CONFIG_HOME: `${fake}/home`,
      GH_CONFIG_DIR: `${fake}/config`,
      KIN_FAKE_GH: `${fake}/state`,
    }).pipe(
      Effect.provideService(
        KinGhTool,
        KinGhTool.of({
          ensure: Effect.fn("KinGhTool.devStandIn")(() => Effect.succeed(stand)),
          find: Effect.fn("KinGhTool.devStandInFind")(() => Effect.succeed(stand)),
          directory: fake,
        }),
      ),
    );
  }),
);

// @effect-diagnostics nodeBuiltinImport:off - Effect's crypto has no RSA signing for the App JWT.
import * as NodeCrypto from "node:crypto";

import type { KinGitHubAgents, KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientRequest } from "effect/http";

import { ServerConfig } from "../../config.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { KinServer } from "../KinServer.ts";
import type { ApiAnswer, ApiRequest } from "./GitHubWatch.ts";
import { APP_IDENTITY_FILE, APP_TOKENS_FOLDER, GH_APP_FOLDER, OWNER_USES_FILE } from "./ghSign.ts";
import { repoList } from "./githubWatchStore.ts";
import { KinKeychain } from "./Keychain.ts";

/**
 * Kin's GitHub App, so agents' commits, PRs, comments and reviews show the App as author. Its key
 * stays in the host keyring and in this process; agents' shells get only one-hour installation
 * tokens, which this keeps fresh as files `ghSign.ts` reads. Without an App, agents act as the owner.
 */

const API = "https://api.github.com";
const MINUTE = 60_000;
/** How often Kin looks again at the App and where it is installed. */
const DESCRIBE_EVERY_MS = 10 * MINUTE;
/** A token is renewed this long before it expires, so a shell never gets one about to lapse. */
const RENEW_BEFORE_MS = 30 * MINUTE;
const TICK = "30 seconds";
const MAX_PAGES = 10;
const COMMAND_CAP = 400;

/**
 * Never in a token an agent's shell holds: with these it could change a repo's settings, access or
 * secrets, which agents never do, whatever the App was granted.
 */
const withheld = (permission: string) =>
  [
    "administration",
    "members",
    "secrets",
    "environments",
    "repository_hooks",
    "actions_variables",
  ].includes(permission) || permission.startsWith("organization_");

export class KinGitHubAppConfig extends Context.Service<
  KinGitHubAppConfig,
  { readonly appId: Option.Option<string>; readonly botLogin: Option.Option<string> }
>()("t3/kin/github/KinGitHubApp/KinGitHubAppConfig") {
  static readonly layer = Layer.effect(
    KinGitHubAppConfig,
    Effect.gen(function* () {
      const appId = yield* Config.option(Config.String("KIN_GITHUB_APP_ID"));
      const botLogin = yield* Config.option(Config.String("KIN_GITHUB_BOT_LOGIN"));
      return {
        appId: appId.pipe(
          Option.map((value) => value.trim()),
          Option.filter((value) => /^[1-9][0-9]{0,11}$/.test(value)),
        ),
        botLogin: botLogin.pipe(
          Option.map((value) => value.trim()),
          Option.filter((value) => value !== ""),
        ),
      };
    }),
  );
}

const Secrets = Schema.Struct({ privateKeyPem: Schema.String });
const decodeSecrets = Schema.decodeUnknownOption(Schema.fromJsonString(Secrets));
const decodeApp = Schema.decodeUnknownOption(
  Schema.Struct({ slug: Schema.String, name: Schema.String }),
);
const decodeUser = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Int }));
const decodeInstallations = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      // An enterprise account has a slug and no login; Kin's shells can't use it.
      account: Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) })),
      permissions: Schema.Record(Schema.String, Schema.String),
    }),
  ),
);
const decodeToken = Schema.decodeUnknownOption(
  Schema.Struct({ token: Schema.String, expires_at: Schema.String }),
);
const decodeRepos = Schema.decodeUnknownOption(
  Schema.Struct({
    total_count: Schema.Int,
    repositories: Schema.Array(Schema.Struct({ full_name: Schema.String })),
  }),
);
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface Installation {
  readonly id: number;
  /** The account it is installed on, lowercased: the shell's token file is named after it. */
  readonly account: string;
  readonly permissions: Readonly<Record<string, string>>;
  readonly repos: ReadonlySet<string>;
}

interface Described {
  readonly name: string;
  readonly botLogin: string;
  readonly botEmail: string;
  readonly installUrl: string;
  readonly installations: ReadonlyArray<Installation>;
}

/** Where `describe` stopped short of a working App, and GitHub's status (0: not reached). */
interface Shortfall {
  readonly _tag: "short";
  readonly asked: "about the App" | "where it is installed" | "for its bot account";
  readonly status: number;
}

const shortfallProblem = ({ asked, status }: Shortfall) =>
  status === 0
    ? "Kin couldn't reach GitHub to check its GitHub App, so agents work as you meanwhile. Kin keeps trying."
    : `GitHub refused Kin's GitHub App when Kin asked ${asked} (status ${status}), so agents work as you meanwhile. Kin keeps trying.`;

/** What Kin knows of its App now: none set up, set up but unusable (and why), or working. */
export type AppState =
  | { readonly _tag: "none" }
  | { readonly _tag: "broken"; readonly problem: string }
  | { readonly _tag: "ok"; readonly app: Described };

export interface KinGitHubAppAs {
  readonly login: string;
  readonly call: (request: ApiRequest) => Effect.Effect<ApiAnswer>;
}

export class KinGitHubApp extends Context.Service<
  KinGitHubApp,
  {
    /** The App as Kin last saw it. */
    readonly state: () => Effect.Effect<AppState>;
    /** GitHub's API as the App on `repo` (owner/name); undefined where the App can't reach it. */
    readonly on: (repo: string) => Effect.Effect<KinGitHubAppAs | undefined>;
    /** Renews what is due (the App's description, tokens, the shell's files) and records owner switches. */
    readonly refresh: () => Effect.Effect<void>;
  }
>()("t3/kin/github/KinGitHubApp") {}

const base64Url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** RS256 App JWT; GitHub accepts at most 10 minutes and recommends backdating `iat` a minute. */
const signAppJwt = (appId: string, privateKeyPem: string, nowSeconds: number) => {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }),
  );
  const signature = NodeCrypto.sign(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    privateKeyPem,
  ).toString("base64url");
  return Redacted.make(`${header}.${payload}.${signature}`);
};

/** Never repeat a credential an agent typed into a command, whatever its shape. */
const scrubCommand = (text: string) =>
  text
    .replace(/\b(gh[opusr]_|github_pat_)[A-Za-z0-9_]+/g, "[secret]")
    .replace(/(\w+:\/\/)[^\s/@]+@/g, "$1[secret]@")
    .replace(
      /\b(authorization|x-api-key)(\s*[:=]\s*)(bearer\s+|token\s+|basic\s+)?\S+/gi,
      "$1$2[secret]",
    )
    .replace(/(--?(?:token|password|passwd|secret|api-key|key)(?:=|\s+))\S+/gi, "$1[secret]")
    .replace(/\b(\w*(?:token|secret|password|passwd|api_?key)\w*=)\S+/gi, "$1[secret]")
    .replace(/\bbearer\s+\S+/gi, "Bearer [secret]")
    .slice(0, COMMAND_CAP);

/** One `kin-as-owner` line: seconds, pid, agent, repo, command, tab-separated. */
export const parseOwnerUse = (line: string) => {
  const [seconds = "", pid = "", agent = "", repo = "", ...command] = line.split("\t");
  const at = Number(seconds) * 1000;
  if (!Number.isFinite(at) || at <= 0 || pid === "") return undefined;
  return {
    useId: NodeCrypto.createHash("sha256").update(line).digest("hex").slice(0, 32),
    at,
    agent: agent.trim() === "" ? null : agent.trim().slice(0, 120),
    repo: /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null,
    command: scrubCommand(command.join(" ").trim()),
  };
};

export const make = Effect.gen(function* () {
  const config = yield* KinGitHubAppConfig;
  const keychain = yield* KinKeychain;
  const client = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* KinIdentity;
  const refreshObserver = yield* KinRefreshObserver;
  const orgId = identity.owner.orgId;
  const folder = path.join(stateDir, "kin", GH_APP_FOLDER);
  const tokensFolder = path.join(folder, APP_TOKENS_FOLDER);
  const lock = yield* Semaphore.make(1);
  const current = yield* Ref.make<AppState>({ _tag: "none" });
  const describedAt = yield* Ref.make<number | null>(null);
  const botIds = new Map<string, number>();
  const tokens = new Map<number, { token: Redacted.Redacted<string>; expiresAt: number }>();
  /** The bytes of the owner-uses file already recorded; a restart reads it again, without repeats. */
  let usesRead = 0;
  /** The last shortfall logged, so a failure that lasts is logged once, not every look. */
  let loggedProblem: string | null = null;

  const request = Effect.fn("KinGitHubApp.request")(function* (
    token: Redacted.Redacted<string> | undefined,
    input: ApiRequest,
  ) {
    let outgoing = HttpClientRequest.make(input.method ?? "GET")(
      `${API}/${input.path.replace(/^\//, "")}`,
    ).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "kin",
        ...input.headers,
      }),
    );
    if (token !== undefined) outgoing = HttpClientRequest.bearerToken(outgoing, token);
    if (input.body !== undefined)
      outgoing = HttpClientRequest.bodyText(outgoing, toJson(input.body), "application/json");
    const failed: ApiAnswer = { status: 0, headers: {}, body: null, text: "" };
    return yield* client.execute(outgoing).pipe(
      Effect.flatMap((response) =>
        response.text.pipe(
          Effect.map((text): ApiAnswer => {
            let body: unknown = null;
            try {
              body = text.trim() === "" ? null : JSON.parse(text);
            } catch {
              body = null;
            }
            return { status: response.status, headers: { ...response.headers }, body, text };
          }),
        ),
      ),
      Effect.timeout("30 seconds"),
      // No cause: requests and answers here can hold tokens.
      Effect.orElseSucceed(() => failed),
    );
  });

  const jwt = Effect.fn("KinGitHubApp.jwt")(function* (appId: string) {
    const stored = yield* keychain.appSecret(appId);
    const secrets = Option.flatMap(stored, (value) => decodeSecrets(Redacted.value(value)));
    if (Option.isNone(secrets)) return undefined;
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    return signAppJwt(appId, secrets.value.privateKeyPem, now);
  });

  const mint = Effect.fn("KinGitHubApp.mint")(function* (
    appToken: Redacted.Redacted<string>,
    installation: Pick<Installation, "id" | "permissions">,
  ) {
    const permissions = Object.fromEntries(
      Object.entries(installation.permissions).filter(([name]) => !withheld(name)),
    );
    const answer = yield* request(appToken, {
      method: "POST",
      path: `app/installations/${installation.id}/access_tokens`,
      body: { permissions },
    });
    const minted = answer.status === 201 ? decodeToken(answer.body) : Option.none();
    if (Option.isNone(minted)) return undefined;
    const expiresAt = Date.parse(minted.value.expires_at);
    const entry = {
      token: Redacted.make(minted.value.token),
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    };
    tokens.set(installation.id, entry);
    return entry;
  });

  /** What GitHub says of the App now, or where it fell short. */
  const describe = Effect.fn("KinGitHubApp.describe")(function* (appId: string) {
    const appToken = yield* jwt(appId).pipe(Effect.orElseSucceed(() => undefined));
    if (appToken === undefined)
      return {
        _tag: "broken",
        problem: "Kin can't read its GitHub App's key on this computer, so agents work as you.",
      } as const;
    const short = (asked: Shortfall["asked"], status: number): Shortfall => ({
      _tag: "short",
      asked,
      status,
    });
    const app = yield* request(appToken, { path: "app" });
    const about = app.status === 200 ? decodeApp(app.body) : Option.none();
    if (Option.isNone(about)) return short("about the App", app.status);
    const botLogin = Option.getOrElse(config.botLogin, () => `${about.value.slug}[bot]`);
    const installations: Array<Installation> = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const answer = yield* request(appToken, {
        path: `app/installations?per_page=100&page=${page}`,
      });
      const listed = answer.status === 200 ? decodeInstallations(answer.body) : Option.none();
      if (Option.isNone(listed)) return short("where it is installed", answer.status);
      for (const installation of listed.value) {
        const account = installation.account?.login?.toLowerCase() ?? "";
        if (!/^[a-z0-9-]+$/.test(account)) continue;
        const held = tokens.get(installation.id);
        const token =
          held !== undefined && held.expiresAt - (yield* Clock.currentTimeMillis) > 5 * MINUTE
            ? held
            : yield* mint(appToken, installation);
        const repos = new Set<string>();
        for (let reposPage = 1; token !== undefined && reposPage <= MAX_PAGES; reposPage++) {
          const answer = yield* request(token.token, {
            path: `installation/repositories?per_page=100&page=${reposPage}`,
          });
          const found = answer.status === 200 ? decodeRepos(answer.body) : Option.none();
          if (Option.isNone(found)) break;
          for (const repo of found.value.repositories) repos.add(repo.full_name.toLowerCase());
          if (found.value.repositories.length < 100) break;
        }
        installations.push({
          id: installation.id,
          account,
          permissions: installation.permissions,
          repos,
        });
      }
      if (listed.value.length < 100) break;
    }
    if (!botIds.has(botLogin)) {
      // GitHub takes the App's JWT only on `/app…`. The bot's record is public: an installation
      // token reads it, and so does no token at all, before the App is installed anywhere.
      const held = installations.map((entry) => tokens.get(entry.id)).find(Boolean);
      const user = yield* request(held?.token, {
        path: `users/${encodeURIComponent(botLogin)}`,
      });
      const found = user.status === 200 ? decodeUser(user.body) : Option.none();
      if (Option.isNone(found)) return short("for its bot account", user.status);
      botIds.set(botLogin, found.value.id);
    }
    return {
      _tag: "ok",
      app: {
        name: about.value.name,
        botLogin,
        botEmail: `${botIds.get(botLogin)}+${botLogin}@users.noreply.github.com`,
        installUrl: `https://github.com/apps/${about.value.slug}/installations/new`,
        installations,
      },
    } as const;
  });

  /** The shell's files match what Kin holds: the App's identity and a live token per account. */
  const writeShellFiles = Effect.fn("KinGitHubApp.writeShellFiles")(function* (state: AppState) {
    yield* fs.makeDirectory(tokensFolder, { recursive: true, mode: 0o700 });
    yield* fs.chmod(folder, 0o700);
    const live = new Map<string, string>();
    if (state._tag === "ok")
      for (const installation of state.app.installations) {
        const token = tokens.get(installation.id);
        if (token !== undefined) live.set(installation.account, Redacted.value(token.token));
      }
    for (const name of yield* fs.readDirectory(tokensFolder))
      if (!live.has(name)) yield* fs.remove(path.join(tokensFolder, name), { force: true });
    for (const [account, token] of live) {
      const file = path.join(tokensFolder, account);
      const staged = `${file}.next`;
      yield* fs.writeFileString(staged, token, { mode: 0o600 });
      yield* fs.rename(staged, file);
    }
    const identityFile = path.join(folder, APP_IDENTITY_FILE);
    if (state._tag === "ok")
      yield* fs.writeFileString(identityFile, `${state.app.botLogin}\n${state.app.botEmail}\n`);
    else yield* fs.remove(identityFile, { force: true });
  });

  /** Records each `kin-as-owner` run the shell wrote since the last look. */
  const recordOwnerUses = Effect.fn("KinGitHubApp.recordOwnerUses")(function* () {
    const file = path.join(folder, OWNER_USES_FILE);
    if (!(yield* fs.exists(file))) return;
    const text = yield* fs.readFileString(file);
    const bytes = Buffer.byteLength(text);
    if (bytes < usesRead) usesRead = 0;
    if (bytes === usesRead) return;
    const fresh = Buffer.from(text).subarray(usesRead).toString("utf8");
    const complete = fresh.slice(0, fresh.lastIndexOf("\n") + 1);
    usesRead += Buffer.byteLength(complete);
    let added = 0;
    for (const line of complete.split("\n")) {
      const use = parseOwnerUse(line);
      if (use === undefined) continue;
      const inserted = yield* sql`INSERT INTO kin_github_owner_uses (org_id, use_id, at, agent_name,
          repo, command)
        VALUES (${orgId}, ${use.useId}, ${use.at}, ${use.agent}, ${use.repo}, ${use.command})
        ON CONFLICT DO NOTHING RETURNING use_id`;
      added += inserted.length;
    }
    if (added > 0) yield* refreshObserver.touch(orgId, "connections");
  });

  const refresh = Effect.fn("KinGitHubApp.refresh")(
    function* () {
      const now = yield* Clock.currentTimeMillis;
      const before = yield* Ref.get(current);
      let state = before;
      if (Option.isNone(config.appId)) state = { _tag: "none" };
      else {
        const last = yield* Ref.get(describedAt);
        if (last === null || now - last >= DESCRIBE_EVERY_MS || before._tag !== "ok") {
          const described = yield* describe(config.appId.value);
          if (described._tag === "short") {
            const problem = shortfallProblem(described);
            if (problem !== loggedProblem)
              yield* Effect.logWarning("Kin's GitHub App isn't working; agents act as the owner", {
                asked: described.asked,
                status: described.status,
              });
            loggedProblem = problem;
            // A working App stays on through a passing failure; its tokens still hold.
            if (before._tag !== "ok") state = { _tag: "broken", problem };
          } else {
            loggedProblem = null;
            state = described;
            yield* Ref.set(describedAt, now);
          }
        }
        if (state._tag === "ok") {
          const appToken = yield* jwt(config.appId.value).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          for (const installation of state.app.installations) {
            const held = tokens.get(installation.id);
            if (
              appToken !== undefined &&
              (held === undefined || held.expiresAt - now < RENEW_BEFORE_MS)
            )
              yield* mint(appToken, installation);
          }
        }
      }
      yield* Ref.set(current, state);
      yield* writeShellFiles(state).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin couldn't write its GitHub App files for agents", { cause }),
        ),
      );
      yield* recordOwnerUses().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin couldn't record agents' uses of the owner's GitHub", { cause }),
        ),
      );
      if (state._tag !== before._tag) yield* refreshObserver.touch(orgId, "connections");
    },
    (effect) => lock.withPermits(1)(effect),
  );

  const on = Effect.fn("KinGitHubApp.on")(function* (repo: string) {
    const state = yield* Ref.get(current);
    if (state._tag !== "ok" || Option.isNone(config.appId)) return undefined;
    const wanted = repo.trim().toLowerCase();
    const installation = state.app.installations.find((entry) => entry.repos.has(wanted));
    if (installation === undefined) return undefined;
    const now = yield* Clock.currentTimeMillis;
    let held = tokens.get(installation.id);
    if (held === undefined || held.expiresAt - now < 5 * MINUTE) {
      const appToken = yield* jwt(config.appId.value).pipe(Effect.orElseSucceed(() => undefined));
      held = appToken === undefined ? undefined : yield* mint(appToken, installation);
    }
    if (held === undefined) return undefined;
    const token = held.token;
    return {
      login: state.app.botLogin,
      call: (input: ApiRequest) => request(token, input),
    } satisfies KinGitHubAppAs;
  });

  const state = Effect.fn("KinGitHubApp.state")(function* () {
    return yield* Ref.get(current);
  });

  return KinGitHubApp.of({ state, on, refresh });
});

/** Looks once at startup and then every 30 seconds, for as long as Kin runs. */
export const layer = Layer.effect(
  KinGitHubApp,
  Effect.gen(function* () {
    const app = yield* make;
    yield* app
      .refresh()
      .pipe(Effect.andThen(Effect.sleep(TICK)), Effect.forever, Effect.forkScoped);
    return app;
  }),
).pipe(Layer.provide(KinGitHubAppConfig.layer));

/** The App service wherever Kin's services are reached: given directly, or through `KinServer`. */
export const gitHubApp = Effect.gen(function* () {
  const direct = yield* Effect.serviceOption(KinGitHubApp);
  if (Option.isSome(direct)) return direct;
  const kin = yield* Effect.serviceOption(KinServer);
  return Option.flatMap(kin, (server) =>
    Option.flatMap(server.services, (services) => Context.getOption(services, KinGitHubApp)),
  );
});

/** Who agents work as on GitHub, for the Connections screen. */
export const agentsView = Effect.fn("KinGitHubApp.agentsView")(function* (
  app: Option.Option<KinGitHubApp["Service"]>,
  orgId: KinOrgId,
) {
  const sql = yield* SqlClient.SqlClient;
  const state: AppState = Option.isSome(app) ? yield* app.value.state() : { _tag: "none" };
  const watched = (yield* repoList(orgId)).filter((repo) => repo.watched).map((repo) => repo.repo);
  const uses = yield* sql<{
    at: number;
    agent: string | null;
    repo: string | null;
    command: string;
  }>`SELECT at, agent_name AS agent, repo, command FROM kin_github_owner_uses
    WHERE org_id = ${orgId} ORDER BY at DESC, use_id LIMIT 5`;
  const installed =
    state._tag === "ok"
      ? watched.filter((repo) =>
          state.app.installations.some((entry) => entry.repos.has(repo.toLowerCase())),
        )
      : [];
  return {
    as: state._tag === "ok" ? "app" : "owner",
    ...(state._tag === "ok"
      ? { appName: state.app.name, botLogin: state.app.botLogin, installUrl: state.app.installUrl }
      : {}),
    problem: state._tag === "broken" ? state.problem : null,
    watched: watched.length,
    installed: installed.length,
    without: watched.filter((repo) => !installed.includes(repo)).slice(0, 20),
    ownerUses: uses,
  } satisfies KinGitHubAgents;
});

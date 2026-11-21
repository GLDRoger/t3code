// @effect-diagnostics nodeBuiltinImport:off - Effect's crypto has no RSA signing for the App JWT.
import * as NodeCrypto from "node:crypto";

import type { KinGitHubAgents, KinGitHubAppAccount, KinOrgId } from "@t3tools/contracts";
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
import {
  readSeedTaken,
  readStoredApp,
  type StoredApp,
  writeSeedTaken,
  writeStoredApp,
} from "./appStore.ts";
import {
  APP_IDENTITY_FILE,
  APP_REPOS_FOLDER,
  APP_TOKENS_FOLDER,
  GH_APP_FOLDER,
  OWNER_USES_FILE,
} from "./ghSign.ts";
import { type KnownRepo, knownRepos, repoList, watchRow } from "./githubWatchStore.ts";
import { KinGitHubAppKey } from "./appKey.ts";
import { MINUTE_MS } from "../durations.ts";

/**
 * Kin's GitHub App: agents' shells get only one-hour installation tokens, kept fresh as files
 * `ghSign.ts` reads; without an App, agents act as the owner. `KIN_GITHUB_APP_ID` is only a seed:
 * the first look that reaches GitHub adopts it into Settings' record, which owns it from then on.
 */

const API = "https://api.github.com";
/**
 * How often Kin looks again at the App and where it is installed: often enough that a choice the
 * owner saves on GitHub shows in Connections within a minute, without a reload.
 */
const DESCRIBE_EVERY_MS = MINUTE_MS;
/** A token is renewed this long before it expires, so a shell never gets one about to lapse. */
const VISIBILITY_EVERY_MS = 15 * MINUTE_MS;
const RENEW_BEFORE_MS = 30 * MINUTE_MS;
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
  Schema.Struct({
    slug: Schema.String,
    name: Schema.String,
    // An enterprise owner has a slug and no login.
    owner: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          login: Schema.optional(Schema.String),
          type: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
);
const decodeUser = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Int }));
const decodeInstallations = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      // An enterprise account has a slug and no login; Kin's shells can't use it.
      account: Schema.NullOr(
        Schema.Struct({
          login: Schema.optional(Schema.String),
          id: Schema.optional(Schema.Int),
          type: Schema.optional(Schema.String),
        }),
      ),
      repository_selection: Schema.optional(Schema.String),
      suspended_at: Schema.optional(Schema.NullOr(Schema.String)),
      html_url: Schema.optional(Schema.String),
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
  /** `all` covers every repo of the account, new ones too; `selected` only those picked. */
  readonly selection: "all" | "selected";
  readonly suspended: boolean;
  /** The installation's page on GitHub, where its owner picks its repos or unsuspends it. */
  readonly settingsUrl: string | null;
  readonly permissions: Readonly<Record<string, string>>;
  readonly repos: ReadonlySet<string>;
}

interface Described {
  readonly id: number;
  readonly name: string;
  readonly botLogin: string;
  readonly botEmail: string;
  readonly slug: string;
  readonly installUrl: string;
  /** The account that owns the App, lowercased; null for an enterprise. */
  readonly owner: string | null;
  /** The same account in GitHub's own casing, for people to read. */
  readonly ownerLogin: string | null;
  readonly ownerOrg: boolean;
  /** False when GitHub hides the App from anyone else: then it installs only on `owner`. */
  readonly public: boolean | null;
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
    /** Looks at the App on GitHub now, as after the owner changed where it is installed. */
    readonly lookAgain: () => Effect.Effect<void>;
    /**
     * Where the App is named: Settings' record, the host's environment while Kin hasn't yet reached
     * GitHub to adopt it (`seed`), or nowhere.
     */
    readonly origin?: () => Effect.Effect<
      | { readonly source: "kin"; readonly app: StoredApp }
      | { readonly source: "seed" }
      | { readonly source: "none" }
    >;
    /**
     * The four calls the App's webhook needs, each one fixed method and path signed as the App
     * named by its id; undefined where Kin holds no key for that App.
     */
    readonly hook?: {
      readonly config: (appId: string) => Effect.Effect<ApiAnswer | undefined>;
      readonly setConfig: (
        appId: string,
        config: {
          readonly url: string;
          readonly content_type: "json";
          readonly insecure_ssl: "0";
          readonly secret: string;
        },
      ) => Effect.Effect<ApiAnswer | undefined>;
      readonly about: (appId: string) => Effect.Effect<ApiAnswer | undefined>;
      readonly latestDelivery: (appId: string) => Effect.Effect<ApiAnswer | undefined>;
    };
  }
>()("t3/kin/github/KinGitHubApp") {}

/** Where the App reaches, so Connections hears when the owner changes it on GitHub. */
const coverage = (state: AppState) =>
  state._tag !== "ok"
    ? state._tag
    : toJson([
        state.app.public,
        state.app.installations.map((entry) => [
          entry.id,
          entry.selection,
          entry.suspended,
          [...entry.repos].toSorted(),
        ]),
      ]);

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
  const appKey = yield* KinGitHubAppKey;
  const client = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const { stateDir } = serverConfig;
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* KinIdentity;
  const refreshObserver = yield* KinRefreshObserver;
  const orgId = identity.owner.orgId;
  const folder = path.join(stateDir, "kin", GH_APP_FOLDER);
  const tokensFolder = path.join(folder, APP_TOKENS_FOLDER);
  const reposFolder = path.join(folder, APP_REPOS_FOLDER);
  const lock = yield* Semaphore.make(1);
  const current = yield* Ref.make<AppState>({ _tag: "none" });
  const describedAt = yield* Ref.make<number | null>(null);
  const botIds = new Map<string, number>();
  const tokens = new Map<number, { token: Redacted.Redacted<string>; expiresAt: number }>();
  /** The bytes of the owner-uses file already recorded; a restart reads it again, without repeats. */
  let usesRead = 0;
  let visibility: { readonly at: number; readonly public: boolean | null } | null = null;
  /** The last shortfall logged, so a failure that lasts is logged once, not every look. */
  let loggedProblem: string | null = null;

  const withFiles = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ServerConfig>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
    );

  /** Settings' App, else the host environment's while Settings hasn't adopted or dropped it. */
  const named = Effect.fn("KinGitHubApp.named")(function* () {
    const stored = yield* withFiles(readStoredApp);
    if (Option.isSome(stored))
      return { appId: String(stored.value.appId), stored: stored.value } as const;
    if (Option.isNone(config.appId)) return undefined;
    if ((yield* withFiles(readSeedTaken)) === config.appId.value) return undefined;
    return { appId: config.appId.value, stored: null } as const;
  });

  const appIdNow = Effect.fn("KinGitHubApp.appId")(function* () {
    return Option.fromNullishOr((yield* named())?.appId);
  });

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
    const stored = yield* appKey.get(appId);
    const secrets = Option.flatMap(stored, (value) => decodeSecrets(Redacted.value(value)));
    if (Option.isNone(secrets)) return undefined;
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    // A key node can't read fails this look, never the loop that runs it.
    return yield* Effect.try({
      try: () => signAppJwt(appId, secrets.value.privateKeyPem, now),
      catch: () => "unreadable key" as const,
    }).pipe(Effect.orElseSucceed(() => undefined));
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
  const describe = Effect.fn("KinGitHubApp.describe")(function* (
    appId: string,
    namedBot: string | undefined,
  ) {
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
    const botLogin = namedBot ?? `${about.value.slug}[bot]`;
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
        let token =
          held !== undefined && held.expiresAt - (yield* Clock.currentTimeMillis) > 5 * MINUTE_MS
            ? held
            : yield* mint(appToken, installation);
        const repos = new Set<string>();
        for (let reposPage = 1; token !== undefined && reposPage <= MAX_PAGES; reposPage++) {
          let answer = yield* request(token.token, {
            path: `installation/repositories?per_page=100&page=${reposPage}`,
          });
          // A token GitHub stopped taking (revoked, or the installation was replaced): mint once more.
          if (answer.status === 401 && token === held) {
            token = yield* mint(appToken, installation);
            if (token === undefined) break;
            answer = yield* request(token.token, {
              path: `installation/repositories?per_page=100&page=${reposPage}`,
            });
          }
          const found = answer.status === 200 ? decodeRepos(answer.body) : Option.none();
          if (Option.isNone(found)) break;
          for (const repo of found.value.repositories) repos.add(repo.full_name.toLowerCase());
          if (found.value.repositories.length < 100) break;
        }
        installations.push({
          id: installation.id,
          account,
          selection: installation.repository_selection === "all" ? "all" : "selected",
          suspended: installation.suspended_at != null,
          settingsUrl: installation.html_url?.startsWith("https://github.com/")
            ? installation.html_url
            : null,
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
    // GitHub answers a private App's page only to its owner, so a look without a token tells.
    // Unsigned calls share a small hourly allowance, so this look is spaced out.
    const now = yield* Clock.currentTimeMillis;
    if (visibility === null || now - visibility.at >= VISIBILITY_EVERY_MS) {
      const listed = yield* request(undefined, {
        path: `apps/${encodeURIComponent(about.value.slug)}`,
      });
      visibility = {
        at: now,
        // A throttle or an error says nothing about the App: what Kin saw last stands.
        public:
          listed.status === 200
            ? true
            : listed.status === 404
              ? false
              : (visibility?.public ?? null),
      };
    }
    return {
      _tag: "ok",
      app: {
        id: Number(appId),
        name: about.value.name,
        botLogin,
        botEmail: `${botIds.get(botLogin)}+${botLogin}@users.noreply.github.com`,
        slug: about.value.slug,
        installUrl: `https://github.com/apps/${about.value.slug}/installations/new`,
        owner: about.value.owner?.login?.toLowerCase() ?? null,
        ownerLogin: about.value.owner?.login ?? null,
        ownerOrg: about.value.owner?.type === "Organization",
        public: visibility.public,
        installations,
      },
    } as const;
  });

  /**
   * The shell's files match what Kin holds: the App's identity, a live token per account, and the
   * repos it covers where the installation has only some.
   */
  const writeShellFiles = Effect.fn("KinGitHubApp.writeShellFiles")(function* (state: AppState) {
    yield* fs.makeDirectory(tokensFolder, { recursive: true, mode: 0o700 });
    yield* fs.makeDirectory(reposFolder, { recursive: true, mode: 0o700 });
    yield* fs.chmod(folder, 0o700);
    const live = new Map<string, string>();
    const picked = new Map<string, string>();
    if (state._tag === "ok")
      for (const installation of state.app.installations) {
        const token = tokens.get(installation.id);
        if (token === undefined) continue;
        live.set(installation.account, Redacted.value(token.token));
        if (installation.selection === "selected")
          picked.set(
            installation.account,
            [...installation.repos]
              .toSorted()
              .map((repo) => `${repo}\n`)
              .join(""),
          );
      }
    for (const [dir, keep] of [
      [tokensFolder, live],
      [reposFolder, picked],
    ] as const)
      for (const name of yield* fs.readDirectory(dir))
        if (!keep.has(name)) yield* fs.remove(path.join(dir, name), { force: true });
    // The repo list goes first, so a token never stands without the repos it is limited to.
    for (const [dir, files, mode] of [
      [reposFolder, picked, 0o644],
      [tokensFolder, live, 0o600],
    ] as const)
      for (const [account, text] of files) {
        const file = path.join(dir, account);
        const staged = `${file}.next`;
        yield* fs.writeFileString(staged, text, { mode });
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

  /** The host's App becomes Settings' own, so Disconnect and making another work as for any. */
  const adopt = Effect.fn("KinGitHubApp.adopt")(function* (appId: string, app: Described) {
    yield* withFiles(
      writeStoredApp({
        appId: Number(appId),
        slug: app.slug,
        name: app.name,
        owner: app.ownerLogin ?? "",
        botLogin: app.botLogin,
        at: null,
        by: null,
      }),
    );
    yield* withFiles(writeSeedTaken(appId));
    yield* Effect.logInfo("Kin's Settings now hold the GitHub App the host's environment named", {
      appId,
    });
  });

  const refresh = Effect.fn("KinGitHubApp.refresh")(
    function* () {
      const now = yield* Clock.currentTimeMillis;
      const before = yield* Ref.get(current);
      let state = before;
      const app = yield* named();
      const appId = Option.fromNullishOr(app?.appId);
      if (app === undefined || Option.isNone(appId)) state = { _tag: "none" };
      else {
        const last = yield* Ref.get(describedAt);
        if (last === null || now - last >= DESCRIBE_EVERY_MS || before._tag !== "ok") {
          const described = yield* describe(
            appId.value,
            app.stored === null ? Option.getOrUndefined(config.botLogin) : app.stored.botLogin,
          );
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
            if (app.stored === null && described._tag === "ok")
              yield* adopt(appId.value, described.app).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Kin couldn't adopt the host's GitHub App into Settings", {
                    cause,
                  }),
                ),
              );
          }
        }
        if (state._tag === "ok") {
          const appToken = yield* jwt(appId.value).pipe(Effect.orElseSucceed(() => undefined));
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
      if (state._tag !== before._tag || coverage(state) !== coverage(before))
        yield* refreshObserver.touch(orgId, "connections");
    },
    (effect) => lock.withPermits(1)(effect),
  );

  const on = Effect.fn("KinGitHubApp.on")(function* (repo: string) {
    const state = yield* Ref.get(current);
    const appId = yield* appIdNow();
    if (state._tag !== "ok" || Option.isNone(appId)) return undefined;
    const wanted = repo.trim().toLowerCase();
    const installation = state.app.installations.find((entry) => entry.repos.has(wanted));
    if (installation === undefined) return undefined;
    const now = yield* Clock.currentTimeMillis;
    let held = tokens.get(installation.id);
    if (held === undefined || held.expiresAt - now < 5 * MINUTE_MS) {
      const appToken = yield* jwt(appId.value).pipe(Effect.orElseSucceed(() => undefined));
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

  const lookAgain = Effect.fn("KinGitHubApp.lookAgain")(function* () {
    yield* Ref.set(describedAt, null);
    if (visibility !== null)
      visibility = { at: Number.NEGATIVE_INFINITY, public: visibility.public };
    yield* refresh();
  });

  const origin = Effect.fn("KinGitHubApp.origin")(function* () {
    const app = yield* named();
    if (app === undefined) return { source: "none" } as const;
    return app.stored === null
      ? ({ source: "seed" } as const)
      : ({ source: "kin", app: app.stored } as const);
  });

  const asApp = Effect.fnUntraced(function* (appId: string, input: ApiRequest) {
    const token = yield* jwt(appId);
    return token === undefined ? undefined : yield* request(token, input);
  });
  const hook = {
    config: Effect.fn("KinGitHubApp.hookConfig")((appId: string) =>
      asApp(appId, { path: "app/hook/config" }),
    ),
    setConfig: Effect.fn("KinGitHubApp.setHookConfig")(
      (
        appId: string,
        config: Parameters<NonNullable<KinGitHubApp["Service"]["hook"]>["setConfig"]>[1],
      ) => asApp(appId, { method: "PATCH", path: "app/hook/config", body: config }),
    ),
    about: Effect.fn("KinGitHubApp.about")((appId: string) => asApp(appId, { path: "app" })),
    latestDelivery: Effect.fn("KinGitHubApp.latestDelivery")((appId: string) =>
      asApp(appId, { path: "app/hook/deliveries?per_page=1" }),
    ),
  };

  return KinGitHubApp.of({ state, on, refresh, lookAgain, origin, hook });
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
  const known = state._tag === "ok" ? yield* knownRepos(orgId) : [];
  const origin =
    Option.isSome(app) && app.value.origin !== undefined ? yield* app.value.origin() : undefined;
  const elsewhere =
    state._tag === "ok"
      ? (() => {
          const watchedSet = new Set(watched.map((repo) => repo.toLowerCase()));
          return new Set(
            state.app.installations.flatMap((entry) =>
              [...entry.repos].filter((repo) => !watchedSet.has(repo)),
            ),
          ).size;
        })()
      : undefined;
  const login = state._tag === "ok" ? ((yield* watchRow(orgId))?.login ?? null) : null;
  return {
    as: state._tag === "ok" ? "app" : "owner",
    ...(state._tag === "ok"
      ? {
          appName: state.app.name,
          botLogin: state.app.botLogin,
          installUrl: state.app.installUrl,
          ...appAccounts(state.app, watched, known, login),
        }
      : {}),
    problem: state._tag === "broken" ? state.problem : null,
    ...(origin === undefined
      ? {}
      : origin.source === "none"
        ? { canCreate: true }
        : {
            setUp: {
              source: "kin" as const,
              name: origin.source === "kin" ? origin.app.name : null,
              at: origin.source === "kin" ? origin.app.at : null,
              by: origin.source === "kin" ? origin.app.by : null,
              settingsUrl:
                origin.source === "kin"
                  ? state._tag === "ok"
                    ? appSettingsPage(
                        state.app.slug,
                        state.app.ownerOrg,
                        state.app.ownerLogin ?? origin.app.owner,
                      )
                    : appSettingsPage(origin.app.slug, false, origin.app.owner)
                  : null,
            },
          }),
    watched: watched.length,
    installed: installed.length,
    ...(elsewhere === undefined ? {} : { elsewhere }),
    without: watched.filter((repo) => !installed.includes(repo)).slice(0, 20),
    ownerUses: uses,
  } satisfies KinGitHubAgents;
});

const ownerOf = (repo: string) => repo.split("/")[0]?.toLowerCase() ?? "";

/** The App's own settings on GitHub: under the organisation when one owns it. */
export const appSettingsPage = (slug: string, ownerOrg: boolean, owner: string) =>
  ownerOrg && owner !== ""
    ? `https://github.com/organizations/${owner}/settings/apps/${slug}`
    : `https://github.com/settings/apps/${slug}`;

/**
 * Where the App stands on each account with watched repos, and the one GitHub page that changes
 * it. Watched repos belong to the login or its organisations, so the owners alone make the rows;
 * what the poll kept of each account adds the exact install page and whether the login owns it.
 */
const appAccounts = (
  app: Described,
  watched: ReadonlyArray<string>,
  known: ReadonlyArray<KnownRepo>,
  login: string | null,
): Pick<KinGitHubAgents, "accounts" | "appOwner" | "appSettingsUrl"> => {
  const facts = new Map(known.map((entry) => [ownerOf(entry.repo), entry]));
  const names = new Map<string, string>();
  for (const repo of watched) names.set(ownerOf(repo), repo.split("/")[0] ?? "");
  const user = login?.toLowerCase() ?? null;
  const manages = (account: string) => {
    if (account === user) return true;
    const entry = facts.get(account);
    // The only personal account among the repos' owners is the login's own.
    return entry?.ownerOrg === false ? true : (entry?.ownerAdmin ?? null);
  };
  const accounts: Array<KinGitHubAppAccount> = [];
  for (const [account, name] of names) {
    const entry = facts.get(account);
    const organisation = entry?.ownerOrg ?? (user === null ? undefined : account !== user);
    if (organisation === undefined) return {};
    const repos = watched.filter((repo) => ownerOf(repo) === account);
    const installation = app.installations.find((item) => item.account === account);
    const watchedHere = new Set(repos.map((repo) => repo.toLowerCase()));
    accounts.push({
      account: name,
      organisation,
      watched: repos.length,
      covered: repos.filter((repo) => installation?.repos.has(repo.toLowerCase()) === true).length,
      installation:
        installation === undefined
          ? "none"
          : installation.suspended
            ? "suspended"
            : installation.selection,
      settingsUrl: installation?.settingsUrl ?? null,
      installUrl:
        installation !== undefined
          ? null
          : entry?.ownerId === undefined
            ? app.installUrl
            : `${app.installUrl}/permissions?target_id=${entry.ownerId}`,
      canManage: manages(account),
      installable:
        installation !== undefined ||
        app.public !== false ||
        app.owner === null ||
        app.owner === account,
      elsewhere: [...(installation?.repos ?? [])].filter((repo) => !watchedHere.has(repo)).length,
    });
  }
  const owner = app.owner;
  const ownerSettings =
    owner === null || app.ownerLogin === null || manages(owner) !== true
      ? undefined
      : appSettingsPage(app.slug, app.ownerOrg, app.ownerLogin);
  return {
    accounts: accounts.toSorted(
      (a, b) =>
        Number(a.organisation) - Number(b.organisation) || a.account.localeCompare(b.account),
    ),
    ...(app.ownerLogin === null ? {} : { appOwner: app.ownerLogin }),
    ...(ownerSettings === undefined ? {} : { appSettingsUrl: ownerSettings }),
  };
};

// @effect-diagnostics nodeBuiltinImport:off - Effect's crypto has no RSA signing for the App JWT.
import * as NodeCrypto from "node:crypto";

import { RepoSlug } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import { gitHubJson, gitHubRequest, KinGitHubRequestError } from "./githubRest.ts";
import * as Keychain from "./Keychain.ts";
import {
  grantWidening,
  narrowingViolation,
  type KinGitHubPermissionSet,
} from "./KinGitHubPermissions.ts";
import { isScopedRepo, KinGitHubScope } from "./KinGitHubScope.ts";

/** Keychain item `kin-github-app` / `<appId>`, written once by `scripts/kin-github-app.ts`. */
export const KinGitHubAppSecrets = Schema.Struct({
  privateKeyPem: Schema.String,
  webhookSecret: Schema.optional(Schema.String),
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
});
const decodeSecrets = Schema.decodeUnknownOption(Schema.fromJsonString(KinGitHubAppSecrets));
const INSTALLATIONS_PAGE_SIZE = 100;

const isRepoSlug = Schema.is(RepoSlug);
const PermissionMap = Schema.Record(Schema.String, Schema.String);

const AppResponse = Schema.Struct({
  id: Schema.Int,
  slug: Schema.String,
  name: Schema.String,
  owner: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  permissions: PermissionMap,
  events: Schema.Array(Schema.String),
});
export type KinGitHubAppInfo = typeof AppResponse.Type;

const InstallationResponse = Schema.Struct({
  id: Schema.Int,
  account: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  repository_selection: Schema.Literals(["all", "selected"]),
  permissions: PermissionMap,
  events: Schema.Array(Schema.String),
});
export type KinGitHubInstallation = typeof InstallationResponse.Type;

const AccessTokenResponse = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.String,
  permissions: PermissionMap,
  repository_selection: Schema.optional(Schema.String),
  repositories: Schema.optional(Schema.Array(Schema.Struct({ full_name: Schema.String }))),
});
const decodeAccessToken = Schema.decodeUnknownOption(AccessTokenResponse);
const MintedToken = Schema.Struct({ token: Schema.String });
const decodeMintedToken = Schema.decodeUnknownOption(MintedToken);

export class KinGitHubAppNotConfiguredError extends Schema.TaggedError<KinGitHubAppNotConfiguredError>()(
  "KinGitHubAppNotConfiguredError",
  { appId: Schema.String },
) {
  override get message(): string {
    return `The Kin GitHub App ${this.appId} has no private key in the OS keychain. Run scripts/kin-github-app.ts on this machine.`;
  }
}

export class KinGitHubTokenNarrowingError extends Schema.TaggedError<KinGitHubTokenNarrowingError>()(
  "KinGitHubTokenNarrowingError",
  {
    repo: Schema.String,
    // Built only from permission names and levels.
    reason: Schema.String,
    stage: Schema.Literals(["request", "installation", "granted"]),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "request":
        return `Refused a Kin App token for ${this.repo}: ${this.reason}.`;
      case "installation":
        return `Refused a Kin App token for ${this.repo}: ${this.reason}. Set the installation to Only select repositories.`;
      case "granted":
        return `GitHub granted a Kin App token for ${this.repo} wider than asked (${this.reason}); it was revoked.`;
    }
  }
}

export type KinGitHubAppError =
  | KinGitHubAppNotConfiguredError
  | KinGitHubTokenNarrowingError
  | KinGitHubRequestError
  | Keychain.KinKeychainError;

export interface KinInstallationToken {
  readonly token: Redacted.Redacted<string>;
  readonly repo: RepoSlug;
  readonly expiresAt: string;
  readonly permissions: Readonly<Record<string, string>>;
}

const AppId = Schema.String.check(
  Schema.makeFilter((value: string) => /^[1-9][0-9]{0,11}$/.test(value), {
    expected: "a numeric GitHub App id",
  }),
);

export class KinGitHubAppConfig extends Context.Service<
  KinGitHubAppConfig,
  { readonly appId: string }
>()("t3/kin/github/KinGitHubApp/KinGitHubAppConfig") {
  static readonly layer = Layer.effect(
    KinGitHubAppConfig,
    Config.all({
      appId: Config.schema(AppId, "KIN_GITHUB_APP_ID"),
    }),
  );
}

/** The bot App's credentials. No method returns the private key or an unnarrowed token. */
export class KinGitHubApp extends Context.Service<
  KinGitHubApp,
  {
    readonly app: Effect.Effect<KinGitHubAppInfo, KinGitHubAppError>;
    readonly installations: Effect.Effect<ReadonlyArray<KinGitHubInstallation>, KinGitHubAppError>;
    /**
     * A one-hour token for one scoped repository with only `permissions`, which must sit inside
     * the App's table. Workers that read untrusted input should ask for `{ contents: "read" }`.
     * A lead never gets `contents: write`: with it, it could merge once the owner has reviewed.
     */
    readonly installationToken: (input: {
      readonly repo: RepoSlug;
      readonly permissions: KinGitHubPermissionSet;
      readonly holder: KinGitHubTokenHolder;
    }) => Effect.Effect<KinInstallationToken, KinGitHubAppError>;
    /**
     * `PATCH /app/hook/config`, signed with the App JWT: points the App's own webhook (the
     * triggers spec's `github.app_hook.configure`). The secret is sent and never logged.
     */
    readonly patchHookConfig: (body: {
      readonly url: string;
      readonly content_type: "json";
      readonly insecure_ssl: "0";
      readonly secret?: Redacted.Redacted<string>;
    }) => Effect.Effect<void, KinGitHubAppError>;
  }
>()("t3/kin/github/KinGitHubApp") {}

/** Who will hold the token: a lead session, or a worker it started. */
// `server` tokens stay in Kin's own process for its own pushes; they never reach an agent.
export type KinGitHubTokenHolder = "lead" | "worker" | "server";

const base64Url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** RS256 App JWT; GitHub accepts at most 10 minutes and recommends backdating `iat` a minute. */
function signAppJwt(input: {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly nowSeconds: number;
}): Redacted.Redacted<string> {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: input.nowSeconds - 60, exp: input.nowSeconds + 540, iss: input.appId }),
  );
  const signature = NodeCrypto.sign(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    input.privateKeyPem,
  ).toString("base64url");
  return Redacted.make(`${header}.${payload}.${signature}`);
}

const make = Effect.gen(function* () {
  const { appId } = yield* KinGitHubAppConfig;
  const keychain = yield* Keychain.KinKeychain;
  const client = yield* HttpClient.HttpClient;
  const scope = yield* KinGitHubScope;

  const jwt = Effect.gen(function* () {
    const stored = yield* keychain.get("kin-github-app", appId);
    const secrets = Option.flatMap(stored, (value) => decodeSecrets(Redacted.value(value)));
    if (Option.isNone(secrets)) return yield* new KinGitHubAppNotConfiguredError({ appId });
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    return signAppJwt({ appId, privateKeyPem: secrets.value.privateKeyPem, nowSeconds });
  });

  const app = Effect.gen(function* () {
    const token = yield* jwt;
    const response = yield* gitHubJson({
      client,
      operation: "app.get",
      method: "GET",
      path: "/app",
      token,
      schema: AppResponse,
    });
    return response.body;
  }).pipe(Effect.withSpan("KinGitHubApp.app"));

  const installations = Effect.gen(function* () {
    const token = yield* jwt;
    const all: Array<KinGitHubInstallation> = [];
    for (let page = 1; ; page++) {
      const response = yield* gitHubJson({
        client,
        operation: "app.installations",
        method: "GET",
        path: `/app/installations?per_page=${INSTALLATIONS_PAGE_SIZE}&page=${page}`,
        token,
        schema: Schema.Array(InstallationResponse),
      });
      all.push(...response.body);
      if (response.body.length < INSTALLATIONS_PAGE_SIZE) return all;
    }
  }).pipe(Effect.withSpan("KinGitHubApp.installations"));

  // Best effort: a token that can't be revoked still expires within the hour.
  const revoke = (repo: RepoSlug, token: Redacted.Redacted<string>) =>
    client.execute(gitHubRequest("DELETE", "/installation/token", token)).pipe(
      Effect.flatMap((response) =>
        response.status === 204
          ? Effect.void
          : Effect.logWarning("Could not revoke a Kin App token", {
              repo,
              status: response.status,
            }),
      ),
      Effect.catch(() =>
        Effect.logWarning("Could not reach GitHub to revoke a Kin App token", { repo }),
      ),
    );

  const installationToken = Effect.fn("KinGitHubApp.installationToken")(function* (input: {
    readonly repo: RepoSlug;
    readonly permissions: KinGitHubPermissionSet;
    readonly holder: KinGitHubTokenHolder;
  }) {
    yield* Effect.annotateCurrentSpan({
      "kin.github.repo": input.repo,
      "kin.github.holder": input.holder,
    });
    const violation = !isRepoSlug(input.repo)
      ? "not an owner/name repository"
      : !isScopedRepo(scope.repos, input.repo)
        ? "not a repository in KIN_GITHUB_REPOS"
        : input.holder !== "server" && input.permissions.contents === "write"
          ? "an agent's token can't have contents: write"
          : narrowingViolation(input.permissions);
    if (violation !== null) {
      return yield* new KinGitHubTokenNarrowingError({
        repo: input.repo,
        reason: violation,
        stage: "request",
      });
    }
    const [owner, name] = input.repo.split("/") as [string, string];
    const appToken = yield* jwt;
    const installation = yield* gitHubJson({
      client,
      operation: "repos.installation",
      method: "GET",
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      token: appToken,
      schema: Schema.Struct({
        id: Schema.Int,
        repository_selection: Schema.Literals(["all", "selected"]),
      }),
    });
    if (installation.body.repository_selection !== "selected") {
      return yield* new KinGitHubTokenNarrowingError({
        repo: input.repo,
        reason: "the App is installed on all of the account's repositories",
        stage: "installation",
      });
    }
    const minted = yield* gitHubJson({
      client,
      operation: "installations.accessToken",
      method: "POST",
      path: `/app/installations/${installation.body.id}/access_tokens`,
      token: appToken,
      body: { repositories: [name], permissions: input.permissions },
      schema: Schema.Unknown,
      okStatuses: [201],
    });
    const body = decodeAccessToken(minted.body);
    if (Option.isNone(body)) {
      // GitHub minted something; revoke it if the token can be found before failing.
      const stray = decodeMintedToken(minted.body);
      if (Option.isSome(stray)) yield* revoke(input.repo, Redacted.make(stray.value.token));
      return yield* new KinGitHubRequestError({
        operation: "installations.accessToken",
        stage: "decode",
        status: minted.status,
      });
    }
    const token = Redacted.make(body.value.token);
    const repositories = (body.value.repositories ?? []).map((repo) =>
      repo.full_name.toLowerCase(),
    );
    const wider =
      repositories.length !== 1 || repositories[0] !== input.repo.toLowerCase()
        ? `repositories: ${repositories.length === 0 ? "all" : repositories.length}`
        : grantWidening(input.permissions, body.value.permissions);
    if (wider !== null) {
      yield* revoke(input.repo, token);
      return yield* new KinGitHubTokenNarrowingError({
        repo: input.repo,
        reason: wider,
        stage: "granted",
      });
    }
    return {
      token,
      repo: input.repo,
      expiresAt: body.value.expires_at,
      permissions: body.value.permissions,
    } satisfies KinInstallationToken;
  });

  const patchHookConfig = Effect.fn("KinGitHubApp.patchHookConfig")(function* (body: {
    readonly url: string;
    readonly content_type: "json";
    readonly insecure_ssl: "0";
    readonly secret?: Redacted.Redacted<string>;
  }) {
    yield* gitHubJson({
      client,
      operation: "apps.updateWebhookConfig",
      method: "PATCH",
      path: "/app/hook/config",
      token: yield* jwt,
      body: {
        url: body.url,
        content_type: body.content_type,
        insecure_ssl: body.insecure_ssl,
        ...(body.secret === undefined ? {} : { secret: Redacted.value(body.secret) }),
      },
      // GitHub echoes the config with the secret masked; nothing in it is needed.
      schema: Schema.Unknown,
    });
  });

  return KinGitHubApp.of({ app, installations, installationToken, patchHookConfig });
});

export const layer = Layer.effect(KinGitHubApp, make);

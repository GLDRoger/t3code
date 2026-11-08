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

import { gitHubJson, gitHubRequest, type KinGitHubRequestError } from "./githubRest.ts";
import * as Keychain from "./Keychain.ts";
import {
  narrowingViolation,
  type KinGitHubAccess,
  type KinGitHubPermissionSet,
} from "./KinGitHubPermissions.ts";

/** Keychain item `kin-github-app` / `<appId>`, written once by `scripts/kin-github-app.ts`. */
export const KinGitHubAppSecrets = Schema.Struct({
  privateKeyPem: Schema.String,
  webhookSecret: Schema.optional(Schema.String),
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
});
const decodeSecrets = Schema.decodeUnknownOption(Schema.fromJsonString(KinGitHubAppSecrets));

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
    stage: Schema.Literals(["request", "granted"]),
  },
) {
  override get message(): string {
    return this.stage === "request"
      ? `Refused a Kin App token for ${this.repo}: ${this.reason}.`
      : `GitHub granted a Kin App token for ${this.repo} wider than asked (${this.reason}); it was revoked.`;
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
     * A one-hour token for one repository with only `permissions`, which must sit inside the
     * App's table. Workers that read untrusted input should ask for `{ contents: "read" }`.
     */
    readonly installationToken: (input: {
      readonly repo: RepoSlug;
      readonly permissions: KinGitHubPermissionSet;
    }) => Effect.Effect<KinInstallationToken, KinGitHubAppError>;
  }
>()("t3/kin/github/KinGitHubApp") {}

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

const widening = (
  requested: KinGitHubPermissionSet,
  granted: Readonly<Record<string, string>>,
): string | null => {
  const asked: Readonly<Record<string, KinGitHubAccess | undefined>> = requested;
  for (const [name, level] of Object.entries(granted)) {
    // GitHub adds metadata: read to every narrowed token.
    if (name === "metadata" && level === "read") continue;
    const want = asked[name];
    if (want === undefined) return `${name}: ${level} was not asked for`;
    if (want === "read" && level !== "read") return `${name}: ${level} exceeds read`;
  }
  return null;
};

const make = Effect.gen(function* () {
  const { appId } = yield* KinGitHubAppConfig;
  const keychain = yield* Keychain.KinKeychain;
  const client = yield* HttpClient.HttpClient;

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
    const response = yield* gitHubJson({
      client,
      operation: "app.installations",
      method: "GET",
      path: "/app/installations?per_page=100",
      token,
      schema: Schema.Array(InstallationResponse),
    });
    return response.body;
  }).pipe(Effect.withSpan("KinGitHubApp.installations"));

  const installationToken = Effect.fn("KinGitHubApp.installationToken")(function* (input: {
    readonly repo: RepoSlug;
    readonly permissions: KinGitHubPermissionSet;
  }) {
    yield* Effect.annotateCurrentSpan({ "kin.github.repo": input.repo });
    const violation = isRepoSlug(input.repo)
      ? narrowingViolation(input.permissions)
      : "not an owner/name repository";
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
      schema: Schema.Struct({ id: Schema.Int }),
    });
    const minted = yield* gitHubJson({
      client,
      operation: "installations.accessToken",
      method: "POST",
      path: `/app/installations/${installation.body.id}/access_tokens`,
      token: appToken,
      body: { repositories: [name], permissions: input.permissions },
      schema: AccessTokenResponse,
      okStatuses: [201],
    });
    const token = Redacted.make(minted.body.token);
    const repositories = (minted.body.repositories ?? []).map((repo) =>
      repo.full_name.toLowerCase(),
    );
    const wider =
      repositories.length !== 1 || repositories[0] !== input.repo.toLowerCase()
        ? `repositories: ${repositories.length === 0 ? "all" : repositories.length}`
        : widening(input.permissions, minted.body.permissions);
    if (wider !== null) {
      yield* client
        .execute(gitHubRequest("DELETE", "/installation/token", token))
        .pipe(Effect.ignore);
      return yield* new KinGitHubTokenNarrowingError({
        repo: input.repo,
        reason: wider,
        stage: "granted",
      });
    }
    return {
      token,
      repo: input.repo,
      expiresAt: minted.body.expires_at,
      permissions: minted.body.permissions,
    } satisfies KinInstallationToken;
  });

  return KinGitHubApp.of({ app, installations, installationToken });
});

export const layer = Layer.effect(KinGitHubApp, make);

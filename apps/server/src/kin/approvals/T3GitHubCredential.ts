import { requireSettingsSecretLiteral } from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import type { HostCredentialSettings } from "@t3tools/source-control-core/shared/definition";
import { GitHubAppSession } from "@t3tools/source-control-github/server/driver";
import * as GitHubClient from "@t3tools/source-control-github/shared/definition";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";

const HOST = "github.com";
/** How long a read waits for the server to install the reader before failing closed. */
export const INSTALL_TIMEOUT = "30 seconds";

export class T3GitHubCredentialError extends Schema.TaggedError<T3GitHubCredentialError>()(
  "T3GitHubCredentialError",
  // A fixed reason, never the credential or anything GitHub answered.
  { reason: Schema.String },
) {
  override get message(): string {
    return `Could not read T3's GitHub credential (${this.reason}).`;
  }
}

/**
 * Every GitHub credential T3 keeps for github.com, as stored: nothing is refreshed, and the host
 * being disabled in Settings changes nothing, since the stored tokens are still on disk.
 */
export interface T3StoredCredentials {
  /** The token saved in Settings. */
  readonly saved: Option.Option<Redacted.Redacted<string>>;
  /** The app sign-in session. */
  readonly app: Option.Option<{
    readonly accessToken: Redacted.Redacted<string>;
    readonly accessTokenExpiresAt: number | null;
    /** Whether the session holds a refresh token, and until when it can be spent. */
    readonly refreshable: boolean;
    readonly refreshTokenExpiresAt: number | null;
  }>;
  /** The gh account Settings picks for T3's personal credential. */
  readonly account: Option.Option<string>;
  /**
   * Each provider instance's environment as `mergeProviderInstanceEnvironment` builds it over the
   * server's, by the names it sets to something (a secret reference counts as set). Agents and the
   * terminal, which opens any instance's environment, enabled or not, inherit these.
   */
  readonly providerEnvironments: ReadonlyArray<{
    readonly instance: string;
    readonly names: ReadonlyArray<string>;
  }>;
  /** Every project's workspace root, where agents run git with that repository's own config. */
  readonly projectRoots: ReadonlyArray<string>;
}
type ReadT3Credential = Effect.Effect<T3StoredCredentials, T3GitHubCredentialError>;

/**
 * T3's stored GitHub credentials. The executor is built before the server's source control host,
 * so the server installs the reader later (`install`, once); a read waits up to
 * `INSTALL_TIMEOUT` for it, then fails, and so does the credential check.
 */
export class T3GitHubCredential extends Context.Service<
  T3GitHubCredential,
  {
    readonly read: ReadT3Credential;
    /** Installs the reader; any later call is ignored. */
    readonly install: (read: ReadT3Credential) => Effect.Effect<void>;
  }
>()("t3/kin/approvals/T3GitHubCredential") {}

export const slotLayer = Layer.effect(
  T3GitHubCredential,
  Effect.gen(function* () {
    const installed = yield* Deferred.make<ReadT3Credential>();
    return T3GitHubCredential.of({
      read: Deferred.await(installed).pipe(
        Effect.timeoutOrElse({
          duration: INSTALL_TIMEOUT,
          orElse: () =>
            Effect.fail(new T3GitHubCredentialError({ reason: "the reader isn't installed" })),
        }),
        Effect.flatten,
      ),
      install: Effect.fn("T3GitHubCredential.install")(function* (read: ReadT3Credential) {
        yield* Deferred.succeed(installed, read);
      }),
    });
  }),
);

const decodeSettings = Schema.decodeUnknownOption(GitHubClient.settings);
const decodeSession = Schema.decodeUnknownOption(Schema.fromJsonString(GitHubAppSession));

/** Reads Settings directly: the request policy would refresh the app session and spend its token. */
const readStored = Effect.fn("T3GitHubCredential.read")(function* (
  host: SourceControlHost.SourceControlHost["Service"],
  projects: ProjectStoreV2["Service"],
  serverEnv: NodeJS.ProcessEnv,
) {
  const fail = (reason: string) => Effect.fail(new T3GitHubCredentialError({ reason }));
  const settings = yield* host.settings
    .getWithSecrets(GitHubClient.definition.kind)
    .pipe(Effect.catch(() => fail("Settings can't be read")));
  const raw = settings.sourceControlHosts[GitHubClient.definition.kind];
  // Settings that don't decode read as empty elsewhere; here that would hide a token.
  const github = decodeSettings(raw ?? {});
  if (Option.isNone(github)) return yield* fail("the GitHub settings can't be decoded");
  // Every credential field upstream keeps: a new one fails to compile here until it is read.
  const { tokens, signIns, hosts } = {
    tokens: github.value.tokens,
    signIns: github.value.signIns,
    hosts: github.value.hosts,
  } satisfies Record<keyof HostCredentialSettings, unknown>;
  const token = yield* requireSettingsSecretLiteral(tokens[HOST], settings.secretProviders).pipe(
    Effect.catch(() => fail("the saved token's secret can't be resolved")),
  );
  // An empty sign-in is signed out, as upstream reads it.
  const signIn = signIns[HOST]?.trim() ?? "";
  const session = signIn === "" ? Option.none() : decodeSession(signIn);
  if (signIn !== "" && Option.isNone(session)) {
    return yield* fail("the app sign-in can't be decoded");
  }
  // Built-in instances without an entry, and project overrides, set no variables.
  const providerEnvironments = yield* Effect.forEach(
    Object.entries(settings.providerInstances),
    ([instance, config]) =>
      mergeProviderInstanceEnvironment(
        (config.environment ?? []).map((variable) =>
          typeof variable.value === "string" ? variable : { ...variable, value: "secret" },
        ),
        serverEnv,
      ).pipe(
        Effect.map((env) => ({
          instance,
          names: Object.keys(env).filter((name) => (env[name]?.trim() ?? "") !== ""),
        })),
      ),
  );
  const projectRoots = yield* projects.list().pipe(
    Effect.map((rows) => rows.map((row) => row.workspaceRoot)),
    Effect.catch(() => fail("the project list can't be read")),
  );
  return {
    saved: token.trim() === "" ? Option.none() : Option.some(Redacted.make(token.trim())),
    app: Option.map(session, (value) => ({
      accessToken: Redacted.make(value.accessToken),
      accessTokenExpiresAt: value.accessTokenExpiresAt,
      refreshable: value.refreshToken !== null && value.refreshToken !== "",
      refreshTokenExpiresAt: value.refreshTokenExpiresAt,
    })),
    account: Option.fromNullishOr(hosts[HOST]?.account),
    providerEnvironments,
    projectRoots,
  } satisfies T3StoredCredentials;
});

export const installLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const slot = yield* T3GitHubCredential;
    yield* slot.install(
      readStored(
        yield* SourceControlHost.SourceControlHost,
        yield* ProjectStoreV2,
        yield* HostProcess.Environment,
      ),
    );
  }),
);

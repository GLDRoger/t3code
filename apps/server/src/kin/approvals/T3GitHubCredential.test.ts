import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettingsError,
  type ServerSettings,
} from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import * as T3GitHubCredential from "./T3GitHubCredential.ts";

const session = (accessToken: string) =>
  JSON.stringify({
    accessToken,
    accessTokenExpiresAt: 1_000,
    refreshToken: "ghr_refresh",
    refreshTokenExpiresAt: 2_000,
  });

const isSettingsError = Schema.is(ServerSettingsError);

/** The slot with the server's reader installed over Settings that read as `github`. */
const slotOver = (
  github: unknown | ServerSettingsError,
  rest: {
    readonly providerInstances?: unknown;
    readonly projectRoots?: ReadonlyArray<string> | "unreadable";
  } = {},
) =>
  Effect.gen(function* () {
    const projects = ProjectStoreV2.of({
      list: () =>
        rest.projectRoots === "unreadable"
          ? Effect.die("unused")
          : Effect.succeed((rest.projectRoots ?? []).map((workspaceRoot) => ({ workspaceRoot }))),
    } as unknown as ProjectStoreV2["Service"]);
    const host = SourceControlHost.SourceControlHost.of({
      settings: {
        getWithSecrets: () =>
          isSettingsError(github)
            ? Effect.fail(github)
            : Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                ...(rest.providerInstances === undefined
                  ? {}
                  : { providerInstances: rest.providerInstances }),
                sourceControlHosts: { github },
              } as unknown as ServerSettings),
      },
    } as unknown as SourceControlHost.SourceControlHost["Service"]);
    const context = yield* Layer.build(
      T3GitHubCredential.installLayer.pipe(
        Layer.provideMerge(T3GitHubCredential.slotLayer),
        Layer.provide(Layer.succeed(SourceControlHost.SourceControlHost, host)),
        Layer.provide(Layer.succeed(ProjectStoreV2, projects)),
      ),
    );
    return Context.get(context, T3GitHubCredential.T3GitHubCredential);
  });

describe("T3GitHubCredential", () => {
  it.effect("reads every stored credential, without refreshing, even with the host disabled", () =>
    Effect.gen(function* () {
      const slot = yield* slotOver({
        hosts: { "github.com": { enabled: false, account: "kin-bot" } },
        tokens: { "github.com": " ghp_saved " },
        signIns: { "github.com": session("ghu_app") },
      });
      const stored = yield* slot.read;
      assert.strictEqual(
        Option.map(stored.saved, Redacted.value).pipe(Option.getOrNull),
        "ghp_saved",
      );
      assert.deepStrictEqual(
        Option.map(stored.app, (app) => ({ ...app, accessToken: Redacted.value(app.accessToken) })),
        Option.some({
          accessToken: "ghu_app",
          accessTokenExpiresAt: 1_000,
          refreshable: true,
          refreshTokenExpiresAt: 2_000,
        }),
      );
      assert.deepStrictEqual(stored.account, Option.some("kin-bot"));
      for (const empty of [{}, { signIns: { "github.com": "" } }]) {
        assert.deepInclude(yield* (yield* slotOver(empty)).read, {
          saved: Option.none(),
          app: Option.none(),
          account: Option.none(),
        });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("reads what each provider instance's environment sets, and every project root", () =>
    Effect.gen(function* () {
      const slot = yield* slotOver(
        {},
        {
          providerInstances: {
            codex: {
              driver: "codex",
              environment: [
                { name: "GITHUB_PERSONAL_ACCESS_TOKEN", value: "ghp_secret_value" },
                { name: "SSH_AUTH_SOCK", value: { provider: "vault", reference: "ssh#sock" } },
                // Blank clears what the server's environment sets.
                { name: "HOME_TOOL", value: " " },
              ],
            },
            claude: { driver: "claudeAgent", enabled: false },
          },
          projectRoots: ["/work/app", "/work/site"],
        },
      ).pipe(Effect.provideService(HostProcess.Environment, { PATH: "/bin", HOME_TOOL: "x" }));
      const stored = yield* slot.read;
      assert.deepStrictEqual(stored.providerEnvironments, [
        { instance: "codex", names: ["PATH", "GITHUB_PERSONAL_ACCESS_TOKEN", "SSH_AUTH_SOCK"] },
        // Disabled instances count: the terminal opens any instance's environment.
        { instance: "claude", names: ["PATH", "HOME_TOOL"] },
      ]);
      assert.deepStrictEqual(stored.projectRoots, ["/work/app", "/work/site"]);
      assert.notInclude(JSON.stringify(stored.providerEnvironments), "ghp_secret_value");
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    [
      "Settings can't be read",
      new ServerSettingsError({ settingsPath: "s", operation: "read-file" }),
    ],
    ["the GitHub settings don't decode", { tokens: { "github.com": 5 } }],
    [
      "the saved token names a secret that can't be resolved",
      { tokens: { "github.com": { provider: "vault", reference: "gh#token" } } },
    ],
    ["the app sign-in doesn't decode", { signIns: { "github.com": "{not json" } }],
  ] as const)("fails closed when %s", ([, github]) =>
    Effect.gen(function* () {
      const slot = yield* slotOver(github);
      const error = yield* slot.read.pipe(Effect.flip);
      assert.strictEqual(error._tag, "T3GitHubCredentialError");
    }).pipe(Effect.scoped),
  );

  it.effect("waits for the server to install the reader, then fails closed", () =>
    Effect.gen(function* () {
      const slot = Context.get(
        yield* Layer.build(T3GitHubCredential.slotLayer),
        T3GitHubCredential.T3GitHubCredential,
      );
      const empty = {
        saved: Option.none(),
        app: Option.none(),
        account: Option.none(),
        providerEnvironments: [],
        projectRoots: [],
      } satisfies T3GitHubCredential.T3StoredCredentials;
      // A read at startup, before the server installs the reader, gets the reader's answer.
      const early = yield* Effect.forkChild(slot.read);
      yield* TestClock.adjust("10 seconds");
      yield* slot.install(Effect.succeed(empty));
      assert.deepStrictEqual(yield* Fiber.join(early), empty);
      // Installed once: a second reader is ignored.
      yield* slot.install(Effect.die("second reader"));
      assert.deepStrictEqual(yield* slot.read, empty);

      const never = Context.get(
        yield* Layer.build(T3GitHubCredential.slotLayer),
        T3GitHubCredential.T3GitHubCredential,
      );
      const waiting = yield* Effect.forkChild(Effect.flip(never.read));
      yield* TestClock.adjust(T3GitHubCredential.INSTALL_TIMEOUT);
      assert.strictEqual((yield* Fiber.join(waiting)).reason, "the reader isn't installed");
    }).pipe(Effect.scoped),
  );
});

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Setup from "./appSetup.ts";
import { HOOK_EVENTS, KIN_GITHUB_HOOK_ROUTE, KinGitHubHook, make as makeHook } from "./appHook.ts";
import { emptyWorld, FakeGitHub } from "./fakeGitHub.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as AppKey from "./appKey.ts";
import { KinKeychain } from "./Keychain.ts";
import { KinGitHubApp, KinGitHubAppConfig, make as makeApp } from "./KinGitHubApp.ts";
import { appKeyJson, fakeHttp, installApp } from "./KinGitHubApp.testkit.ts";

const orgId = KinOrgId.make("org-setup");
const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);
const owner = { _tag: "person" as const, orgId, personId: KinPersonId.make("owner") };
const member = { _tag: "person" as const, orgId, personId: KinPersonId.make("member") };
const ORIGIN = "https://kin.invented.example";
const PUBLIC = "https://kin.public.example.test";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = "2026-11-01T00:00:00.000Z";
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Studio', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES ('owner', ${orgId}, 'owner', 'Owner', ${at}, 'owner'),
      ('member', ${orgId}, 'member', 'Member', ${at}, 'member')`;
});

/** Kin with no App yet, over the fake GitHub, keeping the key in a real secret store. */
const setup = (options: { readonly hostAppId?: string } = {}) =>
  Effect.gen(function* () {
    yield* seed;
    yield* TestClock.setTime(T0);
    const github = new FakeGitHub(emptyWorld("invented-owner", T0));
    github.world.manifestCodes = {
      "code-1": { name: "Kin for Invented Studio", slug: "kin-for-invented-studio" },
    };
    const store = yield* ServerSecretStore.ServerSecretStore;
    const appKey = yield* AppKey.make.pipe(
      Effect.provideService(KinKeychain, { appSecret: () => Effect.succeedNone }),
    );
    const kept = (appId: string) =>
      store
        .get(AppKey.appKeyName(appId))
        .pipe(Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))));
    const services = Layer.mergeAll(
      Layer.succeed(AppKey.KinGitHubAppKey, appKey),
      Layer.succeed(KinGitHubAppConfig, {
        appId: Option.fromNullishOr(options.hostAppId),
        botLogin: Option.none(),
      }),
      fakeHttp(github),
      Layer.mock(KinIdentity)({
        owner: { orgId, personId: KinPersonId.make("owner") } as never,
        isAgentThread: () => false,
        isLeadThread: () => false,
      }),
      Layer.succeed(KinRefreshObserver, { touch: () => Effect.void }),
    );
    /** Kin starting, as at boot or after a restart over the same state. */
    const boot = Effect.gen(function* () {
      const app = yield* makeApp.pipe(Effect.provide(services));
      const hook = yield* makeHook.pipe(Effect.provideService(KinGitHubApp, app));
      const flow = yield* Setup.make.pipe(
        Effect.provide(services),
        Effect.provideService(KinGitHubApp, app),
        Effect.provideService(KinGitHubHook, hook),
      );
      yield* app.refresh();
      return { app, flow };
    });
    const { app, flow } = yield* boot;
    return { github, kept, store, app, flow, boot };
  });

const layer = KinPersistence.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-github-app-setup-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

describe("making Kin's GitHub App from Settings", () => {
  it.effect("only the owner level starts it", () =>
    Effect.gen(function* () {
      const { flow } = yield* setup();
      const refused = yield* Effect.flip(flow.start([member], orgId));
      assert.strictEqual(refused.reason, "not_allowed");
      const started = yield* flow.start([owner], orgId);
      assert.strictEqual(started.name, "Kin for Invented Studio");
      assert.match(started.path, /^\/api\/kin\/github-app\/new\?state=[\w-]{20,}$/);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "posts a manifest that comes back to the owner's own Kin, with a webhook only where Kin has a public address",
    () =>
      Effect.gen(function* () {
        const { flow } = yield* setup();
        const manifestOf = Effect.fn("test.manifestOf")(function* (name: string) {
          const { path } = yield* flow.start([owner], orgId);
          const state = new URL(path, ORIGIN).searchParams.get("state") ?? "";
          const page = Option.getOrThrow(yield* flow.page(state, name, ORIGIN));
          assert.include(page, `action="https://github.com/settings/apps/new?state=${state}"`);
          return JSON.parse(
            (/name="manifest" value="([^"]+)"/.exec(page)?.[1] ?? "{}").replaceAll("&quot;", '"'),
          ) as Record<string, unknown>;
        });
        assert.isTrue(Option.isNone(yield* flow.page("forged", "", ORIGIN)));
        const manifest = yield* manifestOf("  Kin   for Studio ");
        assert.strictEqual(manifest.name, "Kin for Studio");
        assert.strictEqual(manifest.redirect_url, `${ORIGIN}/api/kin/github-app/created`);
        assert.isUndefined(manifest.hook_attributes);
        assert.deepStrictEqual(manifest.default_events, []);
        assert.notProperty(manifest.default_permissions as object, "administration");

        // The webhook goes to Kin's own public address, never the browser's origin.
        const hooked = yield* manifestOf("").pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ KIN_ENABLED: true, KIN_PUBLIC_URL: PUBLIC }),
            ),
          ),
        );
        assert.deepStrictEqual(hooked.hook_attributes, {
          url: `${PUBLIC}${KIN_GITHUB_HOOK_ROUTE}`,
          active: true,
        });
        assert.deepStrictEqual(hooked.default_events, Object.keys(HOOK_EVENTS));
        assert.strictEqual(hooked.redirect_url, `${ORIGIN}/api/kin/github-app/created`);
        assert.deepStrictEqual(hooked.default_permissions, manifest.default_permissions);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "spends the state before the code, uses the code once, and keeps the key only in the secret store",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig;
        const { github, kept, app, flow } = yield* setup();
        const conversions = () =>
          github.world.calls.filter((call) => call.startsWith("POST app-manifests/")).length;

        const forged = yield* flow.complete("forged", "code-1");
        assert.isFalse(forged.ok);
        assert.strictEqual(conversions(), 0);

        const state = new URL((yield* flow.start([owner], orgId)).path, ORIGIN).searchParams.get(
          "state",
        )!;
        const done = yield* flow.complete(state, "code-1");
        assert.isTrue(done.ok);
        assert.strictEqual(done.title, "Kin for Invented Studio is set up");
        assert.match(
          Option.getOrElse(yield* kept("9100"), () => ""),
          /BEGIN RSA PRIVATE KEY/,
        );
        const stored = yield* fs.readFileString(`${stateDir}/kin/gh-app/app.json`);
        assert.include(stored, '"appId":9100');
        assert.include(stored, '"by":"Owner"');
        assert.notInclude(stored, "PRIVATE KEY");
        assert.notInclude(JSON.stringify(done), "PRIVATE KEY");
        assert.deepStrictEqual(yield* app.origin!(), {
          source: "kin",
          app: JSON.parse(stored),
        });
        // In use straight away: no env line, no restart.
        assert.strictEqual((yield* app.state())._tag, "ok");

        // The same redirect again reaches nothing: the state is spent.
        const replay = yield* flow.complete(state, "code-1");
        assert.isFalse(replay.ok);
        assert.strictEqual(conversions(), 1);
        // A second App can't be started over this one.
        assert.match((yield* Effect.flip(flow.start([owner], orgId))).message, /already has/);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("a code GitHub already spent leaves nothing behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig;
      const { github, kept, flow } = yield* setup();
      github.world.manifestCodes = {};
      const state = new URL((yield* flow.start([owner], orgId)).path, ORIGIN).searchParams.get(
        "state",
      )!;
      const outcome = yield* flow.complete(state, "code-1");
      assert.isFalse(outcome.ok);
      assert.match(outcome.detail, /status 404/);
      assert.isTrue(Option.isNone(yield* kept("9100")));
      assert.isFalse(yield* fs.exists(`${stateDir}/kin/gh-app/app.json`));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("disconnecting forgets the id and key, and says where the App can be deleted", () =>
    Effect.gen(function* () {
      const { kept, app, flow } = yield* setup();
      const state = new URL((yield* flow.start([owner], orgId)).path, ORIGIN).searchParams.get(
        "state",
      )!;
      yield* flow.complete(state, "code-1");
      assert.strictEqual(
        (yield* Effect.flip(flow.disconnect([member], orgId))).reason,
        "not_allowed",
      );
      assert.deepStrictEqual(yield* flow.disconnect([owner], orgId), {
        settingsUrl: "https://github.com/settings/apps/kin-for-invented-studio",
      });
      assert.isTrue(Option.isNone(yield* kept("9100")));
      assert.deepStrictEqual(yield* app.origin!(), { source: "none" });
      assert.deepStrictEqual(yield* app.state(), { _tag: "none" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "an App the host's environment names is adopted once; Settings owns it after, and its Disconnect outlives a restart",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig;
        const file = `${stateDir}/kin/gh-app/app.json`;
        const { github, kept, store, boot } = yield* setup({ hostAppId: "9001" });
        // A host set up through its environment, its key already copied into the store.
        installApp(github, []);
        github.world.accounts = [{ login: "Invented-Owner", id: 7000, type: "User" }];
        yield* store.set(AppKey.appKeyName("9001"), new TextEncoder().encode(appKeyJson()));
        const first = yield* boot;
        assert.strictEqual((yield* first.app.state())._tag, "ok");
        assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(file)), {
          appId: 9001,
          slug: "invented-kin",
          name: "Invented Kin",
          owner: "Invented-Owner",
          botLogin: "invented-kin[bot]",
          at: null,
          by: null,
        });
        assert.strictEqual((yield* first.app.origin!()).source, "kin");
        assert.match((yield* Effect.flip(first.flow.start([owner], orgId))).message, /already has/);

        assert.deepStrictEqual(yield* first.flow.disconnect([owner], orgId), {
          settingsUrl: "https://github.com/settings/apps/invented-kin",
        });
        assert.isTrue(Option.isNone(yield* kept("9001")));
        // The environment still names the App; a restart leaves it disconnected.
        const second = yield* boot;
        assert.deepStrictEqual(yield* second.app.origin!(), { source: "none" });
        assert.deepStrictEqual(yield* second.app.state(), { _tag: "none" });
        assert.isFalse(yield* fs.exists(file));

        // A new App made in Settings stays Kin's App across the next start too.
        github.world.manifestCodes = {
          "code-1": { name: "Kin for Invented Studio", slug: "kin-for-invented-studio" },
        };
        const state = new URL(
          (yield* second.flow.start([owner], orgId)).path,
          ORIGIN,
        ).searchParams.get("state")!;
        assert.isTrue((yield* second.flow.complete(state, "code-1")).ok);
        const third = yield* boot;
        const origin = yield* third.app.origin!();
        assert.strictEqual(origin.source === "kin" ? origin.app.appId : null, 9100);
      }).pipe(Effect.provide(layer)),
  );
});

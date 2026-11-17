import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Setup from "./appSetup.ts";
import { emptyWorld, FakeGitHub } from "./fakeGitHub.ts";
import { KinKeychain } from "./Keychain.ts";
import { KinGitHubApp, KinGitHubAppConfig, make as makeApp } from "./KinGitHubApp.ts";
import { fakeHttp } from "./KinGitHubApp.testkit.ts";

const orgId = KinOrgId.make("org-setup");
const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);
const owner = { _tag: "person" as const, orgId, personId: KinPersonId.make("owner") };
const member = { _tag: "person" as const, orgId, personId: KinPersonId.make("member") };
const ORIGIN = "https://kin.invented.example";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = "2026-11-01T00:00:00.000Z";
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Studio', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES ('owner', ${orgId}, 'owner', 'Owner', ${at}, 'owner'),
      ('member', ${orgId}, 'member', 'Member', ${at}, 'member')`;
});

/** Kin with no App yet, over the fake GitHub, with a keyring that keeps what it is given. */
const setup = (options: { readonly keyring?: boolean; readonly hostAppId?: string } = {}) =>
  Effect.gen(function* () {
    yield* seed;
    yield* TestClock.setTime(T0);
    const github = new FakeGitHub(emptyWorld("invented-owner", T0));
    github.world.manifestCodes = {
      "code-1": { name: "Kin for Invented Studio", slug: "kin-for-invented-studio" },
    };
    const kept = new Map<string, string>();
    const services = Layer.mergeAll(
      Layer.succeed(KinKeychain, {
        appSecret: (appId: string) =>
          Effect.succeed(Option.fromNullishOr(kept.get(appId)).pipe(Option.map(Redacted.make))),
        writable: () => Effect.succeed(options.keyring !== false),
        setAppSecret: (appId: string, secret: Redacted.Redacted<string>) =>
          Effect.sync(() => void kept.set(appId, Redacted.value(secret))),
        removeAppSecret: (appId: string) => Effect.sync(() => void kept.delete(appId)),
      }),
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
    const app = yield* makeApp.pipe(Effect.provide(services));
    const flow = yield* Setup.make.pipe(
      Effect.provide(services),
      Effect.provideService(KinGitHubApp, app),
    );
    return { github, kept, app, flow };
  });

const layer = KinPersistence.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-github-app-setup-" })),
  Layer.provideMerge(NodeServices.layer),
);

describe("making Kin's GitHub App from Settings", () => {
  it.effect("only the owner level starts it, and only with a keyring to keep the key", () =>
    Effect.gen(function* () {
      const { flow } = yield* setup();
      const refused = yield* Effect.flip(flow.start([member], orgId));
      assert.strictEqual(refused.reason, "not_allowed");
      const started = yield* flow.start([owner], orgId);
      assert.strictEqual(started.name, "Kin for Invented Studio");
      assert.match(started.path, /^\/api\/kin\/github-app\/new\?state=[\w-]{20,}$/);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("says plainly when this computer has no keyring", () =>
    Effect.gen(function* () {
      const { flow } = yield* setup({ keyring: false });
      const refused = yield* Effect.flip(flow.start([owner], orgId));
      assert.match(refused.message, /no keyring Kin can keep the App's key in/);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("posts a manifest that needs no webhook and comes back to the owner's own Kin", () =>
    Effect.gen(function* () {
      const { flow } = yield* setup();
      const { path } = yield* flow.start([owner], orgId);
      const state = new URL(path, ORIGIN).searchParams.get("state") ?? "";
      assert.isTrue(Option.isNone(yield* flow.page("forged", "", ORIGIN)));
      const page = Option.getOrThrow(yield* flow.page(state, "  Kin   for Studio ", ORIGIN));
      const manifest = JSON.parse(
        (/name="manifest" value="([^"]+)"/.exec(page)?.[1] ?? "{}").replaceAll("&quot;", '"'),
      ) as Record<string, unknown>;
      assert.strictEqual(manifest.name, "Kin for Studio");
      assert.strictEqual(manifest.redirect_url, `${ORIGIN}/api/kin/github-app/created`);
      assert.isUndefined(manifest.hook_attributes);
      assert.deepStrictEqual(manifest.default_events, []);
      assert.notProperty(manifest.default_permissions as object, "administration");
      assert.include(page, `action="https://github.com/settings/apps/new?state=${state}"`);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "spends the state before the code, uses the code once, and keeps the key only in the keyring",
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
        assert.match(kept.get("9100") ?? "", /BEGIN RSA PRIVATE KEY/);
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
      assert.strictEqual(kept.size, 0);
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
      assert.strictEqual(kept.size, 0);
      assert.deepStrictEqual(yield* app.origin!(), { source: "none" });
      assert.deepStrictEqual(yield* app.state(), { _tag: "none" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an App the host names keeps working, and can't be disconnected from Settings", () =>
    Effect.gen(function* () {
      const { flow } = yield* setup({ hostAppId: "9001" });
      assert.match((yield* Effect.flip(flow.start([owner], orgId))).message, /already has/);
      assert.match(
        (yield* Effect.flip(flow.disconnect([owner], orgId))).message,
        /KIN_GITHUB_APP_ID/,
      );
    }).pipe(Effect.provide(layer)),
  );
});

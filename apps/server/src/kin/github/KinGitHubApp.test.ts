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
import { emptyWorld, FakeGitHub } from "./fakeGitHub.ts";
import { agentsView, KinGitHubApp, make, parseOwnerUse } from "./KinGitHubApp.ts";
import { appHost, BOT_EMAIL, BOT_LOGIN, fakeHttp, installApp } from "./KinGitHubApp.testkit.ts";

const orgId = KinOrgId.make("org-app");
const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);
const MINUTE = 60_000;

const INSTALLED = [
  {
    id: 7,
    account: "Invented-Co",
    repos: ["invented-co/app", "invented-co/site"],
    permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      metadata: "read",
      administration: "write",
      organization_secrets: "write",
    },
  },
];

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = "2026-11-01T00:00:00.000Z";
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES ('owner', ${orgId}, 'owner', 'Owner', ${at}, 'owner')`;
});

/** A Kin with the App set up as `host` says, over a fake GitHub that starts at T0. */
const setup = (host: { readonly appId?: string; readonly key?: boolean }, installed = true) =>
  Effect.gen(function* () {
    yield* seed;
    yield* TestClock.setTime(T0);
    const github = new FakeGitHub(emptyWorld("invented-owner", T0));
    if (host.appId !== undefined && installed) installApp(github, INSTALLED);
    const { stateDir } = yield* ServerConfig;
    const folder = `${stateDir}/kin/gh-app`;
    const start = make.pipe(
      Effect.provide(
        Layer.mergeAll(
          appHost(host),
          fakeHttp(github),
          Layer.mock(KinIdentity)({
            owner: { orgId, personId: KinPersonId.make("owner") } as never,
            isAgentThread: () => false,
            isLeadThread: () => false,
          }),
          Layer.succeed(KinRefreshObserver, { touch: () => Effect.void }),
        ),
      ),
    );
    return { github, folder, app: yield* start, restart: start };
  });

const advance = (github: FakeGitHub, ms: number) =>
  Effect.gen(function* () {
    github.tick(ms);
    yield* TestClock.adjust(ms);
  });

const read = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));
  });

const layer = KinPersistence.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-github-app-" })),
  Layer.provideMerge(NodeServices.layer),
);

describe("Kin's GitHub App", () => {
  it.effect("without an App, agents act as the owner and their shell holds nothing of one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { app, folder } = yield* setup({});
      // Left from when an App was set up.
      yield* fs.makeDirectory(`${folder}/tokens`, { recursive: true });
      yield* fs.writeFileString(`${folder}/identity`, `${BOT_LOGIN}\n${BOT_EMAIL}\n`);
      yield* fs.writeFileString(`${folder}/tokens/invented-co`, "ghs_stale");
      yield* app.refresh();
      assert.deepStrictEqual(yield* app.state(), { _tag: "none" });
      assert.isUndefined(yield* read(`${folder}/identity`));
      assert.deepStrictEqual(yield* fs.readDirectory(`${folder}/tokens`), []);
      assert.isUndefined(yield* app.on("invented-co/app"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "an App whose key isn't on this computer leaves agents as the owner, and says why",
    () =>
      Effect.gen(function* () {
        const { app, folder } = yield* setup({ appId: "9001", key: false });
        yield* app.refresh();
        const state = yield* app.state();
        assert.strictEqual(state._tag, "broken");
        assert.match(state._tag === "broken" ? state.problem : "", /agents work as you/);
        assert.isUndefined(yield* read(`${folder}/identity`));
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "an App GitHub refuses says so, and turns on once GitHub answers, installed or not",
    () =>
      Effect.gen(function* () {
        const { app, github, folder } = yield* setup({ appId: "9001" });
        installApp(github, []);
        github.world.down = 401;
        yield* app.refresh();
        const state = yield* app.state();
        assert.strictEqual(state._tag, "broken");
        assert.match(state._tag === "broken" ? state.problem : "", /GitHub refused .*status 401/);
        github.world.down = null;
        yield* app.refresh();
        assert.strictEqual((yield* app.state())._tag, "ok");
        assert.strictEqual(yield* read(`${folder}/identity`), `${BOT_LOGIN}\n${BOT_EMAIL}\n`);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("gives agents' shells the App's identity and a token it renews before it lapses", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { app, github, folder } = yield* setup({ appId: "9001" });
      yield* app.refresh();
      assert.strictEqual(yield* read(`${folder}/identity`), `${BOT_LOGIN}\n${BOT_EMAIL}\n`);
      assert.strictEqual(yield* read(`${folder}/tokens/invented-co`), "ghs_fake_7_1");
      assert.strictEqual((yield* fs.stat(`${folder}/tokens/invented-co`)).mode & 0o777, 0o600);
      // The shell's token can't change settings, whatever the App was granted.
      assert.deepStrictEqual(github.world.app?.minted[0]?.permissions, {
        contents: "write",
        pull_requests: "write",
        issues: "write",
        metadata: "read",
      });

      yield* advance(github, 20 * MINUTE);
      yield* app.refresh();
      assert.strictEqual(yield* read(`${folder}/tokens/invented-co`), "ghs_fake_7_1");
      // Inside half an hour of its end, a new one takes its place.
      yield* advance(github, 15 * MINUTE);
      yield* app.refresh();
      const renewed = yield* read(`${folder}/tokens/invented-co`);
      assert.notStrictEqual(renewed, "ghs_fake_7_1");
      // Long after every token lapsed, the next look hands out one GitHub accepts.
      yield* advance(github, 3 * 60 * MINUTE);
      yield* app.refresh();
      const latest = yield* read(`${folder}/tokens/invented-co`);
      const live = github.world.app?.minted.find((entry) => entry.token === latest);
      assert.isTrue(live !== undefined && live.expiresAt > github.world.now);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("Kin's own posts go out as the App where it is installed, and nowhere else", () =>
    Effect.gen(function* () {
      const { app, github } = yield* setup({ appId: "9001" });
      github.addRepo({ full_name: "invented-co/app" });
      github.openItem({
        repo: "invented-co/app",
        pull: false,
        author: "invented-owner",
        association: "OWNER",
        title: "Flaky test",
      });
      yield* app.refresh();
      const asApp = yield* app.on("Invented-Co/App");
      assert.strictEqual(asApp?.login, BOT_LOGIN);
      // A token past its hour is replaced before Kin posts with it.
      yield* advance(github, 2 * 60 * MINUTE);
      const answer = yield* asApp!.call({
        method: "POST",
        path: "repos/invented-co/app/issues/1/comments",
        body: { body: "On it." },
      });
      assert.strictEqual(answer.status, 401);
      const fresh = yield* app.on("invented-co/app");
      const posted = yield* fresh!.call({
        method: "POST",
        path: "repos/invented-co/app/issues/1/comments",
        body: { body: "On it." },
      });
      assert.strictEqual(posted.status, 201);
      assert.strictEqual(github.world.comments.at(-1)?.user, BOT_LOGIN);
      assert.isUndefined(yield* app.on("invented-co/not-selected"));
      assert.isUndefined(yield* app.on("elsewhere/tool"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "records each kin-as-owner run once, without its secrets, and shows who agents act as",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sql = yield* SqlClient.SqlClient;
        const { app, folder, restart } = yield* setup({ appId: "9001" });
        yield* sql`INSERT INTO kin_github_watch (org_id, login, started_at, since_at, next_at, repos_json)
        VALUES (${orgId}, 'invented-owner', 0, 0, 0,
          '[{"repo":"invented-co/app","fork":false},{"repo":"invented-co/site","fork":false},{"repo":"elsewhere/tool","fork":false}]')`;
        yield* fs.makeDirectory(folder, { recursive: true });
        const lines = [
          `${T0 / 1000}\t101\tTech lead\tinvented-co/app\tgit push origin fix`,
          `${T0 / 1000 + 60}\t102\tTech lead\telsewhere/tool\tgh api -H Authorization: token ghp_abcdef123 repos/elsewhere/tool/issues -f body=x`,
        ];
        yield* fs.writeFileString(
          `${folder}/owner-uses.log`,
          `${lines.join("\n")}\n${T0 / 1000}\t1`,
        );
        yield* app.refresh();
        // A later look, and a restart that reads the file again, record nothing twice.
        yield* app.refresh();
        yield* (yield* restart).refresh();
        const view = yield* agentsView(Option.some(app), orgId);
        assert.deepStrictEqual(view, {
          as: "app",
          appName: "Invented Kin",
          botLogin: BOT_LOGIN,
          installUrl: "https://github.com/apps/invented-kin/installations/new",
          problem: null,
          watched: 3,
          installed: 2,
          without: ["elsewhere/tool"],
          ownerUses: [
            {
              at: T0 + 60_000,
              agent: "Tech lead",
              repo: "elsewhere/tool",
              command: "gh api -H Authorization: [secret] repos/elsewhere/tool/issues -f body=x",
            },
            { at: T0, agent: "Tech lead", repo: "invented-co/app", command: "git push origin fix" },
          ],
        });
        assert.deepStrictEqual(
          (yield* agentsView(Option.none<KinGitHubApp["Service"]>(), orgId)).as,
          "owner",
        );
      }).pipe(Effect.provide(layer)),
  );
});

it("takes the secrets out of a recorded command", () => {
  const command = (text: string) => parseOwnerUse(`1\t2\tTech lead\ta/b\t${text}`)?.command;
  assert.strictEqual(
    command("git push https://x-access-token:ghs_abc@github.com/a/b.git"),
    "git push https://[secret]@github.com/a/b.git",
  );
  assert.strictEqual(
    command("gh auth login --with-token ghp_123abc"),
    "gh auth login --with-token [secret]",
  );
  assert.strictEqual(
    command("curl -H 'Authorization: Bearer abc.def'"),
    "curl -H 'Authorization: [secret]",
  );
  assert.strictEqual(command("env GH_TOKEN=abc gh pr list"), "env GH_TOKEN=[secret] gh pr list");
  assert.isUndefined(parseOwnerUse("not a record"));
});

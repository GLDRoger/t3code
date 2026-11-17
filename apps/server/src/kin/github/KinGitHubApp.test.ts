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
import { setAppRepos } from "./appRepos.ts";
import { KinGitHubApi } from "./GitHubWatch.ts";
import { setRepo } from "./githubWatchStore.ts";
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
        // The account rows have their own tests below.
        const {
          accounts: _accounts,
          appOwner: _owner,
          appSettingsUrl: _settings,
          ...view
        } = yield* agentsView(Option.some(app), orgId);
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

describe("the App's row for each account with watched repos", () => {
  const OWNER = { ownerId: 7000, ownerOrg: false };
  const ORG = { ownerId: 7001, ownerOrg: true, ownerAdmin: true };
  const known = (entries: ReadonlyArray<Record<string, unknown>>) =>
    JSON.stringify(entries.map((entry) => ({ fork: false, ...entry })));
  const watching = (reposJson: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_github_watch (org_id, login, started_at, since_at, next_at, repos_json)
        VALUES (${orgId}, 'invented-owner', 0, 0, 0, ${reposJson})`;
    });
  const REPOS = [
    { repo: "invented-owner/a", ...OWNER },
    { repo: "invented-owner/b", ...OWNER },
    { repo: "invented-owner/c", ...OWNER },
    { repo: "invented-co/app", ...ORG },
    { repo: "invented-co/site", ...ORG },
  ];
  const PERMISSIONS = { contents: "write", metadata: "read" };
  const world = (github: FakeGitHub) => {
    github.world.accounts = [
      { login: "invented-owner", id: 7000, type: "User" },
      { login: "invented-co", id: 7001, type: "Organization", role: "admin" },
    ];
    for (const { repo } of REPOS) github.addRepo({ full_name: repo });
    github.addRepo({ full_name: "invented-owner/kin-memory" });
  };
  const rows = (app: KinGitHubApp["Service"]) =>
    agentsView(Option.some(app), orgId).pipe(
      Effect.map(({ accounts, appOwner, appSettingsUrl }) => ({
        accounts,
        appOwner,
        appSettingsUrl,
      })),
    );

  it.effect(
    "only selected on the user's account with no watched repo, not on the organisation; then each switched to all",
    () =>
      Effect.gen(function* () {
        const { github, app } = yield* setup({ appId: "9001" }, false);
        world(github);
        installApp(github, [
          {
            id: 8,
            account: "invented-owner",
            repos: ["invented-owner/kin-memory"],
            permissions: PERMISSIONS,
          },
        ]);
        yield* watching(known(REPOS));
        yield* app.refresh();
        assert.deepStrictEqual(yield* rows(app), {
          accounts: [
            {
              account: "invented-owner",
              organisation: false,
              watched: 3,
              covered: 0,
              installation: "selected",
              settingsUrl: "https://github.com/settings/installations/8",
              installUrl: null,
              canManage: true,
              installable: true,
            },
            {
              account: "invented-co",
              organisation: true,
              watched: 2,
              covered: 0,
              installation: "none",
              settingsUrl: null,
              installUrl:
                "https://github.com/apps/invented-kin/installations/new/permissions?target_id=7001",
              canManage: true,
              installable: true,
            },
          ],
          appOwner: "invented-owner",
          appSettingsUrl: "https://github.com/settings/apps/invented-kin",
        });

        // The owner picks All repositories on GitHub for both; the next look a minute on sees it.
        github.world.app!.installations[0]!.selection = "all";
        github.world.app!.installations.push({
          id: 9,
          account: "invented-co",
          selection: "all",
          repos: [],
          permissions: PERMISSIONS,
        });
        yield* advance(github, MINUTE);
        yield* app.refresh();
        const after = (yield* rows(app)).accounts ?? [];
        assert.deepStrictEqual(
          after.map((row) => [row.account, row.installation, row.covered, row.settingsUrl]),
          [
            ["invented-owner", "all", 3, "https://github.com/settings/installations/8"],
            [
              "invented-co",
              "all",
              2,
              "https://github.com/organizations/invented-co/settings/installations/9",
            ],
          ],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "some repos picked, a suspended installation, an organisation the login doesn't own, and an App private to its owner",
    () =>
      Effect.gen(function* () {
        const { github, app } = yield* setup({ appId: "9001" }, false);
        world(github);
        github.world.accounts!.push({
          login: "invented-lab",
          id: 7002,
          type: "Organization",
          role: "member",
        });
        github.addRepo({ full_name: "invented-lab/tool" });
        installApp(github, [
          {
            id: 8,
            account: "invented-owner",
            repos: ["invented-owner/a", "invented-owner/b"],
            permissions: PERMISSIONS,
          },
          {
            id: 9,
            account: "invented-co",
            suspended: true,
            repos: ["invented-co/app"],
            permissions: PERMISSIONS,
          },
        ]);
        github.world.app!.public = false;
        yield* watching(
          known([
            ...REPOS,
            { repo: "invented-lab/tool", ownerId: 7002, ownerOrg: true, ownerAdmin: false },
            // Watched off: an account with nothing watched gets no row.
            { repo: "invented-quiet/x", ownerId: 7003, ownerOrg: true, ownerAdmin: true },
          ]),
        );
        yield* setRepo({ orgId, repo: "invented-quiet/x", watched: false }, T0);
        yield* app.refresh();
        const { accounts } = yield* rows(app);
        assert.deepStrictEqual(
          accounts?.map((row) => [
            row.account,
            row.installation,
            `${row.covered}/${row.watched}`,
            row.canManage,
            row.installable,
          ]),
          [
            ["invented-owner", "selected", "2/3", true, true],
            ["invented-co", "suspended", "0/2", true, true],
            ["invented-lab", "none", "0/1", false, false],
          ],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "rows from the watched repos' owners alone, before Kin has kept what each account is, whatever the login's case",
    () =>
      Effect.gen(function* () {
        const { github, app } = yield* setup({ appId: "9001" }, false);
        world(github);
        // The live shape: selected on the user's account, covering only the unwatched memory repo.
        installApp(github, [
          {
            id: 8,
            account: "invented-owner",
            repos: ["invented-owner/kin-memory"],
            permissions: PERMISSIONS,
          },
        ]);
        const sql = yield* SqlClient.SqlClient;
        // Stored before Kin kept account facts, with GitHub's own mixed-case names.
        const old = REPOS.map(({ repo }) => ({
          repo: repo.replace("invented-owner/", "Invented-Owner/"),
        }));
        yield* sql`INSERT INTO kin_github_watch (org_id, login, started_at, since_at, next_at, repos_json)
          VALUES (${orgId}, 'Invented-Owner', 0, 0, 0, ${known(old)})`;
        yield* app.refresh();
        const view = yield* agentsView(Option.some(app), orgId);
        assert.deepStrictEqual(
          view.accounts?.map((row) => [
            row.account,
            row.organisation,
            row.installation,
            `${row.covered}/${row.watched}`,
            row.settingsUrl,
            row.installUrl,
            row.canManage,
          ]),
          [
            [
              "Invented-Owner",
              false,
              "selected",
              "0/3",
              "https://github.com/settings/installations/8",
              null,
              true,
            ],
            [
              "invented-co",
              true,
              "none",
              "0/2",
              null,
              "https://github.com/apps/invented-kin/installations/new",
              null,
            ],
          ],
        );
      }).pipe(Effect.provide(layer)),
  );
});

describe("picking the App's repos from Settings, with the owner's login", () => {
  const PERMISSIONS = { contents: "write", metadata: "read" };
  const REPOS = ["invented-owner/a", "invented-owner/b", "invented-owner/c"];
  const fakeApi = (github: FakeGitHub) =>
    Layer.mergeAll(
      Layer.succeed(KinGitHubApi, {
        connected: () => Effect.succeed({ login: "invented-owner", orgs: [] }),
        call: (request) =>
          Effect.sync(() => {
            const answer = github.handle(
              request.method ?? "GET",
              request.path,
              request.headers,
              (request.body ?? {}) as Record<string, unknown>,
            );
            return { ...answer, text: answer.body === null ? "" : JSON.stringify(answer.body) };
          }),
      }),
      Layer.succeed(KinRefreshObserver, { touch: () => Effect.void }),
    );
  const owner = { _tag: "person" as const, orgId, personId: KinPersonId.make("owner") };
  const start = (selection: "all" | "selected", picked: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const { github, app } = yield* setup({ appId: "9001" }, false);
      github.world.accounts = [{ login: "invented-owner", id: 7000, type: "User" }];
      for (const repo of [...REPOS, "invented-owner/kin-memory"])
        github.addRepo({ full_name: repo });
      installApp(github, [
        {
          id: 8,
          account: "invented-owner",
          selection,
          repos: [...picked],
          permissions: PERMISSIONS,
        },
      ]);
      const sql = yield* SqlClient.SqlClient;
      const known = JSON.stringify(
        REPOS.map((repo, index) => ({
          repo,
          fork: false,
          id: 2000 + index,
          ownerId: 7000,
          ownerOrg: false,
        })),
      );
      yield* sql`INSERT INTO kin_github_watch (org_id, login, started_at, since_at, next_at, repos_json)
        VALUES (${orgId}, 'invented-owner', 0, 0, 0, ${known})`;
      yield* app.refresh();
      const set = (repos: ReadonlyArray<string>, on: boolean) =>
        setAppRepos(app, owner, { orgId, account: "invented-owner", repos, on }).pipe(
          Effect.provide(fakeApi(github)),
        );
      const covered = agentsView(Option.some(app), orgId).pipe(
        Effect.map((view) => view.accounts?.[0]?.covered),
      );
      return { github, app, set, covered };
    });

  it.effect("adds every watched repo and takes them off again, as GitHub then holds it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { github, app, set, covered } = yield* start("selected", ["invented-owner/kin-memory"]);
      assert.deepStrictEqual(yield* set(REPOS, true), { changed: 3, problem: null });
      assert.strictEqual(yield* covered, 3);
      assert.sameMembers(github.world.app!.installations[0]!.repos, [
        "invented-owner/kin-memory",
        ...REPOS,
      ]);
      assert.strictEqual((yield* app.on("invented-owner/b"))?.login, BOT_LOGIN);
      // Asking again changes nothing and calls GitHub for nothing.
      const calls = github.world.calls.length;
      assert.deepStrictEqual(yield* set(REPOS, true), { changed: 0, problem: null });
      assert.strictEqual(github.world.calls.length, calls);

      assert.deepStrictEqual(yield* set(["invented-owner/b"], false), {
        changed: 1,
        problem: null,
      });
      assert.strictEqual(yield* covered, 2);
      // Kin's own writes on that repo go out as the owner from now on; the rest stay the App's.
      assert.isUndefined(yield* app.on("invented-owner/b"));
      assert.strictEqual((yield* app.on("invented-owner/a"))?.login, BOT_LOGIN);
      const recorded = yield* sql<{ agent: string; repo: string; command: string }>`
        SELECT agent_name AS agent, repo, command FROM kin_github_owner_uses ORDER BY at, use_id`;
      assert.strictEqual(recorded.length, 4);
      assert.deepStrictEqual(
        recorded.find((entry) => entry.command.startsWith("Took")),
        {
          agent: "Owner",
          repo: "invented-owner/b",
          command: "Took Invented Kin off this repo in Settings",
        },
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("says why GitHub refused, and the rows keep what GitHub holds", () =>
    Effect.gen(function* () {
      const { github, set, covered } = yield* start("selected", ["invented-owner/a"]);
      const last = yield* set(["invented-owner/a"], false);
      assert.strictEqual(last.changed, 0);
      assert.match(last.problem ?? "", /keeps at least one repo/);
      assert.strictEqual(yield* covered, 1);

      github.world.installationEditsRefused = true;
      const refused = yield* set(["invented-owner/b", "invented-owner/c"], true);
      assert.strictEqual(refused.changed, 0);
      assert.match(refused.problem ?? "", /Change it on the App's page on GitHub instead\.$/);
      assert.strictEqual(yield* covered, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses an account on all repositories: that choice is made on GitHub", () =>
    Effect.gen(function* () {
      const { set } = yield* start("all", []);
      const failure = yield* Effect.flip(set(["invented-owner/a"], false));
      assert.strictEqual(failure.reason, "not_allowed");
      assert.match(failure.message, /Only select repositories on its page on GitHub/);
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

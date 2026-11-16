// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { KinOrgId, KinPersonId, type KinChatError } from "@t3tools/contracts";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as GitHubClient from "@t3tools/source-control-github/shared/definition";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { KinGhTool } from "./ghTool.ts";
import { deviceCodeOf, make, signInFailure } from "./GitHubLogin.ts";

// Invented org, people, login and tokens only; the fake gh below never reaches GitHub.
const orgId = KinOrgId.make("org");
const at = "2026-11-16T00:00:00.000Z";
const person = (id: string) => [{ _tag: "person" as const, orgId, personId: KinPersonId.make(id) }];
const owner = person("owner");
const coOwner = person("co");
const member = person("mate");
const stranger = [
  { _tag: "person" as const, orgId: KinOrgId.make("elsewhere"), personId: KinPersonId.make("x") },
];
const GOOD = "ghp_goodINVENTEDtoken000000000000000000";
const DEVICE_TOKEN = "gho_INVENTEDdeviceToken0000000000000000";
const FAKE_GH = `${import.meta.dirname}/fakeGh.sh`;

const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "kin-github-" });
  const state = `${root}/state`;
  const home = `${root}/home`;
  yield* fs.makeDirectory(state);
  yield* fs.makeDirectory(home);
  yield* fs.copyFile(FAKE_GH, `${root}/gh`);
  yield* fs.chmod(`${root}/gh`, 0o755);
  const touches = yield* Queue.unbounded<string>();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at}), ('elsewhere', 'Other', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES ('owner', ${orgId}, 'owner', 'Owner', ${at}, 'owner'),
      ('co', ${orgId}, 'co', 'Co', ${at}, 'co_owner'),
      ('mate', ${orgId}, 'mate', 'Mate', ${at}, 'member')`;
  const login = yield* make({ KIN_FAKE_GH: state, HOME: home, XDG_CONFIG_HOME: home }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(KinGhTool, { ensure: () => Effect.succeed(`${root}/gh`) }),
        Layer.mock(KinIdentity)({
          owner: owner[0]!,
          isAgentThread: () => false,
          isLeadThread: () => false,
        }),
        Layer.succeed(KinRefreshObserver, {
          touch: (_org, topic) => Queue.offer(touches, topic).pipe(Effect.asVoid),
        }),
      ),
    ),
  );
  const file = (name: string) =>
    fs.readFileString(`${state}/${name}`).pipe(Effect.orElseSucceed(() => ""));
  return {
    login,
    touches,
    decide: (answer: "ok" | "expired" | "denied") =>
      fs.writeFileString(`${state}/decision`, answer),
    revoke: fs.writeFileString(`${state}/revoked`, ""),
    calls: file("calls"),
    gitconfig: fs.readFileString(`${home}/.gitconfig`).pipe(Effect.orElseSucceed(() => "")),
    savedToken: Effect.gen(function* () {
      const settings = yield* (yield* ServerSettingsService).getSettings;
      return readSourceControlHostSettings(
        GitHubClient.settings,
        settings.sourceControlHosts[GitHubClient.definition.kind],
      ).tokens["github.com"];
    }),
  };
});

const layer = Layer.mergeAll(KinPersistence.layer, ServerSettingsService.layerTest()).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-github-login-" })),
  Layer.provideMerge(NodeServices.layer),
);

const refusal = <A>(effect: Effect.Effect<A, KinChatError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => ({ reason: error.reason, message: error.message })),
  );

describe("KinGitHubLogin", () => {
  it.effect("connects with a code: git and T3 use the login, and nothing echoes the token", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const empty = yield* h.login.status(owner, { orgId });
      assert.deepEqual(empty, { orgId, account: null, signIn: null, failed: null });

      const started = yield* h.login.start(owner, { orgId });
      assert.equal(started.signIn?.code, "WXYZ-2345");
      assert.equal(started.signIn?.url, "https://github.com/login/device");
      assert.isNull(started.account);
      // A second tap while the code waits gives the same code, not a second sign-in.
      const again = yield* h.login.start(coOwner, { orgId });
      assert.deepEqual(again.signIn, started.signIn);
      assert.equal((yield* h.calls).split("--web").length, 2);

      yield* Queue.clear(h.touches);
      yield* h.decide("ok");
      assert.equal(yield* Queue.take(h.touches), "connections");

      const done = yield* h.login.status(owner, { orgId });
      assert.deepEqual(done.account, {
        login: "invented-owner",
        orgs: ["invented-co", "side-project"],
        scopes: ["gist", "read:org", "repo", "workflow"],
        problem: null,
      });
      assert.isNull(done.signIn);
      assert.isNull(done.failed);
      assert.match(yield* h.gitconfig, /helper = !.*\/gh auth git-credential/);
      assert.equal(yield* h.savedToken, DEVICE_TOKEN);
      assert.notInclude(JSON.stringify([started, again, done]), DEVICE_TOKEN);
      assert.include(
        yield* h.calls,
        "auth login --hostname github.com --git-protocol https --web --scopes workflow",
      );

      // Connected: Connect again is refused until he disconnects.
      assert.deepEqual(yield* refusal(h.login.start(owner, { orgId })), {
        reason: "invalid_state",
        message:
          "GitHub is already connected as invented-owner. Disconnect it first to use another account.",
      });

      const gone = yield* h.login.disconnect(owner, { orgId });
      assert.isNull(gone.account);
      assert.notMatch(yield* h.gitconfig, /git-credential|helper =/);
      assert.isUndefined(yield* h.savedToken);
      assert.include(yield* h.calls, "auth logout --hostname github.com");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an expired or declined code says why, and the next Connect starts afresh", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.login.start(owner, { orgId });
      yield* Queue.clear(h.touches);
      yield* h.decide("expired");
      yield* Queue.take(h.touches);
      const expired = yield* h.login.status(owner, { orgId });
      assert.isNull(expired.signIn);
      assert.isNull(expired.account);
      assert.equal(
        expired.failed,
        "The code expired before GitHub was authorized. Connect again for a new code.",
      );
      assert.equal(
        signInFailure("error: access_denied: the user has denied your application access"),
        "The sign-in was declined on GitHub. Connect again if that wasn't meant.",
      );
      const fresh = yield* h.login.start(owner, { orgId });
      assert.isNull(fresh.failed);
      assert.equal(fresh.signIn?.code, "WXYZ-2345");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("Cancel stops the waiting sign-in and leaves nothing behind", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.login.start(owner, { orgId });
      const cancelled = yield* h.login.cancel(owner, { orgId });
      assert.deepEqual(cancelled, { orgId, account: null, signIn: null, failed: null });
      // The stopped gh can't finish later: a decision now changes nothing.
      yield* h.decide("ok");
      assert.isNull((yield* h.login.status(owner, { orgId })).account);
      assert.isUndefined(yield* h.savedToken);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a pasted token connects the same way, and a bad one is refused plainly", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const token = (value: string) => ({ orgId, token: Redacted.make(value) });
      assert.deepEqual(yield* refusal(h.login.start(owner, token("ghp_wrong"))), {
        reason: "invalid_state",
        message: "GitHub didn't accept that token. Check it was copied whole and hasn't expired.",
      });
      assert.deepEqual(yield* refusal(h.login.start(owner, token("ghp_noscope_x"))), {
        reason: "invalid_state",
        message:
          "That token is missing the read:org scope. Make one with repo, read:org and workflow.",
      });
      const connected = yield* h.login.start(owner, token(GOOD));
      assert.equal(connected.account?.login, "invented-owner");
      assert.isNull(connected.failed);
      assert.equal(yield* h.savedToken, GOOD);
      assert.notInclude(JSON.stringify(connected), GOOD);
      assert.notInclude(yield* h.calls, GOOD);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a login GitHub stops accepting shows as needing Reconnect, which is then allowed",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.login.start(owner, { orgId, token: Redacted.make(GOOD) });
        yield* h.revoke;
        // Read again once the cached answer is old.
        yield* TestClock.adjust("2 minutes");
        const lost = yield* h.login.status(owner, { orgId });
        assert.equal(lost.account?.login, "invented-owner");
        assert.match(lost.account?.problem ?? "", /no longer accepts this login/);
        const reconnect = yield* h.login.start(owner, { orgId });
        assert.equal(reconnect.signIn?.code, "WXYZ-2345");
        yield* h.login.cancel(owner, { orgId });
      }).pipe(Effect.provide(layer)),
  );

  it.effect("only the owner and co-owners reach it", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      assert.deepEqual(yield* refusal(h.login.status(member, { orgId })), {
        reason: "not_allowed",
        message: "Only the owner or a co-owner manages connections.",
      });
      assert.equal((yield* refusal(h.login.start(member, { orgId }))).reason, "not_allowed");
      assert.equal((yield* refusal(h.login.disconnect(member, { orgId }))).reason, "not_allowed");
      assert.equal((yield* refusal(h.login.status(stranger, { orgId }))).reason, "not_found");
      assert.isNull((yield* h.login.status(coOwner, { orgId })).account);
      assert.equal(yield* h.calls, "auth token --hostname github.com\n");
    }).pipe(Effect.provide(layer)),
  );

  it("reads the code in either way gh words it", () => {
    assert.deepEqual(deviceCodeOf("! First copy your one-time code: AB12-CD34\n"), {
      code: "AB12-CD34",
      url: "https://github.com/login/device",
    });
    assert.deepEqual(
      deviceCodeOf(
        "! One-time code (AB12-CD34) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n",
      ),
      { code: "AB12-CD34", url: "https://github.com/login/device" },
    );
    assert.isNull(deviceCodeOf("Press Enter to open github.com in your browser..."));
  });
});

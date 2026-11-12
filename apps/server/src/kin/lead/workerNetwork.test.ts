import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KinOrgId, KinPersonId, KinWorkerNetworkChange } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Network from "./workerNetwork.ts";
import * as WorkNetwork from "./workNetwork.ts";

const orgId = KinOrgId.make("org");
const owner = { _tag: "person" as const, orgId, personId: KinPersonId.make("owner") };
const mate = { _tag: "person" as const, orgId, personId: KinPersonId.make("mate") };
const elsewhere = { ...owner, orgId: KinOrgId.make("elsewhere") };

const layer = Layer.mergeAll(
  Layer.mock(KinIdentity)({ owner }),
  ServerConfig.layerTest(process.cwd(), { prefix: "kin-network-" }),
).pipe(
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(NodeServices.layer),
);
// The host's own extra; a session's environment never reaches the list.
const withHostExtra = Effect.provideService(HostProcess.Environment, {
  KIN_WORKER_ALLOWED_DOMAINS: "mirror.example.com",
});
const hosts = (view: { readonly allowed: ReadonlyArray<{ readonly host: string }> }) =>
  view.allowed.map((entry) => entry.host);

it.effect(
  "the owner's list starts from Kin's defaults and the host's extra, and only grows by asking",
  () =>
    Effect.gen(function* () {
      const first = yield* Network.get([owner], { orgId });
      assert.deepStrictEqual(hosts(first), [...Network.DEFAULT_WORKER_HOSTS, "mirror.example.com"]);
      assert.deepStrictEqual(first.removed, []);
      assert.strictEqual(first.sandbox.state, "unchecked");
      assert.include(first.allowed.at(-1), { source: "host" });

      const added = yield* Network.allow([owner], { orgId, host: "*.example.org" });
      assert.deepInclude(added.allowed, { host: "*.example.org", source: "owner" });

      // A default and the host's extra are hidden by a removal and come back when allowed again.
      yield* Network.remove([owner], { orgId, host: "github.com" });
      const removed = yield* Network.remove([owner], { orgId, host: "mirror.example.com" });
      assert.notInclude(hosts(removed), "github.com");
      assert.notInclude(hosts(removed), "mirror.example.com");
      assert.sameMembers([...removed.removed], ["github.com", "mirror.example.com"]);
      const restored = yield* Network.allow([owner], { orgId, host: "github.com" });
      assert.deepInclude(restored.allowed, { host: "github.com", source: "default" });
      assert.deepStrictEqual(restored.removed, ["mirror.example.com"]);

      // The owner's own addition just goes; nothing is left to undo.
      const gone = yield* Network.remove([owner], { orgId, host: "*.example.org" });
      assert.notInclude(hosts(gone), "*.example.org");
      assert.notInclude(gone.removed, "*.example.org");
      // Another org's list is its own.
      assert.deepStrictEqual(hosts(yield* Network.workerHosts(KinOrgId.make("elsewhere"))), [
        ...Network.DEFAULT_WORKER_HOSTS,
        "mirror.example.com",
      ]);
    }).pipe(withHostExtra, Effect.provide(layer)),
);

it.effect("a teammate, or the owner acting in another org, reads and changes nothing", () =>
  Effect.gen(function* () {
    for (const people of [[mate], [elsewhere], []]) {
      const target = people[0]?.orgId ?? orgId;
      for (const exit of [
        yield* Effect.exit(Network.get(people, { orgId: target })),
        yield* Effect.exit(Network.allow(people, { orgId: target, host: "evil.example.com" })),
        yield* Effect.exit(Network.remove(people, { orgId: target, host: "github.com" })),
      ])
        assert.isTrue(Exit.isFailure(exit), JSON.stringify(people));
    }
    const view = yield* Network.workerHosts(orgId);
    assert.notInclude(hosts(view), "evil.example.com");
    assert.include(hosts(view), "github.com");
  }).pipe(Effect.provide(layer)),
);

it("a host the owner adds is a host name, never an address, port, scheme or the whole web", () => {
  const decode = Schema.decodeUnknownExit(KinWorkerNetworkChange);
  for (const host of ["registry.npmjs.org", "*.example.com", "a-b.co"])
    assert.isTrue(Exit.isSuccess(decode({ orgId, host })), host);
  for (const host of [
    "localhost",
    "127.0.0.1",
    "*",
    "*.com",
    "example.com:443",
    "https://example.com",
    "Example.com",
    "example.com/path",
    "",
  ])
    assert.isTrue(Exit.isFailure(decode({ orgId, host })), host);
});

it.effect("a worker's grant and refusals live in server files keyed by its own id", () =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    yield* WorkNetwork.grantHosts(stateDir, "wk-1", ["registry.npmjs.org"]);
    assert.deepStrictEqual(yield* WorkNetwork.grantedHosts(stateDir, "wk-1"), [
      "registry.npmjs.org",
    ]);
    // No file, or an id that could name another path, grants nothing.
    assert.deepStrictEqual(yield* WorkNetwork.grantedHosts(stateDir, "wk-2"), []);
    assert.deepStrictEqual(yield* WorkNetwork.grantedHosts(stateDir, "../wk-1"), []);

    const result = (text: string) =>
      ({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: text }],
        },
        parent_tool_use_id: null,
        session_id: "s",
      }) as const;
    const refused = WorkNetwork.refusedHosts(
      result(
        "curl: (56) CONNECT tunnel failed\n<sandbox_violations>deny network-outbound Example.com:443 (host is not on the allow list)\ndeny network-outbound 10.0.0.1:80\ndeny network-outbound example.com:80</sandbox_violations>",
      ),
    );
    // The address isn't a host the owner could allow, so it isn't asked about.
    assert.deepStrictEqual(refused, ["example.com"]);
    assert.deepStrictEqual(WorkNetwork.refusedHosts(result("all fine")), []);
    yield* WorkNetwork.noteBlocked(stateDir, "wk-1", refused);
    yield* WorkNetwork.noteBlocked(stateDir, "wk-1", ["example.com", "pkg.example.org"]);
    assert.deepStrictEqual(yield* WorkNetwork.takeBlocked(stateDir, "wk-1"), [
      "example.com",
      "pkg.example.org",
    ]);
    // Each report names only what was refused since the last one.
    assert.deepStrictEqual(yield* WorkNetwork.takeBlocked(stateDir, "wk-1"), []);
  }).pipe(Effect.provide(layer)),
);

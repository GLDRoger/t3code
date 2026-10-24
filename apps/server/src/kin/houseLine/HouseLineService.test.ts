import { assert, it } from "@effect/vitest";
import {
  CommandId,
  KIN_WILL_CHAR_LIMIT,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  lineageToolsForProfile,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HouseLineWillGate from "./HouseLineWillGate.ts";
import * as HouseLine from "./HouseLineService.ts";

const codexInstance = ProviderInstanceId.make("codex");
const claudeInstance = ProviderInstanceId.make("claude");
const modelSelection = { instanceId: codexInstance, model: "gpt-5.1-codex" };

const stub = (instanceId: ProviderInstanceId, driver: "codex" | "claudeAgent") =>
  ({
    instanceId,
    driver: ProviderDriverKind.make(driver),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("No provider process needed for house lines"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerHarness = ProviderReplayHarness.layerWithRegistry(
  { name: "kin-house-line" },
  ProviderAdapterRegistry.layerFromAdapters([
    stub(codexInstance, "codex"),
    stub(claudeInstance, "claudeAgent"),
  ]),
  { databaseLayer: layerDatabase, runEffectWorker: false },
);
const layerBase = Layer.mergeAll(layerHarness, layerDatabase, NodeServices.layer);
const layerHouse = HouseLine.layer.pipe(Layer.provide(layerBase));
const layerGate = HouseLineWillGate.layer.pipe(Layer.provide(layerHouse), Layer.provide(layerBase));
const layerTest = Layer.mergeAll(layerBase, layerHouse, layerGate);

const projectId = ProjectId.make("project-kin");
const housesTsv = [
  "pattern\thouse\tagent_map",
  "^web-\tweb-ui\t.kin/web.md",
  "apps/web/\tweb-ui",
  "^server-\tserver\t.kin/server.md",
  "apps/server/\tserver",
].join("\n");

it.effect("crowns a Codex lane and a Claude lane, then leaves wills", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const houseLine = yield* HouseLine.HouseLineService;
    const gate = yield* HouseLineWillGate.HouseLineWillGate;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(workspace, ".kin"));
    yield* fs.writeFileString(path.join(workspace, ".kin", "houses.tsv"), housesTsv);
    yield* houseLine.reloadHouses({ projectId, workspaceRoot: workspace });

    const open = (
      name: string,
      provider: string,
      extra?: {
        readonly role?: "reviewer";
        readonly lineId?: string;
        readonly touchedPaths?: ReadonlyArray<string>;
      },
    ) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`thread-${name}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${name}`),
          threadId,
          projectId,
          title: name,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const lane = yield* houseLine.openLane({
          projectId,
          threadId,
          label: name,
          provider,
          model: provider === "claudeAgent" ? "claude" : "codex",
          lineId: extra?.lineId ?? "kin-line:web-ui",
          ...(extra?.role === undefined ? {} : { role: extra.role }),
          ...(extra?.touchedPaths === undefined ? {} : { touchedPaths: extra.touchedPaths }),
        });
        return { threadId, ...lane };
      });

    const codex = yield* open("web-codex", "codex");
    const claude = yield* open("web-claude", "claudeAgent");
    const server = yield* open("server-lane", "codex", { lineId: "kin-line:server" });
    const heir = yield* open("web-heir", "codex", {
      touchedPaths: ["apps/server/src/kin/houseLine/HouseLineService.ts"],
    });
    const reviewer = yield* open("web-reviewer", "codex", { role: "reviewer" });
    const bare = yield* open("web-bare", "codex", { lineId: "kin-line:bare" });

    const crowns = yield* Effect.all(
      [houseLine.crown(codex.threadId), houseLine.crown(claude.threadId)],
      {
        concurrency: "unbounded",
      },
    );
    const numbers = crowns.map((crown) => crown.regnalNumber).sort((left, right) => left - right);
    assert.deepEqual(numbers, [1, 2]);
    assert.deepEqual(
      crowns.map((crown) => crown.houseName),
      ["web-ui", "web-ui"],
    );

    for (const crown of crowns) {
      const threadId = crown.crowningId.includes(codex.laneId) ? codex.threadId : claude.threadId;
      yield* houseLine.will({ threadId, body: `reign ${crown.regnalNumber}` });
    }
    yield* houseLine.crown(server.threadId);
    yield* houseLine.will({ threadId: server.threadId, body: "server will" });

    const crowned = yield* houseLine.snapshot(projectId);
    const webReigns = crowned.houses.find((house) => house.name === "web-ui")?.reigns ?? [];
    assert.deepEqual(webReigns.map((reign) => reign.provider).sort(), ["claudeAgent", "codex"]);

    const brief = yield* houseLine.briefFor(heir.laneId);
    const again = yield* houseLine.briefFor(heir.laneId);
    const family = brief.indexOf("Your family");
    const court = brief.indexOf("The court");
    const houseWills = brief.indexOf("House wills and notes");
    assert.equal(brief, again);
    assert.ok(brief.startsWith("Start here\n"));
    assert.ok(family < court && court < houseWills);
    assert.ok(brief.indexOf("reign 2") < brief.indexOf("reign 1"));
    assert.ok(brief.includes("server will"));
    assert.ok(brief.includes("Agent map: .kin/web.md"));

    const refused = yield* houseLine.crown(reviewer.threadId).pipe(Effect.flip);
    assert.equal(refused.detail, "Reviewers are not crowned.");
    assert.equal(yield* houseLine.seesWills(reviewer.threadId), false);
    const blind = yield* houseLine.lineages(reviewer.threadId);
    assert.ok(
      blind.houses.every((house) => house.reigns.every((reign) => reign.willBody === null)),
    );
    const sighted = yield* houseLine.lineages(heir.threadId);
    assert.ok(
      sighted.houses.some((house) => house.reigns.some((reign) => reign.willBody !== null)),
    );
    const reviewerTools = lineageToolsForProfile({ role: "reviewer" });
    assert.equal(
      reviewerTools.some((tool) => tool.willRead),
      false,
    );

    const runId = RunId.make("run-bare");
    yield* gate.afterRun({ threadId: bare.threadId, runId });
    const waiting = yield* houseLine.finishLane(bare.threadId);
    assert.equal(waiting.state, "will_missing");
    const firstPass = yield* houseLine.snapshot(projectId);
    const bareLane = firstPass.lanes.find((lane) => lane.threadId === bare.threadId);
    assert.equal(bareLane?.state, "will_missing");

    const note = yield* houseLine.addNote({ threadId: heir.threadId, body: "read me" });
    yield* houseLine.read({ threadId: heir.threadId, subject: "notes" });
    const mismatch = yield* houseLine.recordReport({
      threadId: heir.threadId,
      body: "First reads: note:missing\nMisleading notes: none\n",
    });
    assert.equal(mismatch.mismatch, true);
    const flagged = yield* houseLine.snapshot(projectId);
    assert.equal(
      flagged.lanes.find((lane) => lane.threadId === heir.threadId)?.reportMismatch,
      true,
    );
    const matched = yield* houseLine.recordReport({
      threadId: heir.threadId,
      body: `First reads: note:${note.noteId}\nMisleading notes: none\n`,
    });
    assert.equal(matched.mismatch, false);

    const tooLong = yield* houseLine
      .will({ threadId: heir.threadId, body: "x".repeat(KIN_WILL_CHAR_LIMIT + 1) })
      .pipe(Effect.flip);
    assert.ok(tooLong.detail.includes(String(KIN_WILL_CHAR_LIMIT)));

    const imported = ["lane\tlineage", "^legacy-\tlegacy"].join("\n");
    yield* fs.writeFileString(path.join(workspace, ".kin", "lineages.tsv"), imported);
    yield* fs.remove(path.join(workspace, ".kin", "houses.tsv"));
    yield* houseLine.reloadHouses({
      projectId: ProjectId.make("project-legacy"),
      workspaceRoot: workspace,
    });
    const legacyThread = ThreadId.make("thread-legacy");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-legacy"),
      threadId: legacyThread,
      projectId: ProjectId.make("project-legacy"),
      title: "legacy",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const legacy = yield* houseLine.openLane({
      projectId: ProjectId.make("project-legacy"),
      threadId: legacyThread,
      label: "legacy-lane",
      provider: "codex",
    });
    assert.equal(legacy.houseName, "legacy");
  }).pipe(Effect.provide(layerTest)),
);

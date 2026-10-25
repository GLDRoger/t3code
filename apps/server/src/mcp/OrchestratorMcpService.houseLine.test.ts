import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestratorMcpDelegateTaskResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type KinInlineProfile,
  type ServerProvider,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as Kin from "../kin/KinService.ts";
import * as HouseLine from "../kin/houseLine/HouseLineService.ts";
import * as KinPromptBrief from "../kin/prompt/KinPromptBrief.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as LineageHandlers from "./toolkits/lineage/handlers.ts";
import { LineageToolkit } from "./toolkits/lineage/tools.ts";

const projectId = ProjectId.make("project:delegated-house");
const parentThreadId = ThreadId.make("thread:delegated-house-parent");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-25T00:00:00.000Z",
  models: [
    { slug: modelSelection.model, name: modelSelection.model, isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};
const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
  {
    instanceId,
    driver: provider.driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("No provider process is needed for lineage tool integration"),
  },
]);
const layerDatabase = SqlitePersistence.layerMemory;
const layerHarness = ProviderReplayHarness.layerWithRegistry(
  { name: "delegated-house-line" },
  layerRegistry,
  { databaseLayer: layerDatabase, runEffectWorker: false },
);
const layerThreads = ThreadManagementService.layer.pipe(
  Layer.provide(layerHarness),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);
const layerHouse = HouseLine.layer.pipe(Layer.provide(layerHarness), Layer.provide(layerDatabase));

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "lineage-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "lineage-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scopeFor = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:delegated-house"),
  requestNamespace: `lineage-test:${threadId}`,
  thread: { threadId, providerSessionId: `session:${threadId}`, providerInstanceId: instanceId },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const decodeDelegation = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);

it.effect.each([
  { name: "catalog", withCatalog: true, houseName: "sql" },
  { name: "runtime", withCatalog: false, houseName: "web-ui" },
])(
  "delegates $name house lanes with first-prompt wills, notes, and reviewer isolation",
  ({ withCatalog, houseName }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const workspace = yield* fs.makeTempDirectoryScoped();
      const failBrief = yield* Ref.make(false);
      const layerBrief = Layer.effect(
        KinPromptBrief.KinPromptBriefProvider,
        Effect.gen(function* () {
          const houseLine = yield* HouseLine.HouseLineService;
          return KinPromptBrief.KinPromptBriefProvider.of({
            briefFor: (laneId) =>
              Ref.get(failBrief).pipe(
                Effect.flatMap((fail) =>
                  fail
                    ? Effect.fail(new HouseLine.HouseLineError({ detail: "Test brief failure." }))
                    : houseLine.briefFor(laneId),
                ),
              ),
          });
        }),
      ).pipe(Layer.provide(layerHouse));
      if (withCatalog) {
        yield* fs.makeDirectory(path.join(workspace, ".kin"));
        yield* fs.writeFileString(
          path.join(workspace, ".kin", "houses.tsv"),
          "^sql\\b|kindb/crates/sql/\tsql\n",
        );
      }
      const layerTest = Layer.mergeAll(
        McpHttpServer.layerOrchestratorToolkit,
        McpHttpServer.toolkitRegistration(LineageToolkit, LineageHandlers.layer),
      ).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(layerThreads),
        Layer.provideMerge(layerHarness),
        Layer.provideMerge(layerHouse),
        Layer.provideMerge(layerBrief),
        Layer.provideMerge(Kin.layerLive),
        Layer.provide(layerRegistry),
        Layer.provide(ProviderRegistryMock.layer([provider])),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(
                Option.some({
                  id: projectId,
                  title: "Kin lineage",
                  workspaceRoot: workspace,
                  defaultModelSelection: modelSelection,
                  scripts: [],
                  createdAt: "2026-10-25T00:00:00.000Z",
                  updatedAt: "2026-10-25T00:00:00.000Z",
                  deletedAt: null,
                }),
              ),
          }),
        ),
        Layer.provideMerge(layerDatabase),
        Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const houseLine = yield* HouseLine.HouseLineService;
        const server = yield* McpServer.McpServer;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (${projectId}, 'Kin', ${workspace}, '[]', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z')
      `;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:house-parent"),
          threadId: parentThreadId,
          projectId,
          title: "House parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("message:house-parent"),
          threadId: parentThreadId,
          messageId: MessageId.make("message:house-parent"),
          text: "Delegate SQL work",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        const call = (threadId: ThreadId, name: string, args: Record<string, unknown> = {}) =>
          server
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(threadId)),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
        const initialAreas = yield* call(parentThreadId, "lineage_areas");
        assert.isNotTrue(initialAreas.isError, JSON.stringify(initialAreas.content));
        assert.deepEqual(initialAreas.structuredContent, {
          houses: withCatalog ? yield* houseLine.areas(projectId) : [],
        });
        const delegate = (
          title: string | undefined,
          requestId: string,
          profile?: string | KinInlineProfile,
          house: string | null = withCatalog ? null : houseName,
        ) =>
          call(parentThreadId, "delegate_task", {
            ...(title === undefined ? {} : { title }),
            ...(profile === undefined ? {} : { profile }),
            ...(house === null ? {} : { house }),
            task: "Implement the parser.",
            mode: "async",
            clientRequestId: requestId,
          }).pipe(
            Effect.flatMap((result) => {
              assert.isNotTrue(result.isError, JSON.stringify(result.content));
              return decodeDelegation(result.structuredContent);
            }),
          );
        const implementer = {
          role: "implementer",
          crownable: true,
          seesWills: true,
          prompt: "Build SQL.",
        } as const;
        const first = yield* delegate("sql: parser r1", "sql-r1", implementer);
        assert.deepInclude((yield* houseLine.snapshot(projectId)).lanes[0], {
          threadId: first.childThreadId,
          houseName,
          state: "running",
        });
        if (!withCatalog) {
          assert.equal(
            (yield* houseLine.snapshot(projectId)).houses[0]?.agentMapPath,
            `.kin/houses/${houseName}.md`,
          );
        }
        const createdAreas = yield* call(parentThreadId, "lineage_areas");
        assert.isNotTrue(createdAreas.isError, JSON.stringify(createdAreas.content));
        assert.include(JSON.stringify(createdAreas.structuredContent), houseName);
        const read = yield* call(first.childThreadId, "lineage_read");
        assert.isNotTrue(read.isError, JSON.stringify(read.content));
        const note = yield* call(first.childThreadId, "lineage_add", {
          body: "Parser notes for the heir.",
        });
        assert.isNotTrue(note.isError, JSON.stringify(note.content));
        const crown = yield* call(first.childThreadId, "lineage_crown");
        assert.deepInclude(crown.structuredContent, { houseName, regnalNumber: 1 });
        const will = yield* call(first.childThreadId, "lineage_will", {
          body: "Keep the r1 parser invariant.",
        });
        assert.isNotTrue(will.isError, JSON.stringify(will.content));

        const nested = yield* call(first.childThreadId, "delegate_task", {
          house: "rogue-area",
          task: "Help with the parser.",
          mode: "async",
          clientRequestId: "nested-house",
        });
        assert.isTrue(nested.isError);
        assert.include(JSON.stringify(nested.content), "Only the main agent assigns houses");
        assert.notInclude(
          JSON.stringify((yield* houseLine.snapshot(projectId)).houses),
          "rogue-area",
        );

        const second = yield* delegate("sql: parser r2", "sql-r2", implementer);
        const child = yield* orchestrator.getThreadProjection(second.childThreadId);
        const prompt = child.messages[0]?.text ?? "";
        assert.include(prompt, "Keep the r1 parser invariant.");
        assert.include(prompt, "Parser notes for the heir.");
        assert.include(prompt, "Implement the parser.");
        assert.isBelow(
          prompt.indexOf("House wills and notes"),
          prompt.indexOf("Implement the parser."),
        );
        // The will is asked for in the working turn, after the task, not in a later turn.
        assert.isBelow(
          prompt.indexOf("Implement the parser."),
          prompt.indexOf("Before your final reply, in this same turn: call lineage_crown"),
        );
        const secondCrown = yield* call(second.childThreadId, "lineage_crown");
        assert.deepInclude(secondCrown.structuredContent, { houseName, regnalNumber: 2 });
        const secondAreas = yield* call(second.childThreadId, "lineage_areas");
        assert.include(
          JSON.stringify(secondAreas.structuredContent),
          "Keep the r1 parser invariant.",
        );
        const snapshot = yield* houseLine.snapshot(projectId);
        assert.equal(snapshot.houses[0]?.reigns[1]?.model, modelSelection.model);
        const replay = yield* delegate("sql: parser r2", "sql-r2", implementer);
        assert.equal(replay.childThreadId, second.childThreadId);
        assert.equal((yield* houseLine.snapshot(projectId)).lanes.length, 2);

        const unmatched = yield* delegate("ctl-sql r2", "ctl-sql", implementer, null);
        assert.isFalse(
          (yield* houseLine.snapshot(projectId)).lanes.some(
            (lane) => lane.threadId === unmatched.childThreadId,
          ),
        );
        const reviewer = yield* delegate("sql: reviewer", "sql-review", {
          role: "reviewer",
          crownable: true,
          seesWills: true,
          prompt: "Review independently.",
        });
        const blind = yield* delegate("sql: blind", "sql-blind", {
          ...implementer,
          seesWills: false,
        });
        for (const reader of [reviewer, blind]) {
          const readerPrompt =
            (yield* orchestrator.getThreadProjection(reader.childThreadId)).messages[0]?.text ?? "";
          assert.notInclude(readerPrompt, "Keep the r1 parser invariant.");
          assert.include(readerPrompt, "Parser notes for the heir.");
          const denied = yield* call(reader.childThreadId, "lineage_read", { subject: "wills" });
          assert.isTrue(denied.isError);
          const areas = yield* call(reader.childThreadId, "lineage_areas");
          assert.notInclude(JSON.stringify(areas), "Keep the r1 parser invariant.");
        }
        assert.notInclude(
          (yield* orchestrator.getThreadProjection(reviewer.childThreadId)).messages[0]?.text ?? "",
          "call lineage_crown",
        );
        const noCrown = yield* call(reviewer.childThreadId, "lineage_crown");
        assert.isTrue(noCrown.isError);
        const noWill = yield* call(reviewer.childThreadId, "lineage_will", {
          body: "Reviewer will.",
        });
        assert.isTrue(noWill.isError);
        const noProfile = yield* delegate("sql: default access", "sql-default");
        assert.isTrue(yield* houseLine.crownable(noProfile.childThreadId));
        const named = yield* delegate(undefined, "sql-named", {
          ...implementer,
          name: "sql-worker",
        });
        assert.isTrue(
          (yield* houseLine.snapshot(projectId)).lanes.some(
            (lane) => lane.threadId === named.childThreadId,
          ),
        );
        yield* Ref.set(failBrief, true);
        const failedBrief = yield* call(parentThreadId, "delegate_task", {
          title: "sql: failed brief",
          ...(withCatalog ? {} : { house: houseName }),
          task: "Do not start without the brief.",
          profile: implementer,
          mode: "async",
          clientRequestId: "sql-failed-brief",
        });
        yield* Ref.set(failBrief, false);
        assert.isTrue(failedBrief.isError);
        assert.isFalse(
          (yield* houseLine.snapshot(projectId)).lanes.some(
            (lane) => lane.label === "sql: failed brief",
          ),
        );

        if (withCatalog) {
          yield* fs.writeFileString(
            path.join(workspace, ".kin", "houses.tsv"),
            "^new-sql\\b\tsql\n",
          );
          const refreshed = yield* delegate("new-sql: parser r3", "sql-refreshed", implementer);
          assert.isTrue(yield* houseLine.crownable(refreshed.childThreadId));
          assert.include(
            (yield* orchestrator.getThreadProjection(refreshed.childThreadId)).messages[0]?.text ??
              "",
            "Keep the r1 parser invariant.",
          );
          const retiredPattern = yield* delegate(
            "sql: retired pattern",
            "sql-retired",
            implementer,
          );
          assert.isFalse(yield* houseLine.crownable(retiredPattern.childThreadId));
        }
        if (!withCatalog) {
          const untitled = yield* delegate(undefined, "runtime-untitled");
          assert.deepInclude(
            (yield* houseLine.snapshot(projectId)).lanes.find(
              (lane) => lane.threadId === untitled.childThreadId,
            ),
            { label: houseName, houseName },
          );
          yield* fs.makeDirectory(path.join(workspace, ".kin"), { recursive: true });
          yield* fs.writeFileString(path.join(workspace, ".kin", "houses.tsv"), "^sql\\b\tsql\n");
          const explicit = yield* delegate("sql: explicit area", "runtime-explicit");
          assert.equal(
            (yield* houseLine.snapshot(projectId)).lanes.find(
              (lane) => lane.threadId === explicit.childThreadId,
            )?.houseName,
            houseName,
          );
          const matched = yield* delegate(
            "sql: catalog fallback",
            "runtime-fallback",
            undefined,
            null,
          );
          assert.equal(
            (yield* houseLine.snapshot(projectId)).lanes.find(
              (lane) => lane.threadId === matched.childThreadId,
            )?.houseName,
            "sql",
          );
        }
      }).pipe(Effect.provide(layerTest));
    }).pipe(Effect.provide(NodeServices.layer)),
);

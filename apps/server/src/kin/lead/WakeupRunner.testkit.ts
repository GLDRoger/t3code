import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import type { ThreadId } from "@t3tools/contracts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { EnvironmentId } from "@t3tools/contracts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import {
  KinAgentId,
  KinEvent,
  KinOrgId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  type ProviderApprovalDecision,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinChatRepository from "../chat/KinChatRepository.ts";
import * as KinIdentity from "../chat/KinIdentity.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as Memory from "../memory/Memory.ts";
import * as Budget from "./KinBudget.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as WakeupRunner from "./WakeupRunner.ts";
import * as KinStop from "./KinStop.ts";
import * as KinLeadRegistry from "./KinLeadRegistry.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import * as KinIssuedTokens from "../mcp/KinIssuedTokens.ts";
import { KinLeadPrompt } from "./LeadPrompt.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";

export const orgId = KinOrgId.make("org");
export const agentId = KinAgentId.make("lead");
const timestamp = "2026-11-08T00:00:00.000Z";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeSync(KinEvent);
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };
const project = {
  id: ProjectId.make("kin:org"),
  title: "Kin · Org",
  workspaceRoot: "/private/tmp",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: selection,
  defaultThreadEnvMode: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
};
const defaultDatabase = KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
type Database = NonNullable<
  NonNullable<Parameters<typeof ProviderReplayHarness.layerWithRegistry>[2]>["databaseLayer"]
>;
export const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES ('org', 'Org', ${timestamp})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES ('owner', 'org', 'owner', 'Owner', ${timestamp})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES ('lead', 'org', 'Lead', 'lead', 'owner', ${timestamp})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at) VALUES ('owner-chat', 'org', 'team_group', 0, ${timestamp})`;
  const models = yield* encodeJson({
    strong: selection,
    cheap: { ...selection, model: "gpt-5.1-codex-mini" },
  });
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id) VALUES ('lead', 'org', 'Lead', 0, ${models}, '[]', 'owner-chat')`;
});
export const event = (id: string) =>
  decodeEvent({
    _tag: "routine",
    orgId,
    agentId,
    eventId: id,
    receivedAt: timestamp,
    dedupeKey: id,
    provenance: { _tag: "system" },
    routine: "owner_check",
  });

type HarnessOptions = {
  readonly sharedWith?: ReadonlyArray<ThreadId>;
  readonly releaseEntered?: Deferred.Deferred<void>;
  readonly releaseHold?: Deferred.Deferred<void>;
  readonly releaseDone?: Deferred.Deferred<void>;
  readonly hold?: Deferred.Deferred<void>;
  readonly entered?: Deferred.Deferred<void>;
  readonly failed?: boolean;
  readonly writer?: Layer.Layer<Writer.MemoryWriter, never, SqlClient.SqlClient>;
  readonly piUsage?: boolean;
  readonly prepare?: Memory.Memory["Service"]["prepareWakeup"];
  /** Each turn opens a command approval and ends only once it is answered. */
  readonly approval?: Deferred.Deferred<ProviderApprovalDecision | undefined>;
  readonly runtimeModes?: Array<RuntimeMode>;
  /** The fake provider registers as the default Claude instance instead of Codex. */
  readonly claude?: boolean;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  /** Runtime requests are opened with this capability instead of `live`. */
  readonly requestCapability?: "not_resumable";
  /** Each turn stays open until it is interrupted, then ends `interrupted`. */
  readonly untilInterrupted?: boolean;
  /** Replaces the in-memory database, for example with a file in a state directory. */
  readonly database?: Database;
  /** Runs inside each turn before it completes, as the provider's tool calls would. */
  readonly onTurn?: (input: { readonly threadId: ThreadId }) => Effect.Effect<void>;
};

export function harness(options: HarnessOptions = {}) {
  return WakeupRunner.layer.pipe(Layer.provideMerge(orchestrationHarness(options)));
}

/** The fake-provider orchestration stack without the wake-up runner. */
export function orchestrationHarness(options: HarnessOptions = {}) {
  const { stack, kin, database } = parts(options);
  return Layer.mergeAll(kin, stack).pipe(Layer.provideMerge(database));
}

/** The fake-provider orchestration stack alone, for callers that bring Kin's own services. */
export function orchestrationStack(options: HarnessOptions = {}) {
  const { stack, database } = parts(options);
  return stack.pipe(Layer.provideMerge(database));
}

function parts(options: HarnessOptions) {
  const database: Database = options.database ?? defaultDatabase;
  let nativeOrdinal = 0;
  const driver = ProviderDriverKind.make(options.claude ? "claudeAgent" : "codex");
  const instanceId = options.claude ? ProviderInstanceId.make("claudeAgent") : selection.instanceId;
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (session) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const open = new Map<
          string,
          Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0]
        >();
        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId,
          driver,
          providerSessionId: session.providerSessionId,
          providerSession: {
            id: session.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: "/private/tmp",
            model: selection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromPubSub(events),
          ensureThread: (input) =>
            Effect.sync(() => ({
              id: ProviderThreadId.make(`native-${++nativeOrdinal}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: session.providerSessionId,
              appThreadId: input.threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: `native-${nativeOrdinal}`, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              contextUsage: null,
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            })),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: Effect.fn("test.startTurn")(function* (input) {
            options.runtimeModes?.push(input.runtimePolicy.runtimeMode);
            if (options.entered !== undefined) yield* Deferred.succeed(options.entered, undefined);
            if (options.hold !== undefined) yield* Deferred.await(options.hold);
            if (options.onTurn !== undefined) yield* options.onTurn({ threadId: input.threadId });
            const time = yield* DateTime.now;
            const id = ProviderTurnId.make(`turn-${input.runOrdinal}`);
            if (!options.piUsage)
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id,
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: null,
                  ordinal: input.runOrdinal,
                  status: "running",
                  startedAt: time,
                  completedAt: null,
                  tokenUsage: {
                    usedTokens: 22,
                    inputTokens: 18,
                    cachedInputTokens: 4,
                    outputTokens: 4,
                    updatedAt: DateTime.formatIso(time),
                  },
                  turnTokenUsage: {
                    usageScope: "main_agent",
                    usageStatus: "partial",
                    hasSubagents: false,
                    inputTokens: 18,
                    cachedInputTokens: 4,
                    outputTokens: 4,
                  },
                },
              });
            if (options.untilInterrupted) {
              open.set(id, input);
              return;
            }
            if (options.approval !== undefined)
              yield* PubSub.publish(events, {
                type: "runtime_request.updated",
                driver,
                threadId: input.threadId,
                runtimeRequest: {
                  id: RuntimeRequestId.make(`request-${input.runOrdinal}`),
                  nodeId: input.rootNodeId,
                  providerTurnId: null,
                  nativeRequestRef: null,
                  kind: "command",
                  status: "pending",
                  responseCapability:
                    options.requestCapability === "not_resumable"
                      ? { type: "not_resumable", reason: "Fixture process stopped" }
                      : { type: "live", providerSessionId: session.providerSessionId },
                  createdAt: time,
                  resolvedAt: null,
                },
              });
            const finish = Effect.gen(function* () {
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id,
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: null,
                  ordinal: input.runOrdinal,
                  status: options.failed ? "failed" : "completed",
                  startedAt: time,
                  completedAt: time,
                  ...(options.piUsage
                    ? {}
                    : {
                        turnTokenUsage: {
                          usageScope: "main_agent",
                          usageStatus: "complete",
                          hasSubagents: false,
                          inputTokens: 20,
                          cachedInputTokens: 5,
                          outputTokens: 10,
                        },
                      }),
                  tokenUsage: {
                    usedTokens: 30,
                    inputTokens: 2,
                    cachedInputTokens: options.piUsage ? 100 : 1,
                    outputTokens: 6,
                    updatedAt: DateTime.formatIso(time),
                  },
                },
              });
              yield* PubSub.publish(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: input.providerThread.id,
                providerTurnId: id,
                runOrdinal: input.runOrdinal,
                ...(options.failed
                  ? {
                      status: "failed" as const,
                      failureItemOrdinal: 1,
                      failure: {
                        class: "provider_error" as const,
                        message: "Fixture provider failure",
                        code: null,
                        retryable: false,
                      },
                    }
                  : { status: "completed" as const, failure: null }),
                threadDisposition: "reusable",
              });
            });
            if (options.approval === undefined) return yield* finish;
            yield* Deferred.await(options.approval).pipe(Effect.andThen(finish), Effect.forkDetach);
          }),
          compactThread: (input) => runtime.startTurn(input),
          steerTurn: () => Effect.void,
          interruptTurn: Effect.fn("test.interruptTurn")(function* ({ providerTurnId }) {
            const turn = open.get(providerTurnId);
            if (turn === undefined) return;
            open.delete(providerTurnId);
            const time = yield* DateTime.now;
            yield* PubSub.publish(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: null,
                ordinal: turn.runOrdinal,
                status: "interrupted",
                startedAt: time,
                completedAt: time,
              },
            });
            yield* PubSub.publish(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThread.id,
              providerTurnId,
              runOrdinal: turn.runOrdinal,
              status: "interrupted",
              failure: null,
              threadDisposition: "reusable",
            });
          }),
          respondToRuntimeRequest: (response) =>
            options.approval === undefined
              ? Effect.void
              : Deferred.succeed(options.approval, response.decision).pipe(Effect.asVoid),
          readThreadSnapshot: () => Effect.die("unused snapshot"),
          rollbackThread: () => Effect.die("unused rollback"),
          forkThread: () => Effect.die("unused fork"),
        };
        return runtime;
      }),
  };
  const orchestration = ProviderReplayHarness.layerWithRegistry(
    { name: "kin-wakeup" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database },
  );
  const settings = ServerSettings.layerTest(options.settings);
  const receipts = CommandReceiptStore.layer.pipe(Layer.provide(database));
  const sharedWith = options.sharedWith;
  const management = ThreadManagement.layer.pipe(
    Layer.updateService(ProviderSessionManager.ProviderSessionManagerV2, (sessions) => ({
      ...sessions,
      otherWorkingThreads:
        sharedWith === undefined ? sessions.otherWorkingThreads : () => Effect.succeed(sharedWith),
      releaseUnlessBusy: Effect.fn("test.releaseUnlessBusy")(function* (input) {
        if (options.releaseEntered !== undefined)
          yield* Deferred.succeed(options.releaseEntered, undefined);
        if (options.releaseHold !== undefined) yield* Deferred.await(options.releaseHold);
        const released = yield* sessions.releaseUnlessBusy(input);
        if (options.releaseDone !== undefined)
          yield* Deferred.succeed(options.releaseDone, undefined);
        return released;
      }),
    })),
    Layer.provide(Layer.mergeAll(orchestration, settings, receipts)),
  );
  const projectLayer = Layer.mock(ProjectService.ProjectService)({
    bootstrap: () => Effect.succeed({ project, created: true }),
    getById: () => Effect.succeedSome(project),
    getByWorkspaceRoot: () => Effect.succeedSome(project),
  });
  const external = Layer.mergeAll(
    projectLayer,
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(GitWorkflow.GitWorkflowService)({}),
    Layer.mock(TextGeneration.TextGeneration)({}),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread: () => Effect.succeed({ status: "no-script" }),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/private/tmp",
      isScratchProject: () => Effect.succeed(false),
      folderForThread: () => Effect.succeedNone,
    }),
    ProviderRegistryMock.layer(),
    settings,
  );
  const launch = ThreadLaunch.layer.pipe(
    Layer.provide(Layer.mergeAll(external, management, receipts, IdAllocator.layer)),
  );
  const kin = Layer.mergeAll(
    KinEventQueue.layer,
    KinStop.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          KinEventQueue.layer,
          Hub.layer.pipe(Layer.provideMerge(KinChatRepository.layer)),
        ),
      ),
    ),
    Budget.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          MemoryCache.layer,
          KinEventQueue.layer,
          Hub.layer.pipe(Layer.provideMerge(KinChatRepository.layer)),
        ),
      ),
    ),
    KinLeadRegistry.layer,
    KinIdentity.KinIdentity.layer.pipe(
      Layer.provide(KinChatRepository.layer),
      Layer.provide(
        Layer.succeed(KinIdentity.KinIdentityConfig, {
          orgName: "Org",
          ownerHandle: "owner",
          ownerDisplayName: "Owner",
        }),
      ),
    ),
    Layer.succeed(KinLeadPrompt, { build: () => Effect.succeed("Wake up") }),
    Layer.mock(Memory.Memory)({
      prepareWakeup:
        options.prepare ??
        (() => Effect.succeed({ head: "abc", indexAsOf: DateTime.makeUnsafe(timestamp) })),
      ensureCheckouts: () => Effect.succeed({ writer: "/private/tmp", read: "/private/tmp" }),
    }),
  );
  const stack = Layer.mergeAll(
    launch,
    management,
    projectLayer,
    orchestration,
    settings,
    Layer.effect(
      KinIssuedTokens.KinIssuedTokens,
      Effect.map(KinIssuedTokens.make, (tokens) => tokens.service),
    ),
    McpSessionRegistry.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(HttpServer.HttpServer)({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("test")),
          }),
        ),
      ),
    ),
  );
  return {
    database,
    stack,
    kin: Layer.merge(kin, (options.writer ?? Layer.empty).pipe(Layer.provide(database))),
  };
}

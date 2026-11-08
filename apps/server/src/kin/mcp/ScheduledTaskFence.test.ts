import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as RemoteDelegation from "../../peer/RemoteDelegation.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ScheduledTaskFence from "./ScheduledTaskFence.ts";

const callerId = ThreadId.make("thread:kin-fence-caller");
const caller = McpToolAccessTestkit.liveThreadShell(callerId);
const sameProject = caller.projectId;
const otherProject = ProjectId.make("project:kin-fence-other");
const kinId = ScheduledTaskId.make("scheduled-task:kin:webhook:github-app");
const plainId = ScheduledTaskId.make("scheduled-task:nightly");

const task = (id: ScheduledTaskId, projectId: ProjectId): ScheduledTask => ({
  id,
  title: id,
  prompt: "Check the build",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId,
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdBy: "system",
  creationSource: "web",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
});

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:kin-fence"),
  requestNamespace: "provider:kin-fence",
  thread: {
    threadId: callerId,
    providerSessionId: "provider:kin-fence",
    providerInstanceId: caller.providerInstanceId,
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "kin-fence", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "kin-fence", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const kinEnabled = (enabled: boolean) =>
  Layer.succeed(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnv({ env: { KIN_ENABLED: String(enabled) } }),
  );

/** Records every write that reaches the real service. */
const scheduledTasks = (tasks: ReadonlyArray<ScheduledTask>, writes: Ref.Ref<Array<string>>) => {
  const record = (write: string) => Ref.update(writes, (all) => [...all, write]);
  const find = (id: ScheduledTaskId) => tasks.find((candidate) => candidate.id === id)!;
  return Layer.mock(ScheduledTaskService.ScheduledTaskService)({
    list: () => Effect.succeed({ tasks }),
    upsert: (input: ScheduledTaskUpsertInput) => {
      const id = input.id ?? ScheduledTaskId.make(`scheduled-task:${input.commandId ?? "new"}`);
      return record(`upsert ${id}`).pipe(
        Effect.as({ task: { ...task(id, input.projectId), threadId: input.threadId ?? null } }),
      );
    },
    setEnabled: (input) =>
      record(`setEnabled ${input.id}`).pipe(Effect.as({ task: find(input.id) })),
    delete: (input) => record(`delete ${input.id}`).pipe(Effect.as({ id: input.id })),
    runNow: (input) =>
      record(`runNow ${input.id}`).pipe(Effect.as({ task: find(input.id), threadId: null })),
    rotateWebhookToken: (input) =>
      record(`rotate ${input.id}`).pipe(Effect.as({ task: find(input.id) })),
  });
};

const toolkits = (tasks: ReadonlyArray<ScheduledTask>, writes: Ref.Ref<Array<string>>) =>
  Layer.mergeAll(McpHttpServer.layerOrchestratorToolkit, McpHttpServer.layerThreadToolkit).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        resolvePrimaryRemoteName: () => Effect.succeed("origin"),
        resolveDefaultBranchName: () => Effect.succeed("main"),
        resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
        getThreadRecords: () =>
          Effect.succeed(McpToolAccessTestkit.idleThreadProjection(caller) as never),
      }),
    ),
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ),
    Layer.provide(
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(scheduledTasks(tasks, writes)),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (projectId) =>
          Effect.succeedSome({
            id: projectId,
            workspaceRoot: "/repo",
            defaultModelSelection: caller.modelSelection,
          } as never),
      }),
    ),
    Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
  );

const call = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

/** Every MCP write an agent could aim at an existing task. */
const attempts = (id: ScheduledTaskId) =>
  [
    ["schedule_task", { scheduledTaskId: id, prompt: "Do something else" }],
    ["schedule_task", { scheduledTaskId: id, enabled: false }],
    ["delete_scheduled_task", { scheduledTaskId: id }],
    ["run_scheduled_task_now", { taskId: id }],
  ] as const;

describe("Kin's scheduled tasks behind T3's MCP tools", () => {
  it.effect.each([
    { caller: "in the same project", projectId: sameProject },
    { caller: "in another project", projectId: otherProject },
  ])("refuse an agent $caller while Kin is on", ({ projectId }) =>
    Effect.gen(function* () {
      const writes = yield* Ref.make<Array<string>>([]);
      yield* Effect.gen(function* () {
        for (const [tool, args] of attempts(kinId)) {
          expect(declaredFailure(yield* call(tool, args)), tool).toMatchObject({
            message: expect.stringContaining("is managed by Kin"),
          });
        }
        // A create can't land on a Kin id: the agent's key is scoped under its own session.
        const created = yield* call("schedule_task", {
          projectId,
          prompt: "Check the build",
          schedule: { type: "interval", everyMs: 3_600_000 },
          clientRequestId: "kin:webhook:github-app",
        });
        expect(created.isError).toBe(false);
        const listed = yield* call("list_scheduled_tasks", { projectId });
        expect(listed.isError).toBe(false);
        for (const [tool, args] of attempts(plainId)) {
          expect((yield* call(tool, args)).isError, tool).toBe(false);
        }
      }).pipe(
        Effect.provide(
          toolkits([task(kinId, projectId), task(plainId, projectId)], writes).pipe(
            Layer.provide(kinEnabled(true)),
          ),
        ),
      );
      const all = yield* Ref.get(writes);
      expect(all.filter((write) => write.includes("kin:webhook"))).toEqual([]);
      expect(all.filter((write) => write.endsWith(plainId))).toEqual([
        `upsert ${plainId}`,
        `upsert ${plainId}`,
        `delete ${plainId}`,
        `runNow ${plainId}`,
      ]);
    }),
  );

  it.effect("change nothing while Kin is off", () =>
    Effect.gen(function* () {
      const writes = yield* Ref.make<Array<string>>([]);
      yield* Effect.gen(function* () {
        for (const [tool, args] of attempts(kinId)) {
          expect((yield* call(tool, args)).isError, tool).toBe(false);
        }
      }).pipe(
        Effect.provide(
          toolkits([task(kinId, otherProject)], writes).pipe(Layer.provide(kinEnabled(false))),
        ),
      );
      expect(yield* Ref.get(writes)).toEqual([
        `upsert ${kinId}`,
        `upsert ${kinId}`,
        `delete ${kinId}`,
        `runNow ${kinId}`,
      ]);
    }),
  );

  it.effect.each([true, false])("the fenced service with KIN_ENABLED=%s", (enabled) =>
    Effect.gen(function* () {
      const writes = yield* Ref.make<Array<string>>([]);
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const results = yield* Effect.forEach(
          [
            service.upsert({
              ...task(kinId, sameProject),
              id: undefined,
              commandId: CommandId.make("kin:webhook:github-app"),
            }),
            service.setEnabled({ id: kinId, enabled: false }),
            service.rotateWebhookToken({ id: kinId }),
          ],
          Effect.exit,
        );
        expect(results.map((exit) => exit._tag)).toEqual(
          enabled ? ["Failure", "Failure", "Failure"] : ["Success", "Success", "Success"],
        );
      }).pipe(
        Effect.provide(
          ScheduledTaskFence.layer.pipe(
            Layer.provide(scheduledTasks([task(kinId, sameProject)], writes)),
            Layer.provide(kinEnabled(enabled)),
          ),
        ),
      );
      expect((yield* Ref.get(writes)).length).toBe(enabled ? 0 : 3);
    }),
  );
});

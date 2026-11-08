import { SecretRequests } from "../../secrets/SecretRequests.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { OrchestratorMcpService } from "../../mcp/OrchestratorMcpService.ts";
import * as McpService from "../../mcp/OrchestratorMcpService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ScheduledTaskService } from "../../scheduledTasks/ScheduledTaskService.ts";
import { RemoteDelegation } from "../../peer/RemoteDelegation.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EventId,
  KinAgentId,
  KinOrgId,
  KinPersonId,
  ThreadId,
  RuntimeRequestId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Chat from "./layer.ts";
import { KinIdentity } from "./KinIdentity.ts";
import { KinChatService } from "./KinChatService.ts";
import { KinChatRepository } from "./KinChatRepository.ts";
import * as TaskCard from "../widgets/taskCard.ts";
import * as Updater from "./TaskCardUpdater.ts";

const instanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("child");
const timestamp = "1970-01-01T00:00:00.000Z";
const state = {
  taskId: "task",
  environmentId: "environment",
  threadId,
  remoteEnvironmentId: null,
  title: "Work",
  model: null,
  status: "failed",
  pullRequests: [{ url: "invented", number: 99 }],
  lastError: "invented",
  updatedAt: timestamp,
};
const base = Chat.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const seed = Effect.gen(function* () {
  const repo = yield* KinChatRepository;
  const identity = yield* KinIdentity;
  const service = yield* KinChatService;
  const person = (yield* identity.resolve({
    sessionId: AuthSessionId.make("owner"),
    subject: "browser",
    method: "browser-session-cookie",
    scopes: AuthStandardClientScopes,
  }))[0]!;
  const agentId = KinAgentId.make("lead");
  yield* repo.insertAgent({
    ...person,
    agentId,
    ownerPersonId: person.personId,
    displayName: "Lead",
    role: "lead",
    createdAt: timestamp,
  });
  const chat = yield* service.createDirect(person, { orgId: person.orgId, agentId });
  yield* identity.registerAgentThread({ ...person, agentId, threadId });
  const agent = yield* identity.resolveAgent({
    environmentId: TaskCard.decodeTaskCard(state).environmentId,
    issuedAt: 0,
    capabilities: new Set(),
    requestNamespace: "test",
    client: undefined,
    thread: {
      threadId,
      providerSessionId: "session",
      providerInstanceId: liveThreadShell(threadId).providerInstanceId,
    },
  });
  return { repo, service, person, agent, chat };
});

it.effect("maps authoritative thread state, including pending decisions", () =>
  Effect.sync(() => {
    const shell = liveThreadShell(threadId);
    const rows: ReadonlyArray<[Partial<OrchestrationV2ThreadShell>, string]> = [
      [{ status: "running" }, "working"],
      [{ status: "queued" }, "working"],
      [{ blockedOnThreadWait: true }, "blocked"],
      [{ status: "waiting" }, "waiting"],
      [{ status: "idle" }, "waiting"],
      [{ status: "completed" }, "done"],
      [{ status: "failed", lastError: "error" }, "failed"],
      [{ status: "interrupted" }, "cancelled"],
      [{ status: "cancelled" }, "cancelled"],
      [{ status: "rolled_back" }, "cancelled"],
      [{ archivedAt: shell.createdAt }, "cancelled"],
      [{ deletedAt: shell.createdAt }, "cancelled"],
      [{ status: "completed", activityRunStatus: "running" }, "working"],
      [{ activityRunStatus: "waiting" }, "waiting"],
      [
        {
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("approval"),
            kind: "command",
            createdAt: shell.createdAt,
          },
        },
        "needs_decision",
      ],
    ];
    for (const [patch, expected] of rows)
      assert.strictEqual(
        TaskCard.taskCardState(TaskCard.decodeTaskCard(state), { ...shell, ...patch }, timestamp)
          .status,
        expected,
      );
  }),
);

it.effect.each(["completed", "missing"] as const)(
  "rechecks %s startup cards, coalesces events, preserves authority, and stops closed cards",
  (startupStatus) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      let shell: OrchestrationV2ThreadShell | null = liveThreadShell(threadId);
      let reads = 0;
      const orchestration = Layer.mock(OrchestratorV2)({
        getThreadShell: () =>
          Effect.sync(() => {
            reads++;
            return shell;
          }),
        streamDomainEvents: Stream.fromQueue(events),
      });
      yield* Effect.gen(function* () {
        const { repo, service, agent, person, chat } = yield* seed;
        assert.include(
          yield* service
            .upsertWidget(agent, {
              chatId: chat.chatId,
              type: "task",
              state: { ...state, threadId: null },
            })
            .pipe(Effect.flip),
          { reason: "not_found" },
        );
        const widget = yield* service.upsertWidget(agent, {
          chatId: chat.chatId,
          type: "task",
          state,
        });
        assert.strictEqual(TaskCard.decodeTaskCard(widget.state).status, "working");
        assert.deepEqual(TaskCard.decodeTaskCard(widget.state).pullRequests, []);
        const otherOrg = KinOrgId.make("other-org");
        const otherPerson = {
          ...person,
          orgId: otherOrg,
          personId: KinPersonId.make("other-person"),
        };
        yield* repo.insertOrg({ orgId: otherOrg, name: "Other", createdAt: timestamp });
        yield* repo.insertPerson({
          ...otherPerson,
          handle: "other",
          displayName: "Other",
          githubLogin: null,
          createdAt: timestamp,
        });
        const otherAgent = KinAgentId.make("other-agent");
        yield* repo.insertAgent({
          ...otherPerson,
          agentId: otherAgent,
          ownerPersonId: otherPerson.personId,
          displayName: "Other",
          role: "lead",
          createdAt: timestamp,
        });
        const otherChat = yield* service.createDirect(otherPerson, {
          orgId: otherOrg,
          agentId: otherAgent,
        });
        const otherCard = yield* service.upsertWidget(otherPerson, {
          chatId: otherChat.chatId,
          type: "task",
          state,
        });
        const stream = yield* Stream.toQueue(service.subscribe([person], { chatId: chat.chatId }), {
          capacity: "unbounded",
        });
        assert.strictEqual((yield* Queue.take(stream))._tag, "backlog");
        const pullRequests = [
          {
            host: "github.com",
            repository: "GLDRoger/t3code",
            number: 1,
            url: "https://github.com/GLDRoger/t3code/pull/1",
            source: "manual" as const,
            linkedAt: timestamp,
            snapshot: null,
            stack: null,
          },
        ];
        shell =
          startupStatus === "missing"
            ? null
            : {
                ...liveThreadShell(threadId),
                status: "completed",
                lastError: "provider error",
                pullRequests,
              };
        const startupReads = reads;
        yield* Layer.build(Updater.layer);
        assert.strictEqual(reads, startupReads + 1);
        const startup = yield* Queue.take(stream);
        assert.strictEqual(startup._tag, "widget");
        if (startup._tag !== "widget") return;
        assert.strictEqual(
          TaskCard.decodeTaskCard(startup.widget.state).status,
          startupStatus === "missing" ? "cancelled" : "done",
        );
        assert.deepEqual(Option.getOrThrow(yield* repo.getWidget(otherCard)), otherCard);
        const before = reads;
        shell = {
          ...liveThreadShell(threadId),
          lastError: "provider error",
          pullRequests,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("approval"),
            kind: "command",
            createdAt: liveThreadShell(threadId).createdAt,
          },
        };
        const event: OrchestrationV2DomainEvent = {
          id: EventId.make("event"),
          threadId,
          type: "thread.deleted",
          occurredAt: DateTime.makeUnsafe(timestamp),
          payload: idleThreadProjection(liveThreadShell(threadId)).thread,
        };
        yield* Queue.offerAll(events, [event, event, event]);
        yield* TestClock.adjust("1 second");
        const decision = yield* Queue.take(stream);
        assert.strictEqual(decision._tag, "widget");
        if (decision._tag !== "widget") return;
        assert.strictEqual(TaskCard.decodeTaskCard(decision.widget.state).status, "needs_decision");
        assert.strictEqual(reads, before + 1);
        const edited = yield* service.upsertWidget(agent, {
          chatId: chat.chatId,
          widgetId: widget.widgetId,
          revision: decision.widget.revision,
          type: "task",
          state,
        });
        assert.strictEqual(TaskCard.decodeTaskCard(edited.state).status, "needs_decision");
        assert.strictEqual(TaskCard.decodeTaskCard(edited.state).lastError, "provider error");
        assert.deepEqual(TaskCard.decodeTaskCard(edited.state).pullRequests, [
          { url: pullRequests[0]!.url, number: 1 },
        ]);
        assert.deepEqual(
          yield* service.upsertWidget(agent, {
            chatId: chat.chatId,
            widgetId: widget.widgetId,
            revision: decision.widget.revision,
            type: "task",
            state,
          }),
          edited,
        );
        const closed = yield* service.upsertWidget(agent, {
          chatId: chat.chatId,
          widgetId: widget.widgetId,
          revision: edited.revision,
          type: "task",
          state,
          closed: true,
        });
        assert.isNotNull(closed.closedAt);
        const index = yield* TaskCard.TaskCardIndex;
        assert.isFalse(index.threads.has(threadId));
        const closedReads = reads;
        yield* Queue.offer(events, event);
        yield* TestClock.adjust("2 seconds");
        assert.strictEqual(reads, closedReads);
        assert.strictEqual(
          Option.getOrThrow(yield* repo.getWidget(widget)).revision,
          closed.revision,
        );
        assert.strictEqual(
          (yield* service.history(person, { chatId: chat.chatId, beforeSeq: 999, limit: 100 }))
            .messages.length,
          1,
        );
        assert.deepEqual(Option.getOrThrow(yield* repo.getWidget(otherCard)), otherCard);
        shell = null;
        assert.include(
          yield* service
            .upsertWidget(agent, { chatId: chat.chatId, type: "task", state })
            .pipe(Effect.flip),
          { reason: "not_found" },
        );
        const remote = yield* service.upsertWidget(agent, {
          chatId: chat.chatId,
          type: "task",
          state: { ...state, remoteEnvironmentId: "remote" },
        });
        assert.strictEqual(TaskCard.decodeTaskCard(remote.state).status, "waiting");
        assert.isFalse(index.threads.has(threadId));
      }).pipe(Effect.provide(base.pipe(Layer.provideMerge(orchestration))));
    }),
);

it.effect("streams a real delegated child state change through kin.chat.subscribe", () =>
  Effect.gen(function* () {
    const adapterContext = yield* Layer.build(
      Layer.mock(ProviderAdapter.ProviderAdapterV2)({
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      }),
    );
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name: "kin-task-card" },
      ProviderAdapterRegistry.layerSingle(
        Context.get(adapterContext, ProviderAdapter.ProviderAdapterV2),
      ),
      { runEffectWorker: false },
    );
    yield* Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const { service, agent, person, chat } = yield* seed;
      const parent = ThreadId.make("lead-parent");
      const modelSelection = { instanceId, model: "test-model" };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-parent"),
        threadId: parent,
        projectId: ProjectId.make("project"),
        title: "Lead",
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
        commandId: CommandId.make("start-parent"),
        threadId: parent,
        messageId: MessageId.make("prompt"),
        text: "Delegate work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const mcpContext = yield* Layer.build(
        McpService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ThreadManagementService)({
                dispatch: orchestrator.dispatch,
                getThreadRecords: orchestrator.getThreadRecords,
                getThreadShell: orchestrator.getThreadShell,
                hasReceipt: () => Effect.succeed(false),
                isProviderInstanceEnabledForProject: () => Effect.succeed(true),
              }),
              Layer.mock(SecretRequests)({}),
              Layer.mock(ThreadLaunchService)({}),
              Layer.mock(ProjectService)({}),
              Layer.mock(ScheduledTaskService)({}),
              Layer.mock(RemoteDelegation)({}),
              Layer.mock(GitVcsDriver)({}),
              NodeCrypto.layer,
              ServerSettings.layerTest(),
              ProviderAdapterRegistry.layerSingle(
                Context.get(adapterContext, ProviderAdapter.ProviderAdapterV2),
              ),
              ProviderRegistryMock.layer([
                {
                  instanceId,
                  driver: ProviderDriverKind.make("codex"),
                  enabled: true,
                  installed: true,
                  version: "test",
                  status: "ready",
                  auth: { status: "authenticated" },
                  checkedAt: timestamp,
                  models: [],
                  slashCommands: [],
                  skills: [],
                },
              ]),
            ),
          ),
        ),
      );
      const task = yield* Context.get(mcpContext, OrchestratorMcpService).delegateTask(
        {
          environmentId: TaskCard.decodeTaskCard(state).environmentId,
          requestNamespace: "lead",
          issuedAt: 0,
          client: undefined,
          capabilities: new Set(["orchestration"]),
          thread: {
            threadId: parent,
            providerSessionId: "lead-session",
            providerInstanceId: instanceId,
          },
        },
        { task: "Work", clientRequestId: "delegate", mode: "async" },
      );
      const child = task.childThreadId!;
      const widget = yield* service.upsertWidget(agent, {
        chatId: chat.chatId,
        type: "task",
        state: { ...state, taskId: task.taskId, threadId: child },
      });
      assert.strictEqual(TaskCard.decodeTaskCard(widget.state).status, "working");
      const stream = yield* Stream.toQueue(service.subscribe([person], { chatId: chat.chatId }), {
        capacity: "unbounded",
      });
      yield* Queue.take(stream);
      yield* Layer.build(Updater.layer);
      yield* Queue.take(stream);
      const childRun = (yield* orchestrator.getThreadProjection(child)).runs[0]!;
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stop-child"),
        threadId: child,
        runId: childRun.id,
      });
      yield* TestClock.adjust("1 second");
      const updated = yield* Queue.take(stream);
      assert.strictEqual(updated._tag, "widget");
      if (updated._tag !== "widget") return;
      assert.strictEqual(TaskCard.decodeTaskCard(updated.widget.state).status, "cancelled");
      assert.isAbove(updated.widget.revision, widget.revision);
      assert.strictEqual(
        (yield* service.history(person, { chatId: chat.chatId, beforeSeq: 999, limit: 100 }))
          .messages.length,
        1,
      );
    }).pipe(Effect.provide(base.pipe(Layer.provideMerge(runtime))));
  }),
);

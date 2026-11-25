import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  NodeId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as Service from "../chat/KinChatService.ts";
import * as Identity from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Presence from "../reply/KinPresence.ts";
import * as DelegatedTasks from "./DelegatedTasks.ts";
import { KinBudget } from "./KinBudget.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import { KinRefusedModels } from "./refusedModels.ts";

const at = "1970-01-01T00:00:00.000Z";
const session = ThreadId.make("kin:tech-session");
const child = ThreadId.make("invented-child");
const layer = Layer.mergeAll(Service.layer, KinEventQueue.layer).pipe(
  Layer.provideMerge(
    Identity.KinIdentity.layer.pipe(
      Layer.provide(
        Layer.succeed(Identity.KinIdentityConfig, {
          orgName: "Kin",
          ownerHandle: "owner",
          ownerDisplayName: "Owner",
        }),
      ),
    ),
  ),
  Layer.provideMerge(Presence.layer),
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory)),
  Layer.provideMerge(environment),
);

const task = (
  status: OrchestrationV2Subagent["status"],
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent => {
  const now = DateTime.makeUnsafe("2026-11-16T10:00:00.000Z");
  return {
    id: NodeId.make("invented-task"),
    threadId: session,
    runId: RunId.make("invented-run"),
    parentNodeId: NodeId.make("invented-parent"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    providerThreadId: null,
    childThreadId: child,
    nativeTaskRef: null,
    prompt: "Invented: add a dark mode toggle\nwith the details below",
    title: null,
    model: "invented-model",
    status,
    result: null,
    startedAt: now,
    completedAt: status === "completed" ? now : null,
    updatedAt: now,
    ...overrides,
  };
};

it.effect(
  "a task a lead delegates gets one card in its owner chat, and its usage is charged once when it ends",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* Repository.KinChatRepository;
      const chats = yield* Service.KinChatService;
      const identity = yield* Identity.KinIdentity;
      const { owner } = identity;
      const agentId = KinAgentId.make("tech");
      yield* repo.insertAgent({
        orgId: owner.orgId,
        agentId,
        ownerPersonId: owner.personId,
        displayName: "Tech lead",
        role: "lead",
        createdAt: at,
      });
      yield* identity.registerAgentThread({ orgId: owner.orgId, agentId, threadId: session });
      const direct = yield* chats.createDirect(owner, { orgId: owner.orgId, agentId });
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
        VALUES (${agentId}, ${owner.orgId}, 'Tech lead', 0, '{}', '[]', ${direct.chatId})`;

      const charges: Array<{ readonly threadId: string; readonly turns: number }> = [];
      const refused: Array<Parameters<KinRefusedModels["Service"]["refused"]>[0]> = [];
      const refusedChild = ThreadId.make("invented-refused-child");
      const wren = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "invented-wren-4" };
      const turns = [{ id: "invented-turn", turnTokenUsage: undefined, tokenUsage: undefined }];
      const tasks = yield* DelegatedTasks.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(KinBudget)({
              chargeTask: (input) =>
                Effect.sync(() => {
                  charges.push({ threadId: input.threadId, turns: input.usage.length });
                  return { day: "2026-11-16", units: 0 };
                }),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadRecords: () =>
                Effect.succeed({
                  providerTurns: turns,
                } as unknown as OrchestrationV2ThreadProjection),
            }),
            Layer.mock(OrchestratorV2)({
              getThreadShell: (id) =>
                Effect.succeed(
                  id === refusedChild
                    ? {
                        ...liveThreadShell(id),
                        modelSelection: wren,
                        status: "failed" as const,
                        lastErrorCode: "api_error_400",
                        lastError: "API Error: 400 unknown provider for model invented-wren-4",
                      }
                    : liveThreadShell(id),
                ),
            }),
            Layer.succeed(KinRefusedModels, {
              refused: (input) => Effect.sync(() => refused.push(input)).pipe(Effect.as(true)),
            }),
          ),
        ),
      );

      // Progress lines repeat the record; another thread's task and a provider's own stay out.
      yield* tasks.observe(task("running"));
      yield* tasks.observe(task("running", { progress: "Invented progress" }));
      yield* tasks.observe(task("running", { threadId: ThreadId.make("not-kin") }));
      yield* tasks.observe(task("running", { origin: "provider_native" }));
      assert.lengthOf(charges, 0);
      yield* tasks.observe(task("completed"));
      yield* tasks.observe(task("completed"));
      assert.deepStrictEqual(charges, [{ threadId: child, turns: 1 }]);
      assert.deepStrictEqual(refused, []);

      const cards = yield* sql<{ chatId: string; state: string }>`SELECT chat_id AS "chatId",
          state_json AS state FROM kin_widgets WHERE type = 'task' ORDER BY widget_id`;
      assert.lengthOf(cards, 1);
      assert.strictEqual(cards[0]!.chatId, direct.chatId);
      assert.include(JSON.parse(cards[0]!.state), {
        taskId: "invented-task",
        threadId: child,
        title: "Invented: add a dark mode toggle",
      });
      // The incident: a helper on a model the provider turns away. Kin stops offering it, once.
      const turnedAway = task("failed", {
        id: NodeId.make("invented-refused-task"),
        childThreadId: refusedChild,
        model: "invented-wren-4",
        completedAt: DateTime.makeUnsafe("2026-11-16T10:00:01.000Z"),
      });
      yield* tasks.observe(turnedAway);
      yield* tasks.observe(turnedAway);
      assert.deepStrictEqual(refused, [{ orgId: owner.orgId, selection: wren }]);
      yield* tasks.observe(
        task("failed", { completedAt: DateTime.makeUnsafe("2026-11-16T10:00:02.000Z") }),
      );
      assert.lengthOf(refused, 1);
    }).pipe(Effect.provide(layer)),
);

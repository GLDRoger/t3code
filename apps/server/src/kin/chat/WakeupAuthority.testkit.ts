import {
  CommandId,
  KinOrgId,
  KinEventId,
  KinWakeupId,
  type KinEvent,
  type KinMessage,
  type KinAgentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";

const database = KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const instanceId = ProviderInstanceId.make("codex");
export const authorityLayerWithDatabase = (
  databaseLayer: NonNullable<
    NonNullable<Parameters<typeof ProviderReplayHarness.layerWithRegistry>[2]>["databaseLayer"]
  >,
) =>
  ProviderReplayHarness.layerWithRegistry(
    { name: "wakeup-authority" },
    ProviderAdapterRegistry.layerFromAdapters([
      {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: () => Effect.die("Authority tests do not start provider processes"),
      },
    ]),
    { databaseLayer, runEffectWorker: false },
  ).pipe(Layer.provideMerge(databaseLayer));

export const authorityLayer = authorityLayerWithDatabase(database);

export const startWakeupRun = Effect.fn("test.startWakeupRun")(function* (
  threadId: ThreadId,
  wakeupId: string,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projection = yield* orchestrator.getThreadProjection(threadId).pipe(Effect.option);
  if (projection._tag === "None")
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("authority-project"),
      title: "Lead",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "system",
      creationSource: "server",
    });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`dispatch:${threadId}:${wakeupId}`),
    threadId,
    messageId: MessageId.make(`kin-wakeup-msg:${wakeupId}`),
    text: "Wake up",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "system",
    creationSource: "server",
  });
  return (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
});

export const startAgentWakeup = Effect.fn("test.startAgentWakeup")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly threadId: ThreadId;
  readonly message?: KinMessage;
}) {
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue.KinEventQueue;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const previous = yield* sql<{
    wakeup_id: string;
    run_id: string | null;
  }>`SELECT wakeup_id, run_id FROM kin_wakeups
    WHERE org_id = ${input.orgId} AND status = 'running' ORDER BY wakeup_id`;
  for (const wakeup of previous) {
    yield* queue.finish({
      orgId: input.orgId,
      wakeupId: KinWakeupId.make(wakeup.wakeup_id),
      status: "completed",
    });
    const projection = yield* orchestrator.getThreadProjection(input.threadId);
    const run = projection.runs.find((run) => run.id === wakeup.run_id);
    if (run !== undefined)
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`interrupt:${wakeup.wakeup_id}`),
        threadId: input.threadId,
        runId: run.id,
      });
  }
  const wakeupId = KinWakeupId.make(SecureRandom.uuidV4Unsafe());
  const base = {
    orgId: input.orgId,
    agentId: input.agentId,
    eventId: KinEventId.make(`event:${wakeupId}`),
    receivedAt: yield* DateTime.now,
    dedupeKey: null,
  };
  const event: KinEvent =
    input.message === undefined
      ? { ...base, _tag: "routine", provenance: { _tag: "system" }, routine: "morning_brief" }
      : {
          ...base,
          _tag: "chat.message",
          provenance: input.message.author,
          chatId: input.message.chatId,
          messageId: input.message.messageId,
        };
  yield* queue.enqueue(event);
  yield* TestClock.adjust(input.message === undefined ? 20_000 : 2_000);
  yield* Effect.scoped(
    queue.claim({ orgId: input.orgId, agentId: input.agentId, wakeupId, model: "test" }),
  );
  const run = yield* startWakeupRun(input.threadId, wakeupId);
  yield* sql`UPDATE kin_wakeups SET thread_id = ${input.threadId}, run_id = ${run.id}
    WHERE org_id = ${input.orgId} AND wakeup_id = ${wakeupId}`;
  return wakeupId;
}, Effect.provide(KinEventQueue.layer));

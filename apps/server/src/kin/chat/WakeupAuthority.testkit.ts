import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
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
export const authorityLayer = ProviderReplayHarness.layerWithRegistry(
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
  { databaseLayer: database, runEffectWorker: false },
).pipe(Layer.provideMerge(database));

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

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import type * as Layer from "effect/Layer";
import type { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import type { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import { KinIdentity } from "./chat/KinIdentity.ts";
import { KinChatService } from "./chat/KinChatService.ts";
import { KinChatHub } from "./chat/KinChatHub.ts";
import type { KinGroups } from "./chat/KinGroups.ts";
import type { KinVisualHosts } from "./chat/KinVisualHosts.ts";
import { KinBudget } from "./lead/KinBudget.ts";
import type { KinChatRepository } from "./chat/KinChatRepository.ts";
import type * as SqlClient from "effect/sql/SqlClient";
import { KinEventQueue } from "./lead/KinEventQueue.ts";
import { ApproverKeys } from "./approvals/ApproverKeys.ts";
import { GrantVerifier } from "./approvals/GrantVerifier.ts";
import type { KinRetiredActions } from "./lead/Retirement.ts";
import { KinStop } from "./lead/KinStop.ts";
import type { KinLevelGate } from "./lead/LevelGate.ts";
import type { KinLevelControl } from "./levels/LevelControl.ts";
import type { KinMemoryChanges } from "./memory/MemoryChanges.ts";
import type { KinGithubWebhookLock } from "./triggers/githubWebhooks.ts";
import type { KinOwnerTimeZone } from "./triggers/ownerTimeZone.ts";
import type { KinPushDevices } from "./push/KinPushDevices.ts";
import type { KinPushPresence } from "./push/KinPushPresence.ts";
import type { KinPushSender } from "./push/KinPushSender.ts";
import type { KinPresence } from "./reply/KinPresence.ts";
import type { KinDocRenderer } from "./gendocs/render.ts";
import type { KinWorkspace } from "./gendocs/workspace.ts";
import type { KinRecords } from "./work/KinRecords.ts";

export type Services =
  | KinIdentity
  | KinChatService
  | KinGroups
  | KinBudget
  | KinChatRepository
  | SqlClient.SqlClient
  | KinEventQueue
  | KinChatHub
  | KinStop
  | KinOwnerTimeZone
  | KinVisualHosts
  | KinLevelGate
  | KinLevelControl
  | KinMemoryChanges
  | KinGithubWebhookLock
  | ApproverKeys
  | GrantVerifier
  | KinRetiredActions
  | KinPushDevices
  | KinPushPresence
  | KinPushSender
  | KinPresence
  | KinRecords
  | KinWorkspace
  | KinDocRenderer;

export class KinServer extends Context.Service<
  KinServer,
  {
    readonly taskCardUpdater: Layer.Layer<never, never, OrchestratorV2>;
    /**
     * Installs T3's own credential reader into the executor's slot. The slot stays out of
     * `services`, so nothing holding them can install a reader that hides T3's tokens first.
     */
    readonly t3GitHubCredential: Layer.Layer<
      never,
      never,
      SourceControlHost.SourceControlHost | ProjectStoreV2
    >;
    readonly services: Option.Option<Context.Context<Services>>;
    readonly subscribeForViewer: Option.Option<KinChatHub["Service"]["subscribeForViewer"]>;
  }
>()("t3/kin/KinServer") {}

import type * as Layer from "effect/Layer";
import type { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import { KinIdentity } from "./chat/KinIdentity.ts";
import { KinChatService } from "./chat/KinChatService.ts";
import { KinChatHub } from "./chat/KinChatHub.ts";
import { KinBudget } from "./lead/KinBudget.ts";
import { KinEventQueue } from "./lead/KinEventQueue.ts";
import { KinStop } from "./lead/KinStop.ts";
import type { KinGithubWebhookLock } from "./triggers/githubWebhooks.ts";

export type Services =
  | KinIdentity
  | KinChatService
  | KinBudget
  | KinEventQueue
  | KinChatHub
  | KinStop
  | KinGithubWebhookLock;

export class KinServer extends Context.Service<
  KinServer,
  {
    readonly taskCardUpdater: Layer.Layer<never, never, OrchestratorV2>;
    readonly services: Option.Option<Context.Context<Services>>;
    readonly subscribeForViewer: Option.Option<KinChatHub["Service"]["subscribeForViewer"]>;
  }
>()("t3/kin/KinServer") {}

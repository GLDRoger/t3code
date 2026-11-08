import * as Context from "effect/Context";
import * as Option from "effect/Option";
import { KinIdentity } from "./chat/KinIdentity.ts";
import { KinChatService } from "./chat/KinChatService.ts";
import { KinChatHub } from "./chat/KinChatHub.ts";
import { KinBudget } from "./lead/KinBudget.ts";
import { KinEventQueue } from "./lead/KinEventQueue.ts";

export type Services = KinIdentity | KinChatService | KinBudget | KinEventQueue;

export class KinServer extends Context.Service<
  KinServer,
  {
    readonly services: Option.Option<Context.Context<Services>>;
    readonly subscribeForViewer: Option.Option<KinChatHub["Service"]["subscribeForViewer"]>;
  }
>()("t3/kin/KinServer") {}

import { TaskCardIndex } from "./widgets/taskCard.ts";
import { KinChatRepository } from "./chat/KinChatRepository.ts";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import { KinIdentity } from "./chat/KinIdentity.ts";
import { KinChatService } from "./chat/KinChatService.ts";
import { KinChatHub } from "./chat/KinChatHub.ts";

export type Services =
  | KinIdentity
  | KinChatService
  | KinChatHub
  | KinChatRepository
  | TaskCardIndex
  | SqlClient.SqlClient;

export class KinServer extends Context.Service<
  KinServer,
  {
    readonly services: Option.Option<Context.Context<Services>>;
    readonly subscribeForViewer: Option.Option<KinChatHub["Service"]["subscribeForViewer"]>;
  }
>()("t3/kin/KinServer") {}

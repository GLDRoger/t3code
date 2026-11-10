import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { KinActionId } from "./kinApprovals.ts";
import { KinAgentId, KinChatError, KinChatId, KinOrgId } from "./kinChat.ts";
import { CanonicalUtcTimestamp, KinLevel } from "./kinLead.ts";

export const KinLevelsView = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  level: KinLevel,
  levelSince: Schema.toEncoded(CanonicalUtcTimestamp),
  chats: Schema.Array(
    Schema.Struct({
      chatId: KinChatId,
      level: KinLevel,
      levelSince: Schema.toEncoded(CanonicalUtcTimestamp),
    }),
  ),
  /** Open `set_level` requests for this lead, waiting on the owner's signature or the executor. */
  pendingRaises: Schema.Array(
    Schema.Struct({
      actionId: KinActionId,
      chatId: Schema.NullOr(KinChatId),
      level: KinLevel,
      state: Schema.Literals(["awaiting_approval", "approved", "executing"]),
    }),
  ),
});
export type KinLevelsView = typeof KinLevelsView.Type;

const LeadRef = { orgId: KinOrgId, agentId: KinAgentId };
export const KinLevelsGetInput = Schema.Struct(LeadRef);
export type KinLevelsGetInput = typeof KinLevelsGetInput.Type;
/** Without `chatId` it sets the lead's own level; with one, that chat's cap. */
export const KinLevelsSetInput = Schema.Struct({
  ...LeadRef,
  chatId: Schema.optional(KinChatId),
  level: KinLevel,
});
export type KinLevelsSetInput = typeof KinLevelsSetInput.Type;
export const KinLevelsRaiseResult = Schema.Struct({ actionId: KinActionId });
export type KinLevelsRaiseResult = typeof KinLevelsRaiseResult.Type;

export const KIN_LEVEL_WS_METHODS = {
  get: "kin.levels.get",
  lower: "kin.levels.lower",
  raise: "kin.levels.raise",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
// Owner of the lead only, on the server. No client screen calls these; they stay the internal way
// to change what a lead may do, applied only through a signed `set_level` approval.
export const KinLevelRpcs = [
  Rpc.make(KIN_LEVEL_WS_METHODS.get, {
    payload: KinLevelsGetInput,
    success: KinLevelsView,
    error,
  }),
  Rpc.make(KIN_LEVEL_WS_METHODS.lower, {
    payload: KinLevelsSetInput,
    success: KinLevelsView,
    error,
  }),
  Rpc.make(KIN_LEVEL_WS_METHODS.raise, {
    payload: KinLevelsSetInput,
    success: KinLevelsRaiseResult,
    error,
  }),
] as const;

export const KIN_LEVEL_RPC_SCOPES = {
  [KIN_LEVEL_WS_METHODS.get]: AuthOrchestrationReadScope,
  // Levels are the lead's permissions, set like its budget.
  [KIN_LEVEL_WS_METHODS.lower]: AuthSettingsWriteScope,
  [KIN_LEVEL_WS_METHODS.raise]: AuthSettingsWriteScope,
} as const;

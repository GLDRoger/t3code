import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthOrchestrationOperateScope, EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinAgentId, KinChatError, KinOrgId, KinWidgetId } from "./kinChat.ts";
import { KinMemoryItemId } from "./kinLead.ts";

/** The widget `type` of the card the server posts after a wake-up changes memory. */
export const KIN_MEMORY_CHANGES_CARD = "memory_changes";
export const KIN_MEMORY_CHANGES_MAX = 20;
export const KIN_MEMORY_CHANGE_TITLE_MAX = 120;

export const KinMemoryChangeKind = Schema.Literals([
  "created",
  "updated",
  "superseded",
  "invalidated",
]);
export type KinMemoryChangeKind = typeof KinMemoryChangeKind.Type;

/**
 * Native `memory_changes` card, server-drawn in the owner's direct chat once per wake-up that
 * changed memory items. Undo goes to `kin.memory.undo`, never `kin.widgets.act`. Clients show
 * `title` as plain text; `path`, `branch`, `base` and `commit` are for the server.
 */
export const KinMemoryChangeCard = Schema.Struct({
  agentId: KinAgentId,
  wakeupId: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  base: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
  items: Schema.Array(
    Schema.Struct({
      itemId: KinMemoryItemId,
      path: TrimmedNonEmptyString,
      title: TrimmedNonEmptyString.check(Schema.isMaxLength(KIN_MEMORY_CHANGE_TITLE_MAX)),
      change: KinMemoryChangeKind,
      /** `stale`: the item changed again after this wake-up, so Undo was refused. */
      undo: Schema.NullOr(Schema.Literals(["undone", "stale"])),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(KIN_MEMORY_CHANGES_MAX)),
  /** Changed items past the cap, which the card counts but can't undo. */
  more: NonNegativeInt,
});
export type KinMemoryChangeCard = typeof KinMemoryChangeCard.Type;

export const KinMemoryUndoInput = Schema.Struct({
  orgId: KinOrgId,
  widgetId: KinWidgetId,
  itemId: KinMemoryItemId,
});
export type KinMemoryUndoInput = typeof KinMemoryUndoInput.Type;
export const KinMemoryUndoResult = Schema.Struct({ card: KinMemoryChangeCard });
export type KinMemoryUndoResult = typeof KinMemoryUndoResult.Type;

const KIN_MEMORY_WS_METHODS = { undo: "kin.memory.undo" } as const;

// Owner of the lead only, on the server; the scope gates the client's button.
export const KinMemoryRpcs = [
  Rpc.make(KIN_MEMORY_WS_METHODS.undo, {
    payload: KinMemoryUndoInput,
    success: KinMemoryUndoResult,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
] as const;

export const KIN_MEMORY_RPC_SCOPES = {
  [KIN_MEMORY_WS_METHODS.undo]: AuthOrchestrationOperateScope,
} as const;

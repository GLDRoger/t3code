import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinAgentId, KinChatError, KinOrgId, KinWidgetId } from "./kinChat.ts";
import { KinMemoryItemId, MemoryItemKind } from "./kinLead.ts";

/** The widget `type` of the memory change cards earlier versions posted after a wake-up. */
export const KIN_MEMORY_CHANGES_CARD = "memory_changes";
const KIN_MEMORY_CHANGES_MAX = 20;
const KIN_MEMORY_CHANGE_TITLE_MAX = 120;

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

export const KinMemoryListInput = Schema.Struct({ orgId: KinOrgId });
export type KinMemoryListInput = typeof KinMemoryListInput.Type;
/** One thing the leads remember, for the owner: who may know it, and who said it if a teammate did. */
export const KinMemoryListItem = Schema.Struct({
  itemId: KinMemoryItemId,
  kind: MemoryItemKind,
  title: Schema.String,
  /** True when only the owner's own chats with a lead use it; false when the team can know it. */
  onlyOwner: Schema.Boolean,
  from: Schema.NullOr(Schema.Struct({ name: Schema.String, chatName: Schema.String })),
});
export type KinMemoryListItem = typeof KinMemoryListItem.Type;
export const KinMemoryListResult = Schema.Struct({ items: Schema.Array(KinMemoryListItem) });
export type KinMemoryListResult = typeof KinMemoryListResult.Type;

export const KinMemorySetVisibilityInput = Schema.Struct({
  orgId: KinOrgId,
  itemId: KinMemoryItemId,
  onlyOwner: Schema.Boolean,
});
export type KinMemorySetVisibilityInput = typeof KinMemorySetVisibilityInput.Type;
export const KinMemorySetVisibilityResult = Schema.Struct({ item: KinMemoryListItem });
export type KinMemorySetVisibilityResult = typeof KinMemorySetVisibilityResult.Type;

const KIN_MEMORY_WS_METHODS = {
  undo: "kin.memory.undo",
  list: "kin.memory.list",
  setVisibility: "kin.memory.setVisibility",
} as const;

// Owner of the lead only, on the server; the scope gates the client's button.
export const KinMemoryRpcs = [
  Rpc.make(KIN_MEMORY_WS_METHODS.undo, {
    payload: KinMemoryUndoInput,
    success: KinMemoryUndoResult,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(KIN_MEMORY_WS_METHODS.list, {
    payload: KinMemoryListInput,
    success: KinMemoryListResult,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(KIN_MEMORY_WS_METHODS.setVisibility, {
    payload: KinMemorySetVisibilityInput,
    success: KinMemorySetVisibilityResult,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
] as const;

export const KIN_MEMORY_RPC_SCOPES = {
  [KIN_MEMORY_WS_METHODS.undo]: AuthOrchestrationOperateScope,
  // What the leads remember is the owner's, and who may know it is an owner setting.
  [KIN_MEMORY_WS_METHODS.list]: AuthSettingsWriteScope,
  [KIN_MEMORY_WS_METHODS.setVisibility]: AuthSettingsWriteScope,
} as const;

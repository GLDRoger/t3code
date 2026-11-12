import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinAgentId, KinChatError, KinOrgId, KinWidgetId } from "./kinChat.ts";
import { KinMemoryItemId, MemoryItemKind, MemoryTrust } from "./kinLead.ts";

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
/**
 * Who may know an item. `team` only by the owner's own authorisation (or a teammate's own words,
 * saved as theirs); `suggested` is a lead's or the nightly pass's suggestion that the team could
 * know it, which reads as `only_owner` everywhere until the owner confirms it.
 */
export const KinMemoryVisibility = Schema.Literals(["only_owner", "team", "suggested"]);
export type KinMemoryVisibility = typeof KinMemoryVisibility.Type;
/** One thing the leads remember, for the owner: who may know it, and who said it if a teammate did. */
export const KinMemoryListItem = Schema.Struct({
  itemId: KinMemoryItemId,
  kind: MemoryItemKind,
  title: Schema.String,
  /** What it says in a line or two, so the owner can decide without opening anything. */
  preview: Schema.optional(Schema.String),
  visibility: KinMemoryVisibility,
  from: Schema.NullOr(Schema.Struct({ name: Schema.String, chatName: Schema.String })),
  /**
   * Where it came from. `trust` agent is the lead's own inference. `saidAt` and `quote` are null
   * when no message is cited or the owner can no longer read it.
   */
  provenance: Schema.optional(
    Schema.Struct({
      saidBy: Schema.String,
      trust: MemoryTrust,
      recordedAt: Schema.String,
      saidAt: Schema.NullOr(Schema.String),
      quote: Schema.NullOr(Schema.String),
    }),
  ),
  /** Marks the words listed. Pass it back so a choice applies only if the item still reads so. */
  version: Schema.optional(Schema.String),
});
export type KinMemoryListItem = typeof KinMemoryListItem.Type;
export const KinMemoryListResult = Schema.Struct({ items: Schema.Array(KinMemoryListItem) });
export type KinMemoryListResult = typeof KinMemoryListResult.Type;

/** Keeping an item to the owner needs nothing more; letting the team know needs the words shown. */
export const KinMemorySetVisibilityInput = Schema.Union([
  Schema.Struct({
    orgId: KinOrgId,
    itemId: KinMemoryItemId,
    onlyOwner: Schema.Literal(true),
    version: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    orgId: KinOrgId,
    itemId: KinMemoryItemId,
    onlyOwner: Schema.Literal(false),
    /** The listed `version`: refused, and nothing changes, if the item reads otherwise now. */
    version: Schema.String,
  }),
]);
export type KinMemorySetVisibilityInput = typeof KinMemorySetVisibilityInput.Type;
export const KinMemorySetVisibilityResult = Schema.Struct({ item: KinMemoryListItem });
export type KinMemorySetVisibilityResult = typeof KinMemorySetVisibilityResult.Type;

/** Most items one `confirmSuggestions` call names; a longer list is sent in chunks. */
export const KIN_MEMORY_CONFIRM_MAX = 500;
/**
 * The owner lets the team know the suggested items they were shown, each only as its `versions`
 * entry (id to listed `version`) says. An item no longer suggested, or reading otherwise now,
 * stays as it is.
 */
export const KinMemoryConfirmSuggestionsInput = Schema.Struct({
  orgId: KinOrgId,
  itemIds: Schema.Array(KinMemoryItemId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(KIN_MEMORY_CONFIRM_MAX),
  ),
  versions: Schema.Record(Schema.String, Schema.String),
});
export type KinMemoryConfirmSuggestionsInput = typeof KinMemoryConfirmSuggestionsInput.Type;
/** The items the team may now know. */
export const KinMemoryConfirmSuggestionsResult = Schema.Struct({
  items: Schema.Array(KinMemoryListItem),
});
export type KinMemoryConfirmSuggestionsResult = typeof KinMemoryConfirmSuggestionsResult.Type;

/**
 * The owner removes one item from what the leads remember. It is marked no longer true, never
 * deleted, so its history stays in the memory repo.
 */
export const KinMemoryForgetInput = Schema.Struct({ orgId: KinOrgId, itemId: KinMemoryItemId });
export type KinMemoryForgetInput = typeof KinMemoryForgetInput.Type;
export const KinMemoryForgetResult = Schema.Struct({ itemId: KinMemoryItemId });
export type KinMemoryForgetResult = typeof KinMemoryForgetResult.Type;

const KIN_MEMORY_WS_METHODS = {
  undo: "kin.memory.undo",
  list: "kin.memory.list",
  setVisibility: "kin.memory.setVisibility",
  confirmSuggestions: "kin.memory.confirmSuggestions",
  forget: "kin.memory.forget",
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
  Rpc.make(KIN_MEMORY_WS_METHODS.confirmSuggestions, {
    payload: KinMemoryConfirmSuggestionsInput,
    success: KinMemoryConfirmSuggestionsResult,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(KIN_MEMORY_WS_METHODS.forget, {
    payload: KinMemoryForgetInput,
    success: KinMemoryForgetResult,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
] as const;

export const KIN_MEMORY_RPC_SCOPES = {
  [KIN_MEMORY_WS_METHODS.undo]: AuthOrchestrationOperateScope,
  // What the leads remember is the owner's, and who may know it is an owner setting.
  [KIN_MEMORY_WS_METHODS.list]: AuthSettingsWriteScope,
  [KIN_MEMORY_WS_METHODS.setVisibility]: AuthSettingsWriteScope,
  [KIN_MEMORY_WS_METHODS.confirmSuggestions]: AuthSettingsWriteScope,
  [KIN_MEMORY_WS_METHODS.forget]: AuthSettingsWriteScope,
} as const;

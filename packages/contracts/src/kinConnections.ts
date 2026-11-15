import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChatError, KinOrgId } from "./kinChat.ts";

/**
 * Connections: an owner's sign-in to an outside service, reached by Kin's server as an MCP client.
 * Only the owner reads or changes them; agents reach a connection's tools through Kin's own
 * connection tools, and never see a credential.
 */
const KIN_CONNECTION_PRESETS = ["github", "posthog", "sentry", "google", "zoho_books"] as const;
export const KinConnectionPreset = Schema.Literals(KIN_CONNECTION_PRESETS);
export type KinConnectionPreset = typeof KinConnectionPreset.Type;

export const KinConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("KinConnectionId"),
);
export type KinConnectionId = typeof KinConnectionId.Type;

/** `off`: never called. `read`: agents call it in owner-only turns. `ask`: a card per call (later). */
export const KinConnectionToolMode = Schema.Literals(["off", "read", "ask"]);
export type KinConnectionToolMode = typeof KinConnectionToolMode.Type;

/** `closed`: talks only to the vendor that holds the data. `open`: may reach anywhere. */
export const KinConnectionReach = Schema.Literals(["closed", "open"]);
export type KinConnectionReach = typeof KinConnectionReach.Type;

export const KinConnectionState = Schema.Literals([
  "active",
  "needs_sign_in",
  "needs_review",
  "error",
]);
export type KinConnectionState = typeof KinConnectionState.Type;

/** A service the owner can add, or one whose sign-in isn't built yet (`available: false`). */
export const KinConnectionService = Schema.Struct({
  service: Schema.Union([KinConnectionPreset, Schema.Literal("custom")]),
  label: Schema.String,
  available: Schema.Boolean,
  /** One line on where to make the key, for key presets. */
  setup: Schema.NullOr(Schema.String),
});
export type KinConnectionService = typeof KinConnectionService.Type;

export const KinConnection = Schema.Struct({
  connectionId: KinConnectionId,
  preset: Schema.NullOr(KinConnectionPreset),
  label: Schema.String,
  kind: Schema.Literals(["remote", "builtin"]),
  /** Null when the URL itself is a secret. */
  url: Schema.NullOr(Schema.String),
  urlHost: Schema.String,
  auth: Schema.Literals(["none", "key", "oauth"]),
  reach: KinConnectionReach,
  state: KinConnectionState,
  accountLabel: Schema.NullOr(Schema.String),
  protocolVersion: Schema.NullOr(Schema.String),
  /** The server's instructions as last listed, and as the owner last accepted them. */
  instructions: Schema.NullOr(Schema.String),
  instructionsDigest: Schema.NullOr(Schema.String),
  acceptedInstructions: Schema.NullOr(Schema.String),
  /** Tools whose pinned definition changed since the owner accepted it. */
  changedTools: NonNegativeInt,
  readTools: NonNegativeInt,
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
  listedAt: Schema.NullOr(NonNegativeInt),
  lastOkAt: Schema.NullOr(NonNegativeInt),
  lastError: Schema.NullOr(Schema.String),
});
export type KinConnection = typeof KinConnection.Type;

/** The pinned parts of a tool's definition, as the server listed them. */
export const KinConnectionToolDefinition = Schema.Struct({
  name: Schema.String,
  title: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  inputSchema: Schema.Unknown,
  annotations: Schema.NullOr(Schema.Unknown),
});
export type KinConnectionToolDefinition = typeof KinConnectionToolDefinition.Type;

export const KinConnectionTool = Schema.Struct({
  connectionId: KinConnectionId,
  name: Schema.String,
  definition: KinConnectionToolDefinition,
  /** What the owner last accepted; differs from `definition` when `changed`. Null for a new tool. */
  accepted: Schema.NullOr(KinConnectionToolDefinition),
  /** What accepting it binds to: a later change needs a new look. */
  pinDigest: Schema.String,
  mode: KinConnectionToolMode,
  suggestedMode: KinConnectionToolMode,
  openWorld: Schema.Boolean,
  changed: Schema.Boolean,
  firstSeenAt: NonNegativeInt,
  changedAt: Schema.NullOr(NonNegativeInt),
  acceptedAt: Schema.NullOr(NonNegativeInt),
  removedAt: Schema.NullOr(NonNegativeInt),
});
export type KinConnectionTool = typeof KinConnectionTool.Type;

export const KinConnectionCallStatus = Schema.Literals([
  "ok",
  "error",
  "refused",
  "awaiting_approval",
  "offered",
]);
export type KinConnectionCallStatus = typeof KinConnectionCallStatus.Type;

/** One thing an agent asked of a connection. Holds no result. */
export const KinConnectionCall = Schema.Struct({
  callId: Schema.String,
  connectionId: Schema.NullOr(KinConnectionId),
  /** The tool, or for an offer the service the agent asked to connect. */
  toolName: Schema.String,
  agentId: Schema.String,
  wakeupId: Schema.String,
  mode: Schema.NullOr(KinConnectionToolMode),
  /** The arguments as sent, cut at 8 KB. */
  args: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  status: KinConnectionCallStatus,
  refusedReason: Schema.NullOr(Schema.String),
  resultChars: Schema.NullOr(NonNegativeInt),
  resultBytes: Schema.NullOr(NonNegativeInt),
  durationMs: Schema.NullOr(NonNegativeInt),
  createdAt: NonNegativeInt,
});
export type KinConnectionCall = typeof KinConnectionCall.Type;

export const KinConnectionsInput = Schema.Struct({ orgId: KinOrgId });
export type KinConnectionsInput = typeof KinConnectionsInput.Type;
export const KinConnectionsView = Schema.Struct({
  orgId: KinOrgId,
  connections: Schema.Array(KinConnection),
  services: Schema.Array(KinConnectionService),
});
export type KinConnectionsView = typeof KinConnectionsView.Type;

export const KinConnectionRef = Schema.Struct({ orgId: KinOrgId, connectionId: KinConnectionId });
export type KinConnectionRef = typeof KinConnectionRef.Type;
export const KinConnectionDetail = Schema.Struct({
  connection: KinConnection,
  tools: Schema.Array(KinConnectionTool),
  /**
   * `setToolModes` changed nothing: these tools' marks named no digest, or not the current
   * `pinDigest`. `tools` holds their current definitions to show before marking again.
   */
  refused: Schema.optional(Schema.Array(Schema.String)),
});
export type KinConnectionDetail = typeof KinConnectionDetail.Type;

/** A key or token, redacted from the moment it is decoded; never sent back. */
export const KinConnectionKey = Schema.RedactedFromValue(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
);
const HeaderName = Schema.String.check(Schema.isPattern(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/));

export const KinConnectionAddInput = Schema.Struct({
  orgId: KinOrgId,
  service: Schema.Union([KinConnectionPreset, Schema.Literal("custom")]),
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  /** Custom only: the server's https URL. */
  url: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  /** Custom only: `none`, or `key` sent in `header` (default `Authorization: Bearer`). */
  auth: Schema.optional(Schema.Literals(["none", "key"])),
  header: Schema.optional(HeaderName),
  key: Schema.optional(KinConnectionKey),
});
export type KinConnectionAddInput = typeof KinConnectionAddInput.Type;

export const KinConnectionSetKeyInput = Schema.Struct({
  orgId: KinOrgId,
  connectionId: KinConnectionId,
  key: KinConnectionKey,
});
export type KinConnectionSetKeyInput = typeof KinConnectionSetKeyInput.Type;

export const KinConnectionSetToolModesInput = Schema.Struct({
  orgId: KinOrgId,
  connectionId: KinConnectionId,
  /**
   * `digest`: the `pinDigest` shown. Any mark but `off` needs it, and the current one; a tool
   * never accepted is accepted as shown. Otherwise nothing changes (`refused`).
   */
  modes: Schema.Array(
    Schema.Struct({
      tool: Schema.String,
      mode: KinConnectionToolMode,
      digest: Schema.optional(Schema.String),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type KinConnectionSetToolModesInput = typeof KinConnectionSetToolModesInput.Type;

export const KinConnectionAcceptInput = Schema.Struct({
  orgId: KinOrgId,
  connectionId: KinConnectionId,
  /** Each changed tool to accept, with the `pinDigest` the owner was shown. */
  tools: Schema.Array(Schema.Struct({ tool: Schema.String, digest: Schema.String })).check(
    Schema.isMaxLength(500),
  ),
  /** The changed instructions' `instructionsDigest` as shown, to accept them too. */
  instructionsDigest: Schema.optional(Schema.String),
});
export type KinConnectionAcceptInput = typeof KinConnectionAcceptInput.Type;

export const KinConnectionSetReachInput = Schema.Struct({
  orgId: KinOrgId,
  connectionId: KinConnectionId,
  reach: KinConnectionReach,
});
export type KinConnectionSetReachInput = typeof KinConnectionSetReachInput.Type;

export const KinConnectionCallsInput = Schema.Struct({
  orgId: KinOrgId,
  connectionId: Schema.optional(KinConnectionId),
  /** The `next` of the page before. */
  before: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type KinConnectionCallsInput = typeof KinConnectionCallsInput.Type;
export const KinConnectionCalls = Schema.Struct({
  calls: Schema.Array(KinConnectionCall),
  next: Schema.NullOr(Schema.String),
});
export type KinConnectionCalls = typeof KinConnectionCalls.Type;

const KinError = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
export const KinConnectionRpcs = [
  Rpc.make("kin.connections.list", {
    payload: KinConnectionsInput,
    success: KinConnectionsView,
    error: KinError,
  }),
  Rpc.make("kin.connections.get", {
    payload: KinConnectionRef,
    success: KinConnectionDetail,
    error: KinError,
  }),
  Rpc.make("kin.connections.add", {
    payload: KinConnectionAddInput,
    success: KinConnectionDetail,
    error: KinError,
  }),
  Rpc.make("kin.connections.setKey", {
    payload: KinConnectionSetKeyInput,
    success: KinConnectionDetail,
    error: KinError,
  }),
  Rpc.make("kin.connections.refreshTools", {
    payload: KinConnectionRef,
    success: KinConnectionDetail,
    error: KinError,
  }),
  Rpc.make("kin.connections.setToolModes", {
    payload: KinConnectionSetToolModesInput,
    success: KinConnectionDetail,
    error: KinError,
  }),
  Rpc.make("kin.connections.acceptToolChanges", {
    payload: KinConnectionAcceptInput,
    success: KinConnectionDetail,
    error: KinError,
  }),
  Rpc.make("kin.connections.setReach", {
    payload: KinConnectionSetReachInput,
    success: KinConnectionDetail,
    error: KinError,
  }),
  Rpc.make("kin.connections.remove", {
    payload: KinConnectionRef,
    success: KinConnectionsView,
    error: KinError,
  }),
  Rpc.make("kin.connections.calls", {
    payload: KinConnectionCallsInput,
    success: KinConnectionCalls,
    error: KinError,
  }),
] as const;

// Owner-level settings (`KIN_RPC_ACCESS`): what outside services agents reach, and with what key.
export const KIN_CONNECTION_RPC_SCOPES = {
  "kin.connections.list": AuthKinChatScope,
  "kin.connections.get": AuthKinChatScope,
  "kin.connections.add": AuthKinChatScope,
  "kin.connections.setKey": AuthKinChatScope,
  "kin.connections.refreshTools": AuthKinChatScope,
  "kin.connections.setToolModes": AuthKinChatScope,
  "kin.connections.acceptToolChanges": AuthKinChatScope,
  "kin.connections.setReach": AuthKinChatScope,
  "kin.connections.remove": AuthKinChatScope,
  "kin.connections.calls": AuthKinChatScope,
} as const;

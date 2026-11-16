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
const KIN_CONNECTION_PRESETS = [
  "github",
  "posthog",
  "sentry",
  "google",
  "zoho_books",
  "microsoft",
] as const;
export const KinConnectionPreset = Schema.Literals(KIN_CONNECTION_PRESETS);
export type KinConnectionPreset = typeof KinConnectionPreset.Type;

export const KinConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("KinConnectionId"),
);
export type KinConnectionId = typeof KinConnectionId.Type;

/**
 * `off`: never called. `read`: agents call it in owner-only turns. `ask`: a call runs only when
 * the owner taps Confirm on a card showing exactly what it sends.
 */
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

/**
 * What the Add sheet asks for. `org`: an optional organization to narrow to (Sentry).
 * `secretUrl`: a server address that is itself a password (Zoho), kept with the credentials.
 */
export const KinConnectionField = Schema.Literals(["url", "key", "org", "secretUrl"]);
export type KinConnectionField = typeof KinConnectionField.Type;

/** A service the owner can add, or one that can't be added yet (`available: false`). */
export const KinConnectionService = Schema.Struct({
  service: Schema.Union([KinConnectionPreset, Schema.Literal("custom")]),
  label: Schema.String,
  available: Schema.Boolean,
  /** One line on where to make the key, for key presets, or what signing in involves. */
  setup: Schema.NullOr(Schema.String),
  /** `key`: the owner pastes a key. `sign_in`: the owner signs in at the service. */
  connect: Schema.Literals(["key", "sign_in"]),
  fields: Schema.Array(KinConnectionField),
  /** Signing in needs the owner's own sign-in client first (Google), and none is saved yet. */
  needsSetup: Schema.Boolean,
});
export type KinConnectionService = typeof KinConnectionService.Type;

/** One address a mail account sends as: its own, or a Gmail "Send mail as" alias. */
export const KinMailAddress = Schema.Struct({
  address: Schema.String,
  name: Schema.NullOr(Schema.String),
  isDefault: Schema.Boolean,
});
export type KinMailAddress = typeof KinMailAddress.Type;

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
  /** The owner paused it: agents can't reach it, and nothing else about it changes. */
  paused: Schema.Boolean,
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
  /** Signed in before Kin asked to send: sending needs one more sign-in. */
  needsSignInToSend: Schema.optional(Schema.Boolean),
  /** The owner's one line on what this account is for, which agents see. */
  note: Schema.optional(Schema.NullOr(Schema.String)),
  /** A mail account's From addresses: its own and its aliases. */
  sendAs: Schema.optional(Schema.Array(KinMailAddress)),
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
  /** It sends something out of the company: only `off` or `ask`, never run without asking. */
  alwaysAsk: Schema.optional(Schema.Boolean),
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
  /** The agent's name as the org knows it; null for an agent no longer on record. */
  agentName: Schema.NullOr(Schema.String),
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
  /** Where a service sends the browser back after sign-in; pasted into Google's client setup. */
  signInAddress: Schema.String,
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

/** Renames, notes or pauses a connection; a field left out stays as it is, `note: null` clears. */
export const KinConnectionUpdateInput = Schema.Struct({
  orgId: KinOrgId,
  connectionId: KinConnectionId,
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  note: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
  paused: Schema.optional(Schema.Boolean),
});
export type KinConnectionUpdateInput = typeof KinConnectionUpdateInput.Type;

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

/** Where the sign-in page hands the result back: the browser that opened it, or the app. */
export const KinConnectionSignInReturn = Schema.Literals(["web", "app", "app-dev", "app-preview"]);
export type KinConnectionSignInReturn = typeof KinConnectionSignInReturn.Type;

/** Starts a sign-in: for a new connection (`service`), or again for one (`connectionId`). */
export const KinConnectionSignInStartInput = Schema.Struct({
  orgId: KinOrgId,
  service: Schema.optional(KinConnectionPreset),
  connectionId: Schema.optional(KinConnectionId),
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  org: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isPattern(/^[\w.-]{1,100}(\/[\w.-]{1,100})?$/)),
  ),
  secretUrl: Schema.optional(KinConnectionKey),
  /** Google: this account's own client, for a Workspace whose client is Internal to it. */
  client: Schema.optional(
    Schema.Struct({
      clientId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
      clientSecret: Schema.optional(KinConnectionKey),
    }),
  ),
  returnTo: KinConnectionSignInReturn,
});
export type KinConnectionSignInStartInput = typeof KinConnectionSignInStartInput.Type;
export const KinConnectionSignInStart = Schema.Struct({
  signInId: Schema.String,
  /** The service's sign-in page, opened in the device's browser. */
  authorizationUrl: Schema.String,
  /** The host that page is on, shown before opening it. */
  host: Schema.String,
  expiresAt: NonNegativeInt,
});
export type KinConnectionSignInStart = typeof KinConnectionSignInStart.Type;

/** The address the service sent the browser back to, or just its query. */
export const KinConnectionSignInFinishInput = Schema.Struct({
  orgId: KinOrgId,
  response: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
});
export type KinConnectionSignInFinishInput = typeof KinConnectionSignInFinishInput.Type;

/** The owner's own sign-in client for a service (Google); `null` forgets it. */
export const KinConnectionSetSignInClientInput = Schema.Struct({
  orgId: KinOrgId,
  service: Schema.Literals(["google", "microsoft"]),
  client: Schema.NullOr(
    Schema.Struct({
      clientId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
      clientSecret: Schema.optional(KinConnectionKey),
    }),
  ),
});
export type KinConnectionSetSignInClientInput = typeof KinConnectionSetSignInClientInput.Type;

/** The owner picks another From on a send card before Confirm: one of `send.fromChoices`. */
export const KinConnectionSetSendFromInput = Schema.Struct({
  orgId: KinOrgId,
  widgetId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** The card revision the owner saw; a card that changed since is refused. */
  revision: NonNegativeInt,
  choice: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
});
export type KinConnectionSetSendFromInput = typeof KinConnectionSetSendFromInput.Type;
export const KinConnectionSetSendFrom = Schema.Struct({ revision: NonNegativeInt });
export type KinConnectionSetSendFrom = typeof KinConnectionSetSendFrom.Type;

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
  Rpc.make("kin.connections.update", {
    payload: KinConnectionUpdateInput,
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
  Rpc.make("kin.connections.signInStart", {
    payload: KinConnectionSignInStartInput,
    success: KinConnectionSignInStart,
    error: KinError,
  }),
  Rpc.make("kin.connections.signInFinish", {
    payload: KinConnectionSignInFinishInput,
    success: KinConnectionDetail,
    error: KinError,
  }),
  Rpc.make("kin.connections.setSignInClient", {
    payload: KinConnectionSetSignInClientInput,
    success: KinConnectionsView,
    error: KinError,
  }),
  Rpc.make("kin.connections.setSendFrom", {
    payload: KinConnectionSetSendFromInput,
    success: KinConnectionSetSendFrom,
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
  "kin.connections.update": AuthKinChatScope,
  "kin.connections.setReach": AuthKinChatScope,
  "kin.connections.remove": AuthKinChatScope,
  "kin.connections.calls": AuthKinChatScope,
  "kin.connections.signInStart": AuthKinChatScope,
  "kin.connections.signInFinish": AuthKinChatScope,
  "kin.connections.setSignInClient": AuthKinChatScope,
  "kin.connections.setSendFrom": AuthKinChatScope,
} as const;

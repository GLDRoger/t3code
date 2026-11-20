import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChatError, KinOrgId, KinSendTry } from "./kinChat.ts";

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
/** Why a bank alert from a counted sender wasn't counted. */
export const KinBankAlertNotCounted = Schema.Literals([
  "unreadable",
  "other_account",
  "other_currency",
  "future",
  "covered",
  "repeat",
  "failed_check",
  "not_checked",
]);
export type KinBankAlertNotCounted = typeof KinBankAlertNotCounted.Type;
/**
 * A mailbox's bank alerts, for the owner level: the senders someone said Yes to on Kin's card,
 * and the newest of their mail Kin kept without counting. Absent where no sender was confirmed.
 */
export const KinConnectionBankAlerts = Schema.Struct({
  senders: Schema.Array(
    Schema.Struct({
      address: Schema.String.check(Schema.isMaxLength(320)),
      account: Schema.String.check(Schema.isMaxLength(8)),
      counting: Schema.Boolean,
      counted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ).check(Schema.isMaxLength(50)),
  notCounted: Schema.Array(
    Schema.Struct({
      address: Schema.String.check(Schema.isMaxLength(320)),
      at: IsoDateTime,
      subject: Schema.String.check(Schema.isMaxLength(300)),
      reason: KinBankAlertNotCounted,
    }),
  ).check(Schema.isMaxLength(20)),
});
export type KinConnectionBankAlerts = typeof KinConnectionBankAlerts.Type;

export const KinConnectionDetail = Schema.Struct({
  connection: KinConnection,
  tools: Schema.Array(KinConnectionTool),
  /** Absent from older hosts, on other services, and until a sender is confirmed. */
  bankAlerts: Schema.optional(KinConnectionBankAlerts),
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

/** Stop counting a confirmed bank alert sender on this mailbox, or count it again. */
export const KinConnectionSetBankAlertsInput = Schema.Struct({
  orgId: KinOrgId,
  connectionId: KinConnectionId,
  address: Schema.String.check(Schema.isMaxLength(320)),
  account: Schema.String.check(Schema.isPattern(/^\d{4}$/)),
  counting: Schema.Boolean,
});
export type KinConnectionSetBankAlertsInput = typeof KinConnectionSetBankAlertsInput.Type;

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
export const KinConnectionSignInReturn = Schema.Literals([
  "web",
  "app",
  "app-dev",
  "app-preview",
  "t3-app",
  "t3-app-dev",
  "t3-app-preview",
]);
export type KinConnectionSignInReturn = typeof KinConnectionSignInReturn.Type;

/**
 * Every phone app scheme, of the Kin build and of the unbranded app, and the return value that
 * sends a sign-in back to it. The return page redirects only to these. Builds before the
 * unbranded values existed send `app` whatever their scheme, so `app` stays Kin's.
 */
export const KIN_SIGN_IN_RETURN_BY_SCHEME = {
  kin: "app",
  "kin-dev": "app-dev",
  "kin-preview": "app-preview",
  t3code: "t3-app",
  "t3code-dev": "t3-app-dev",
  "t3code-preview": "t3-app-preview",
} as const satisfies Record<string, Exclude<KinConnectionSignInReturn, "web">>;

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
  /** This account's own client, where its service's `accountClient` allows one. */
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

/**
 * The services signed in to through a client the owner made there, and the one rule for what he
 * pastes, read by the host and both apps. `accountClient`: one account may sign in with a client of
 * its own, for a Workspace that keeps its client to itself. Microsoft can't: Kin signs in at its
 * `common` endpoint, which an app kept to one organization is refused (AADSTS50194).
 */
const KIN_OWNER_CLIENT_SERVICES = ["google", "microsoft"] as const;
export type KinOwnerClientService = (typeof KIN_OWNER_CLIENT_SERVICES)[number];
export const KIN_SIGN_IN_CLIENTS: Readonly<
  Record<
    KinOwnerClientService,
    {
      readonly clientId: RegExp;
      readonly notClientId: string;
      readonly secret: "required" | "optional";
      readonly accountClient: boolean;
    }
  >
> = {
  google: {
    clientId: /^[\w.-]+\.apps\.googleusercontent\.com$/,
    notClientId: "The client ID ends in .apps.googleusercontent.com.",
    secret: "required",
    accountClient: true,
  },
  microsoft: {
    clientId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    notClientId: "The application ID looks like 00000000-0000-0000-0000-000000000000.",
    secret: "optional",
    accountClient: false,
  },
};
export const kinIsOwnerClientService = (service: string): service is KinOwnerClientService =>
  (KIN_OWNER_CLIENT_SERVICES as ReadonlyArray<string>).includes(service);

/** The owner's own sign-in client for a service; `null` forgets it. */
export const KinConnectionSetSignInClientInput = Schema.Struct({
  orgId: KinOrgId,
  service: Schema.Literals(KIN_OWNER_CLIENT_SERVICES),
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

/**
 * A person's own words on an unanswered mail card, sent in the same step: the card is replaced by
 * one with exactly this mail, confirmed as an ordinary Confirm is. Attachments stay as drawn.
 */
export const KinConnectionSendEditedInput = Schema.Struct({
  orgId: KinOrgId,
  widgetId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** The card revision the person edited; a card that changed since is refused. */
  revision: NonNegativeInt,
  /** One per press: a retry of the same press answers as the first did. */
  clientActionId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  to: Schema.Array(Schema.String.check(Schema.isMaxLength(320))).check(Schema.isMaxLength(50)),
  cc: Schema.Array(Schema.String.check(Schema.isMaxLength(320))).check(Schema.isMaxLength(50)),
  subject: Schema.String.check(Schema.isMaxLength(400)),
  body: Schema.String.check(Schema.isMaxLength(24_000)),
  /** The try the person checked the sent mail for: the card's or the refusal's `mayHaveGone`. */
  checkedSent: Schema.optional(KinSendTry),
});
export type KinConnectionSendEditedInput = typeof KinConnectionSendEditedInput.Type;
/** The card that now carries the mail and its outcome. */
export const KinConnectionSendEdited = Schema.Struct({
  widgetId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type KinConnectionSendEdited = typeof KinConnectionSendEdited.Type;

/**
 * A person's own words kept on an unanswered mail card without sending: the card shows them and
 * its Confirm sends them. `edit: null` puts the agent's draft back.
 */
export const KinConnectionSaveEditedInput = Schema.Struct({
  orgId: KinOrgId,
  widgetId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** The card revision the person edited; a card that changed since is refused. */
  revision: NonNegativeInt,
  edit: Schema.NullOr(
    Schema.Struct({
      to: Schema.Array(Schema.String.check(Schema.isMaxLength(320))).check(Schema.isMaxLength(50)),
      cc: Schema.Array(Schema.String.check(Schema.isMaxLength(320))).check(Schema.isMaxLength(50)),
      subject: Schema.String.check(Schema.isMaxLength(400)),
      body: Schema.String.check(Schema.isMaxLength(24_000)),
    }),
  ),
});
export type KinConnectionSaveEditedInput = typeof KinConnectionSaveEditedInput.Type;
export const KinConnectionSaveEdited = Schema.Struct({ revision: NonNegativeInt });
export type KinConnectionSaveEdited = typeof KinConnectionSaveEdited.Type;

/**
 * GitHub as the owner's own login on the host: `gh` and git act as him, and T3 uses the same
 * token. One account at a time; another account means Disconnect, then Connect.
 */
export const KinGitHubAccount = Schema.Struct({
  login: Schema.String,
  /** Organizations this login can reach, as GitHub lists them to the GitHub CLI. */
  orgs: Schema.Array(Schema.String),
  scopes: Schema.Array(Schema.String),
  /** Why this login doesn't work now, in plain words; null when it does. */
  problem: Schema.NullOr(Schema.String),
});
export type KinGitHubAccount = typeof KinGitHubAccount.Type;

/** A sign-in waiting for the owner: the code to enter at `url`, until `expiresAt`. */
export const KinGitHubSignIn = Schema.Struct({
  code: Schema.String,
  url: Schema.String,
  expiresAt: NonNegativeInt,
});
export type KinGitHubSignIn = typeof KinGitHubSignIn.Type;

/** What Kin watches on GitHub with the owner's login, and how the last look went. */
export const KinGitHubWatch = Schema.Struct({
  repos: NonNegativeInt,
  /** When Kin last asked GitHub what changed; null before the first time. */
  checkedAt: Schema.NullOr(NonNegativeInt),
  /** Pieces of work GitHub started for an agent since midnight on the owner's clock. */
  handledToday: NonNegativeInt,
  /** Why the last look failed and how to fix it, in plain words; null when it worked. */
  problem: Schema.NullOr(Schema.String),
  /** Watched repos whose default branch Kin's App could change; an older server sends none. */
  open: Schema.optional(NonNegativeInt),
});
export type KinGitHubWatch = typeof KinGitHubWatch.Type;

/** Why Kin can't tell, or can't change, a repo's protection. */
export const KinGitHubGuardProblem = Schema.Literals([
  "no_admin",
  "plan",
  "no_access",
  "no_branch",
  "unreachable",
  "not_kin",
  "refused",
]);
export type KinGitHubGuardProblem = typeof KinGitHubGuardProblem.Type;

/**
 * Whether Kin's GitHub App can change a watched repo's default branch, as the last repo refresh
 * read it with the owner's login. `byKin`: the protection is the ruleset Kin made, the only one it
 * removes.
 */
export const KinGitHubBranchGuard = Schema.Struct({
  state: Schema.Literals(["protected", "open", "unknown"]),
  branch: Schema.String,
  byKin: Schema.Boolean,
  /** Why it is unknown. */
  problem: Schema.optional(KinGitHubGuardProblem),
  /**
   * With `open`: GitHub wants an approving review first, which doesn't stop Kin's App merging once
   * someone approves. A flag rather than a state, so a phone older than the server still reads it.
   */
  needsReview: Schema.optional(Schema.Boolean),
});
export type KinGitHubBranchGuard = typeof KinGitHubBranchGuard.Type;

/** One command an agent ran as the owner's own login with `kin-as-owner`, secrets taken out. */
export const KinGitHubOwnerUse = Schema.Struct({
  at: NonNegativeInt,
  agent: Schema.NullOr(Schema.String),
  repo: Schema.NullOr(Schema.String),
  command: Schema.String,
});
export type KinGitHubOwnerUse = typeof KinGitHubOwnerUse.Type;

/** One GitHub account with watched repos, and where Kin's App stands on it. */
export const KinGitHubAppAccount = Schema.Struct({
  account: TrimmedNonEmptyString,
  organisation: Schema.Boolean,
  watched: NonNegativeInt,
  /** Watched repos of this account the App reaches. */
  covered: NonNegativeInt,
  installation: Schema.Literals(["all", "selected", "none", "suspended"]),
  /** The installation's page on GitHub, where its repos are picked or it is unsuspended. */
  settingsUrl: Schema.NullOr(Schema.String),
  /** GitHub's install page for this account, when there is no installation. */
  installUrl: Schema.NullOr(Schema.String),
  /** Whether the connected login may change the App here: null when GitHub didn't say. */
  canManage: Schema.NullOr(Schema.Boolean),
  /** False when the App is private to another account, so GitHub can't install it here. */
  installable: Schema.Boolean,
  /** Repos of this account the App reaches that Kin doesn't watch, such as the memory repo. */
  elsewhere: Schema.optional(NonNegativeInt),
});
export type KinGitHubAppAccount = typeof KinGitHubAppAccount.Type;

/** Who agents act as on GitHub: Kin's GitHub App where it is installed, else the owner. */
export const KinGitHubAgents = Schema.Struct({
  as: Schema.Literals(["app", "owner"]),
  /** The App's name and bot login on GitHub, and where to install it on more repos, while it works. */
  appName: Schema.optional(Schema.String),
  botLogin: Schema.optional(Schema.String),
  installUrl: Schema.optional(Schema.String),
  /** Why an App set up on this computer isn't working, in plain words. */
  problem: Schema.NullOr(Schema.String),
  /** Watched repos, and how many of them the App is installed on. */
  watched: NonNegativeInt,
  installed: NonNegativeInt,
  /** Repos the App reaches that Kin doesn't watch, such as the memory repo. */
  elsewhere: Schema.optional(NonNegativeInt),
  /** Watched repos without the App, where work goes out as the owner; at most 20. */
  without: Schema.Array(Schema.String),
  /** The latest commands agents ran as the owner, newest first; at most 5. */
  ownerUses: Schema.Array(KinGitHubOwnerUse),
  /** No App is named anywhere, so the owner may make one from Settings. */
  canCreate: Schema.optional(Schema.Boolean),
  /**
   * The App Settings holds: who made it there and when, both null for one adopted from the host's
   * environment. `host` comes only from servers older than that adoption.
   */
  setUp: Schema.optional(
    Schema.Struct({
      source: Schema.Literals(["kin", "host"]),
      name: Schema.NullOr(Schema.String),
      at: Schema.NullOr(NonNegativeInt),
      by: Schema.NullOr(Schema.String),
      /** The App's own settings on GitHub, where it can be deleted. */
      settingsUrl: Schema.NullOr(Schema.String),
    }),
  ),
  /** One row per account with watched repos; absent when Kin can't tell the accounts. */
  accounts: Schema.optional(Schema.Array(KinGitHubAppAccount)),
  /** The account that owns the App, and its settings page when the login can open it. */
  appOwner: Schema.optional(Schema.String),
  appSettingsUrl: Schema.optional(Schema.String),
});
export type KinGitHubAgents = typeof KinGitHubAgents.Type;

export const KinGitHubStatus = Schema.Struct({
  orgId: KinOrgId,
  account: Schema.NullOr(KinGitHubAccount),
  signIn: Schema.NullOr(KinGitHubSignIn),
  /** Why the last sign-in didn't finish, until the next one starts. */
  failed: Schema.NullOr(Schema.String),
  /** Present while connected; an older server sends none. */
  watch: Schema.optional(KinGitHubWatch),
  /** Present on a server with Kin's GitHub App support; an older one sends none. */
  agents: Schema.optional(KinGitHubAgents),
});
export type KinGitHubStatus = typeof KinGitHubStatus.Type;

export const KinGitHubInput = Schema.Struct({ orgId: KinOrgId });
export type KinGitHubInput = typeof KinGitHubInput.Type;

/** A repo Kin may watch: the owner's or his organisations', where his login can push. */
export const KinGitHubRepo = Schema.Struct({
  repo: TrimmedNonEmptyString,
  /** Off when the owner said to leave it alone; forks of other people's repos start off. */
  watched: Schema.Boolean,
  fork: Schema.Boolean,
  /** An @-mention of the owner's own login here calls an agent too. */
  mentions: Schema.Boolean,
  /** Who agents work as here: Kin's GitHub App where it reaches the repo, else the owner. */
  agentsAs: Schema.optional(Schema.Literals(["app", "owner"])),
  /** Watched repos once Kin has read them; an older server sends none. */
  guard: Schema.optional(KinGitHubBranchGuard),
});
export type KinGitHubRepo = typeof KinGitHubRepo.Type;

export const KinGitHubRepos = Schema.Struct({
  repos: Schema.Array(KinGitHubRepo),
  /** For an agent's own look: where Kin's GitHub App stands on each account, and its GitHub page. */
  appAccounts: Schema.optional(Schema.Array(KinGitHubAppAccount)),
});
export type KinGitHubRepos = typeof KinGitHubRepos.Type;

/** Puts Kin's GitHub App on these repos of one account, or takes it off, with the owner's login. */
export const KinGitHubAppReposSetInput = Schema.Struct({
  orgId: KinOrgId,
  account: TrimmedNonEmptyString,
  repos: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100)),
  on: Schema.Boolean,
});
export type KinGitHubAppReposSetInput = typeof KinGitHubAppReposSetInput.Type;

export const KinGitHubAppReposResult = Schema.Struct({
  changed: NonNegativeInt,
  /** Why GitHub refused the rest, in plain words; null when every repo changed. */
  problem: Schema.NullOr(Schema.String),
});
export type KinGitHubAppReposResult = typeof KinGitHubAppReposResult.Type;

export const KinGitHubAppCreateStart = Schema.Struct({
  /** The page on Kin's server that posts the manifest to GitHub, with its one-hour state. */
  path: Schema.String,
  /** The name it suggests; GitHub App names are global, so the owner may change it. */
  name: Schema.String,
});
export type KinGitHubAppCreateStart = typeof KinGitHubAppCreateStart.Type;

export const KinGitHubAppDisconnected = Schema.Struct({
  /** Where the App can still be deleted on GitHub. */
  settingsUrl: Schema.NullOr(Schema.String),
});
export type KinGitHubAppDisconnected = typeof KinGitHubAppDisconnected.Type;

/** Protects these repos' default branch from Kin's App with a ruleset, or removes Kin's own. */
export const KinGitHubGuardSetInput = Schema.Struct({
  orgId: KinOrgId,
  repos: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100)),
  on: Schema.Boolean,
});
export type KinGitHubGuardSetInput = typeof KinGitHubGuardSetInput.Type;

export const KinGitHubGuardSetResult = Schema.Struct({
  changed: NonNegativeInt,
  /** Each repo GitHub or Kin refused, why, and GitHub's own words when it gave some. */
  failed: Schema.Array(
    Schema.Struct({
      repo: Schema.String,
      problem: KinGitHubGuardProblem,
      said: Schema.NullOr(Schema.String),
    }),
  ),
});
export type KinGitHubGuardSetResult = typeof KinGitHubGuardSetResult.Type;

/** One repo's switch; `repo` null sets every repo back to the default (watch everything). */
export const KinGitHubRepoSetInput = Schema.Struct({
  orgId: KinOrgId,
  repo: Schema.NullOr(TrimmedNonEmptyString),
  watched: Schema.optional(Schema.Boolean),
  mentions: Schema.optional(Schema.Boolean),
});
export type KinGitHubRepoSetInput = typeof KinGitHubRepoSetInput.Type;

/** Starts a sign-in with a code, or, given `token`, signs in with a token the owner made. */
export const KinGitHubConnectInput = Schema.Struct({
  orgId: KinOrgId,
  token: Schema.optional(KinConnectionKey),
});
export type KinGitHubConnectInput = typeof KinGitHubConnectInput.Type;

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
  Rpc.make("kin.connections.setBankAlerts", {
    payload: KinConnectionSetBankAlertsInput,
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
  Rpc.make("kin.connections.sendEdited", {
    payload: KinConnectionSendEditedInput,
    success: KinConnectionSendEdited,
    error: KinError,
  }),
  Rpc.make("kin.connections.saveEdited", {
    payload: KinConnectionSaveEditedInput,
    success: KinConnectionSaveEdited,
    error: KinError,
  }),
  Rpc.make("kin.github.connect.status", {
    payload: KinGitHubInput,
    success: KinGitHubStatus,
    error: KinError,
  }),
  Rpc.make("kin.github.connect.start", {
    payload: KinGitHubConnectInput,
    success: KinGitHubStatus,
    error: KinError,
  }),
  Rpc.make("kin.github.connect.cancel", {
    payload: KinGitHubInput,
    success: KinGitHubStatus,
    error: KinError,
  }),
  Rpc.make("kin.github.disconnect", {
    payload: KinGitHubInput,
    success: KinGitHubStatus,
    error: KinError,
  }),
  Rpc.make("kin.github.repos", {
    payload: KinGitHubInput,
    success: KinGitHubRepos,
    error: KinError,
  }),
  Rpc.make("kin.github.repos.set", {
    payload: KinGitHubRepoSetInput,
    success: KinGitHubRepos,
    error: KinError,
  }),
  Rpc.make("kin.github.app.create", {
    payload: KinGitHubInput,
    success: KinGitHubAppCreateStart,
    error: KinError,
  }),
  Rpc.make("kin.github.app.disconnect", {
    payload: KinGitHubInput,
    success: KinGitHubAppDisconnected,
    error: KinError,
  }),
  Rpc.make("kin.github.app.repos.set", {
    payload: KinGitHubAppReposSetInput,
    success: KinGitHubAppReposResult,
    error: KinError,
  }),
  Rpc.make("kin.github.guard.set", {
    payload: KinGitHubGuardSetInput,
    success: KinGitHubGuardSetResult,
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
  "kin.connections.setBankAlerts": AuthKinChatScope,
  "kin.connections.remove": AuthKinChatScope,
  "kin.connections.calls": AuthKinChatScope,
  "kin.connections.signInStart": AuthKinChatScope,
  "kin.connections.signInFinish": AuthKinChatScope,
  "kin.connections.setSignInClient": AuthKinChatScope,
  "kin.connections.setSendFrom": AuthKinChatScope,
  "kin.connections.sendEdited": AuthKinChatScope,
  "kin.connections.saveEdited": AuthKinChatScope,
  "kin.github.connect.status": AuthKinChatScope,
  "kin.github.connect.start": AuthKinChatScope,
  "kin.github.connect.cancel": AuthKinChatScope,
  "kin.github.disconnect": AuthKinChatScope,
  "kin.github.repos": AuthKinChatScope,
  "kin.github.repos.set": AuthKinChatScope,
  "kin.github.app.repos.set": AuthKinChatScope,
  "kin.github.guard.set": AuthKinChatScope,
  "kin.github.app.create": AuthKinChatScope,
  "kin.github.app.disconnect": AuthKinChatScope,
} as const;

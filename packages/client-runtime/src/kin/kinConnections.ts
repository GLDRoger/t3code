import {
  KIN_SIGN_IN_CLIENTS,
  KinChatError,
  KinConnectionKey,
  kinIsOwnerClientService,
  type KinOwnerClientService,
  type KinConnection,
  type KinConnectionAcceptInput,
  type KinConnectionAddInput,
  type KinBankAlertNotCounted,
  type KinConnectionCall,
  type KinConnectionDetail,
  type KinConnectionId,
  type KinConnectionRef,
  type KinConnectionService,
  type KinConnectionSetSignInClientInput,
  type KinConnectionSetToolModesInput,
  type KinConnectionSignInFinishInput,
  type KinConnectionSignInReturn,
  type KinConnectionSignInStart,
  type KinConnectionSignInStartInput,
  type KinConnectionsView,
  type KinConnectionTool,
  type KinConnectionToolDefinition,
  type KinConnectionToolMode,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import { formatKinTime } from "./kinScreenState.ts";
import { KIN_SERVICE_SLOW, KIN_SERVICE_UNREACHED, kinFailureText } from "./kinAnswers.ts";

/**
 * The owner's Connections screens: plain-word states for connections and their tools, the Add
 * form's check, and the add and remove flows. Web and mobile only draw what this returns.
 */
export const KIN_CONNECTIONS_COPY = {
  describedChanged: "What the service says it does changed too.",
  inputsChanged: "What it takes changed too.",
  title: "Connections",
  rowDetail: "Outside services your agents can read from.",
  intro:
    "Services your agents can use, in chats only you can see. You choose each tool they may use, and nothing is sent without your Confirm.",
  add: "Add connection",
  emptyTitle: "Nothing connected yet",
  emptyDetail: "Connect a service and your agents can look things up in it for you.",
  loadFailed: "Couldn't load your connections",
  onlyOwner: "Only the owner manages connections.",
  addTitle: "Add a connection",
  serviceLabel: "Service",
  nameLabel: "Name",
  namePlaceholder: "Shown to you and your agents",
  urlLabel: "Server address",
  urlPlaceholder: "https://mcp.example.com/mcp",
  keyLabel: "Key",
  keyPlaceholder: "Paste the key",
  keyHint: "Sent to your Kin's computer and kept there. It is never shown again.",
  keyOptional: "Leave empty if the server needs no key.",
  connect: "Connect",
  connecting: "Connecting…",
  soon: "Can't be added yet",
  signIn: "Sign in",
  signInAgain: "Sign in again",
  signInTo: (label: string) => `Sign in to ${label}`,
  signInOpens: (host: string) => `Opens ${host} to sign in. Kin never sees your password.`,
  waiting: "Waiting for you to sign in…",
  waitingDetail: (host: string) =>
    `Finish signing in at ${host}. This page updates when you're back.`,
  pasteLabel: "Didn't come back?",
  pasteHint: "After signing in, copy the address of the page you land on and paste it here.",
  pastePlaceholder: "https://…?code=…",
  finish: "Finish",
  needsSetup: "Needs setup",
  orgLabel: "Organization",
  orgPlaceholder: "Optional, for example my-company",
  secretUrlLabel: "Server address",
  secretUrlPlaceholder: "https://…zohomcp.com/mcp/…",
  secretUrlHint:
    "This address works like a password. It goes to your Kin's computer and is never shown again.",
  redirectLabel: "Return address",
  copy: "Copy",
  copied: "Copied",
  saveClient: "Save and continue",
  ownClient: "This account signs in with its own client",
  ownClientDetail:
    "If this account's organization keeps its sign-in client to itself, paste that client here. Only this account uses it.",
  usualClient: "Use the usual client",
  accountTitle: "Account",
  noteLabel: "What it's for",
  notePlaceholder: "For example: client work, or personal, never send from here",
  noteHint: "Your agents read this when they choose which account to send from.",
  noteNone: "No note yet. Your agents pick by what you've told them.",
  noteAdd: "Add a note",
  noteEdit: "Edit note",
  noteTitle: "What is this account for?",
  sendsFrom: "Sends from",
  defaultAddress: "default",
  toolsTitle: "Tools",
  toolsDetail:
    "Off: agents can't use it. Read: agents use it when they need to, in chats only you can see. Ask me: nothing happens until you tap Confirm on a card showing exactly what it will do.",
  modeOff: "Off",
  modeRead: "Read",
  modeAsk: "Ask me",
  alwaysAsk: "Sends from your account: always asks you",
  sendSignInLabel: "Sign in to send",
  sendSignInDetail: "Sign in again to allow sending. Reading keeps working.",
  noTools: "This service lists no tools.",
  suggested: "Turn on suggested",
  suggestedDetail: "Tools the service says only read, and sending set to ask you first.",
  refresh: "Check for changes",
  refreshing: "Checking…",
  changedTitle: "Changed since you allowed it",
  changedDetail: "Agents can't use it until you look at the change.",
  accept: "Allow the new version",
  acceptAll: "Allow all changes",
  instructionsChanged: "The service changed its notes to agents.",
  callsTitle: "Recent use",
  noCalls: "No agent has used this yet.",
  openWeb: "Can reach the open web",
  reachTitle: "Reaches only this service",
  reachDetail:
    "Turn this off if the service can fetch pages or data from elsewhere. Agents then stop using it in a chat once they have read anything from outside.",
  pause: "Pause",
  resume: "Resume",
  pausedDetail: "Paused. Agents can't use it until you resume it.",
  rename: "Rename",
  renameTitle: "Rename connection",
  replaceKey: "Replace key",
  replaceKeyTitle: "Replace the key",
  replaceKeyDetail: "Kin checks the new key right away. The old one is forgotten.",
  save: "Save",
  remove: "Remove connection",
  removeTitle: (label: string) => `Remove ${label}?`,
  removeDetail:
    "Agents stop using it at once and its key is deleted from your Kin's computer. To use it again, add it again.",
  removeConfirm: "Remove",
} as const;

const isChatError = Schema.is(KinChatError);

/** A failure the host sent back, in the owner's words, with what to do about it. */
function kinConnectionErrorText(message: string): string {
  if (/refused the key/i.test(message))
    return "The service didn't accept the key. Make a new key there and use Replace key.";
  if (/key is missing/i.test(message)) return "The key is missing. Use Replace key to add it.";
  if (/couldn't reach/i.test(message)) return `${message} ${KIN_SERVICE_UNREACHED}`;
  if (/didn't answer in time/i.test(message)) return `${message} ${KIN_SERVICE_SLOW}`;
  if (/public internet addresses|only over https|name or password/i.test(message))
    return `${message} Use the service's public https address.`;
  if (/redirect/i.test(message)) return `${message} Use the address the redirect points to.`;
  if (/HTTP (404|405)/.test(message))
    return `${message} Check the server address the service gave you.`;
  return message;
}

/** Why an owner action on a connection failed, from the command's result. */
function kinConnectionProblem(error: unknown, doing: string): string {
  if (isChatError(error) && error.reason === "disabled") return "Kin is turned off on this server.";
  // The service's own failure, passed on by the host, says what to fix there.
  if (
    isChatError(error) &&
    error.message !== "" &&
    !["not_allowed", "not_found", "conflict"].includes(error.reason)
  )
    return kinConnectionErrorText(error.message);
  return kinFailureText(error, `Couldn't ${doing}.`, {
    gone: "That connection is no longer here.",
    device: `This device isn't allowed to ${doing}.`,
    ...(isChatError(error) && error.message === ""
      ? { refused: KIN_CONNECTIONS_COPY.onlyOwner }
      : {}),
  });
}

export type KinConnectionTone = "ok" | "attention" | "error" | "muted";

export interface KinConnectionStatus {
  readonly tone: KinConnectionTone;
  readonly label: string;
  readonly detail: string;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** A mailbox's bank alerts in Settings: owner level only, and off until a card's Yes. */
export const KIN_BANK_ALERTS = {
  title: "Bank alerts",
  off: "Off. When mail that looks like your bank's alert arrives here, Kin asks you in chat before it counts any.",
  sender: (address: string, account: string, currency?: string) =>
    `${address} · ${currency === undefined ? "" : `${currency} `}account ••${account}`,
  counting: (count: number) => `Counted · ${plural(count, "alert", "alerts")} so far`,
  stopped: "Stopped: Kin reads no more of this sender's mail, and keeps what it has out of Money.",
  declined: "You said No: Kin counts none of its mail.",
  stop: "Stop counting these",
  restart: "Count these again",
  askAgain: "Ask me again",
  notCountedTitle: "Not counted",
  notCounted: {
    unreadable: "Couldn't read this alert",
    not_moved: "It isn't money that moved",
    reply: "It's a reply or a forward",
    other_account: "It names another account",
    other_currency: "It's in another currency",
    not_in_text: "Its reading didn't match the mail",
    future: "Its day hasn't come yet",
    before_start: "It's from before Kin started counting",
    covered: "A confirmed statement already covers its day",
    repeat: "Kin already has this alert",
    failed_check: "It failed your mailbox's sender checks",
    not_checked: "Your mailbox didn't say the sender was checked",
    stopped: "Its sender was stopped",
  } satisfies Record<KinBankAlertNotCounted, string>,
  changeFailed: "Couldn't change bank alerts.",
};

export interface KinBankAlertsView {
  readonly senders: ReadonlyArray<{
    readonly id: string;
    readonly address: string;
    readonly account: string;
    readonly label: string;
    readonly detail: string;
    readonly counting: boolean;
    /** The tap that reverses its state, and what it sends. */
    readonly action: string;
    readonly input: {
      readonly address: string;
      readonly account: string;
      readonly currency?: string;
      readonly counting: boolean;
      readonly askAgain?: true;
    };
  }>;
  readonly notCounted: ReadonlyArray<{ readonly id: string; readonly text: string }>;
}

/**
 * What a mail connection's Bank alerts section shows: null for any other service, `off` until a
 * sender is confirmed on Kin's card.
 */
export function kinBankAlertsView(
  detail: Pick<KinConnectionDetail, "bankAlerts" | "connection">,
  now: Date,
): KinBankAlertsView | "off" | null {
  const preset = detail.connection.preset;
  if (preset === null || !kinIsOwnerClientService(preset)) return null;
  const alerts = detail.bankAlerts;
  if (alerts === undefined || alerts.senders.length === 0) return "off";
  return {
    senders: alerts.senders.map((one) => ({
      id: `${one.address}:${one.account}:${one.currency ?? ""}`,
      address: one.address,
      account: one.account,
      label: KIN_BANK_ALERTS.sender(one.address, one.account, one.currency),
      detail: one.counting
        ? KIN_BANK_ALERTS.counting(one.counted)
        : one.declined === true
          ? KIN_BANK_ALERTS.declined
          : KIN_BANK_ALERTS.stopped,
      counting: one.counting,
      action: one.counting
        ? KIN_BANK_ALERTS.stop
        : one.declined === true
          ? KIN_BANK_ALERTS.askAgain
          : KIN_BANK_ALERTS.restart,
      input: {
        address: one.address,
        account: one.account,
        ...(one.currency === undefined ? {} : { currency: one.currency }),
        counting: !one.counting && one.declined !== true,
        ...(one.declined === true ? { askAgain: true as const } : {}),
      },
    })),
    notCounted: alerts.notCounted.map((one, index) => ({
      id: `${one.at}:${index}`,
      // @effect-diagnostics-next-line globalDate:off - the shared clock-and-day label takes a Date.
      text: `${formatKinTime(new Date(one.at), now)} · ${one.subject === "" ? one.address : one.subject}: ${KIN_BANK_ALERTS.notCounted[one.reason]}`,
    })),
  };
}

/** The outside websites visuals may load from: rarely needed, so folded under Advanced. */
export const KIN_VISUAL_HOSTS = {
  advanced: "Advanced",
  title: "Websites charts can load from",
  count: (count: number) => (count === 0 ? "None" : String(count)),
  detail:
    "Charts and pictures your agents make can't reach the internet. Add a website only if one needs maps, images or data from it. That website can see what the chart shows.",
  none: "None added.",
  placeholder: "maps.example.com",
  inputLabel: "Website to add",
  add: "Add",
  remove: "Remove",
  addFailed: "Couldn't add that website.",
  removeFailed: "Couldn't remove that website.",
} as const;

const PROVIDER_NAMES: Record<NonNullable<KinConnection["preset"]>, string> = {
  github: "GitHub",
  posthog: "PostHog",
  sentry: "Sentry",
  google: "Google",
  zoho_books: "Zoho Books",
  microsoft: "Microsoft",
};

/** Who a connection is with, said beside its address: "Google", or the server's own host. */
export const kinConnectionProvider = (connection: Pick<KinConnection, "preset" | "urlHost">) =>
  connection.preset === null ? connection.urlHost : PROVIDER_NAMES[connection.preset];

/** One line on how a connection stands: paused, broken, waiting on the owner, or working. */
export function kinConnectionStatus(connection: KinConnection): KinConnectionStatus {
  if (connection.paused)
    return { tone: "muted", label: "Paused", detail: KIN_CONNECTIONS_COPY.pausedDetail };
  // Ahead of errors: an expired sign-in also fails every listing until the owner signs in.
  if (connection.state === "needs_sign_in")
    return { tone: "error", label: "Needs sign-in", detail: "Sign in again to keep using it." };
  if (connection.state === "error" || connection.lastError !== null)
    return {
      tone: "error",
      label: "Can't connect",
      detail: kinConnectionErrorText(connection.lastError ?? "Kin couldn't reach it."),
    };
  const changed = connection.changedTools;
  const instructions =
    connection.instructionsDigest !== null &&
    connection.instructions !== connection.acceptedInstructions;
  if (
    connection.needsSignInToSend === true &&
    !(connection.state === "needs_review" || changed > 0 || instructions)
  )
    return {
      tone: "attention",
      label: KIN_CONNECTIONS_COPY.sendSignInLabel,
      detail: KIN_CONNECTIONS_COPY.sendSignInDetail,
    };
  if (connection.state === "needs_review" || changed > 0 || instructions)
    return {
      tone: "attention",
      label: "Needs a look",
      detail:
        changed > 0
          ? `${plural(changed, "tool changed", "tools changed")} since you allowed ${changed === 1 ? "it" : "them"}.`
          : KIN_CONNECTIONS_COPY.instructionsChanged,
    };
  return {
    tone: connection.readTools === 0 ? "muted" : "ok",
    label: connection.readTools === 0 ? "No tools on" : "On",
    detail:
      connection.readTools === 0
        ? "Turn on the tools agents may use."
        : (connection.sendAs?.length ?? 0) > 0 && connection.needsSignInToSend !== true
          ? "Read, and send on your Confirm."
          : `Agents can use ${plural(connection.readTools, "tool", "tools")}.`,
  };
}

/** How a tool stands for the owner: off, on, new since the list was first read, or changed. */
export type KinToolState = "off" | "on" | "changed";

export interface KinToolChange {
  readonly before: string | null;
  readonly after: string | null;
  /** What it takes, or the labels the service gives it, changed too. */
  readonly inputsChanged: boolean;
  readonly labelsChanged: boolean;
}

export interface KinToolRow {
  readonly name: string;
  /** The service's title for it, else its name. */
  readonly title: string;
  readonly description: string | null;
  readonly state: KinToolState;
  readonly on: boolean;
  readonly mode: KinConnectionToolMode;
  /** The marks this tool can take: a tool that sends is never Read. */
  readonly modes: ReadonlyArray<KinConnectionToolMode>;
  readonly alwaysAsk: boolean;
  /** What one tap on "suggested" sets: Read for a tool that only reads, Ask me for sending. */
  readonly suggested: KinConnectionToolMode | null;
  readonly openWeb: boolean;
  readonly change: KinToolChange | null;
  readonly digest: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function toolChange(
  definition: KinConnectionToolDefinition,
  accepted: KinConnectionToolDefinition | null,
): KinToolChange {
  return {
    before: accepted?.description ?? null,
    after: definition.description,
    inputsChanged: !same(definition.inputSchema, accepted?.inputSchema),
    labelsChanged: !same(definition.annotations, accepted?.annotations),
  };
}

/** The tools still listed: changed ones first, then the ones on, each group by name. */
export function kinToolRows(tools: ReadonlyArray<KinConnectionTool>): ReadonlyArray<KinToolRow> {
  const rank = (row: KinToolRow) => (row.state === "changed" ? 0 : row.on ? 1 : 2);
  return [...tools]
    .filter((tool) => tool.removedAt === null)
    .map((tool): KinToolRow => {
      const on = tool.mode !== "off";
      return {
        name: tool.name,
        title: tool.definition.title ?? tool.name,
        description: tool.definition.description,
        state: tool.changed ? "changed" : on ? "on" : "off",
        on,
        mode: tool.mode,
        modes: tool.alwaysAsk === true ? ["off", "ask"] : ["off", "read", "ask"],
        alwaysAsk: tool.alwaysAsk === true,
        suggested:
          tool.suggestedMode === "read" || (tool.alwaysAsk === true && tool.suggestedMode === "ask")
            ? tool.suggestedMode
            : null,
        openWeb: tool.openWorld,
        change: tool.changed ? toolChange(tool.definition, tool.accepted) : null,
        digest: tool.pinDigest,
      };
    })
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

type Modes = KinConnectionSetToolModesInput["modes"];

/** Marking one tool: any mark but Off names the definition shown, so a later change waits. */
export const kinToolMark = (row: KinToolRow, mode: KinConnectionToolMode): Modes =>
  mode === "off" ? [{ tool: row.name, mode }] : [{ tool: row.name, mode, digest: row.digest }];

export const kinToolModeLabel = (mode: KinConnectionToolMode) =>
  mode === "off"
    ? KIN_CONNECTIONS_COPY.modeOff
    : mode === "read"
      ? KIN_CONNECTIONS_COPY.modeRead
      : KIN_CONNECTIONS_COPY.modeAsk;

/** The off tools with a suggested mark, unchanged since shown: one tap sets them. */
export const kinSuggestedModes = (rows: ReadonlyArray<KinToolRow>): Modes =>
  rows.flatMap((row) =>
    !row.on && row.suggested !== null && row.state !== "changed"
      ? [{ tool: row.name, mode: row.suggested, digest: row.digest }]
      : [],
  );

/** Accepting every change on screen, the server's notes included when they changed. */
export function kinAcceptAll(
  ref: KinConnectionRef,
  connection: KinConnection,
  rows: ReadonlyArray<KinToolRow>,
): KinConnectionAcceptInput {
  const instructions =
    connection.instructionsDigest !== null &&
    connection.instructions !== connection.acceptedInstructions;
  return {
    ...ref,
    tools: rows
      .filter((row) => row.state === "changed")
      .map((row) => ({ tool: row.name, digest: row.digest })),
    ...(instructions && connection.instructionsDigest !== null
      ? { instructionsDigest: connection.instructionsDigest }
      : {}),
  };
}

/** What the Add sheet holds while the owner types. The key never leaves this form but to the host. */
export interface KinConnectionDraft {
  readonly service: KinConnectionService["service"];
  readonly label: string;
  readonly url: string;
  readonly key: string;
  readonly org: string;
  readonly secretUrl: string;
  /** This account's own client, where its service allows one (`accountClient`). */
  readonly clientId: string;
  readonly clientSecret: string;
}

export const kinConnectionDraft = (
  service: KinConnectionService["service"],
): KinConnectionDraft => ({
  service,
  label: "",
  url: "",
  key: "",
  org: "",
  secretUrl: "",
  clientId: "",
  clientSecret: "",
});

/** The service's line in the Add sheet's list: Google waits for its one-time setup. */
export const kinServiceNote = (service: KinConnectionService) =>
  !service.available
    ? KIN_CONNECTIONS_COPY.soon
    : service.needsSetup
      ? KIN_CONNECTIONS_COPY.needsSetup
      : service.connect === "sign_in"
        ? KIN_CONNECTIONS_COPY.signIn
        : undefined;

export { kinIsOwnerClientService, type KinOwnerClientService };

/** One account's own client is offered exactly where its service's rule allows one. */
function accountClient(
  service: KinOwnerClientService,
  label: string = KIN_CONNECTIONS_COPY.ownClient,
) {
  return KIN_SIGN_IN_CLIENTS[service].accountClient
    ? { label, detail: KIN_CONNECTIONS_COPY.ownClientDetail }
    : null;
}

/** One step of a one-time setup; `address` steps end with the return address to paste. */
export type KinSetupStep = { readonly text: string; readonly address: boolean };

/**
 * The one-time setup at Google or Microsoft: the steps, the exact return address, and what to
 * paste back. Microsoft's needs no secret: Kin signs in as an app that keeps none.
 */
export const KIN_OWNER_CLIENT_SETUP: Readonly<
  Record<
    KinOwnerClientService,
    {
      readonly title: string;
      readonly detail: string;
      readonly steps: ReadonlyArray<KinSetupStep>;
      readonly clientIdLabel: string;
      readonly clientIdPlaceholder: string;
      readonly secretLabel: string;
      readonly host: string;
      readonly changeClient: string;
      /** What offers one account its own client, where the service allows one. */
      readonly accountClient: { readonly label: string; readonly detail: string } | null;
    }
  >
> = {
  google: {
    title: "Set up Google once",
    detail:
      "Google needs a sign-in client from your company's Google Cloud. It takes about ten minutes, on a computer, and you do it once.",
    steps: [
      "In Google Cloud console (console.cloud.google.com), signed in to the company account, create a project named Kin.",
      "In APIs & Services → Library, turn on the Gmail API and the Google Calendar API.",
      "In Google Auth Platform → Branding, fill in the app name, and under Audience choose Internal.",
      "In Clients → Create client, choose Web application, and under Authorized redirect URIs add exactly this address:",
      "Copy the client ID and client secret Google shows, and paste them below.",
    ].map((text, index) => ({ text, address: index === 3 })),
    clientIdLabel: "Client ID",
    clientIdPlaceholder: "…apps.googleusercontent.com",
    secretLabel: "Client secret",
    host: "accounts.google.com",
    changeClient: "Use a different Google client",
    accountClient: accountClient("google", "This account is in another Google Workspace"),
  },
  microsoft: {
    title: "Set up Microsoft once",
    detail:
      "Microsoft needs Kin registered as an app. It takes about ten minutes, on a computer, and you do it once; every work, school or outlook.com account then signs in with it. If your organization asks an admin to approve new apps, the admin approves Kin the first time.",
    steps: [
      "On a computer, open entra.microsoft.com, sign in with your work account, and go to App registrations → New registration.",
      "Name it Kin. Under Supported account types, choose Accounts in any organizational directory and personal Microsoft accounts.",
      "Under Redirect URI, choose Public client/native (mobile & desktop) and paste exactly this address, then Register:",
      "Open Authentication, turn on Allow public client flows, and save.",
      "On Overview, copy the Application (client) ID and paste it below. No secret is needed.",
    ].map((text, index) => ({ text, address: index === 2 })),
    clientIdLabel: "Application (client) ID",
    clientIdPlaceholder: "00000000-0000-0000-0000-000000000000",
    secretLabel: "Client secret, only if you made one",
    host: "login.microsoftonline.com",
    changeClient: "Use a different Microsoft app",
    accountClient: accountClient("microsoft"),
  },
};

const makeSecret = Schema.decodeSync(KinConnectionKey);

/** The client the owner pasted for a service, checked before it goes to the host. */
export function kinSignInClientCheck(
  orgId: KinOrgId,
  service: KinOwnerClientService,
  clientId: string,
  clientSecret: string,
):
  | { readonly ok: true; readonly input: KinConnectionSetSignInClientInput }
  | { readonly ok: false; readonly problem: string } {
  const setup = KIN_OWNER_CLIENT_SETUP[service];
  const rule = KIN_SIGN_IN_CLIENTS[service];
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (id === "") return { ok: false, problem: `Paste the ${setup.clientIdLabel}.` };
  if (secret === "" && rule.secret === "required")
    return { ok: false, problem: "Paste both the client ID and the client secret." };
  if (!rule.clientId.test(id)) return { ok: false, problem: rule.notClientId };
  if (id.length > 512 || secret.length > 4096)
    return { ok: false, problem: "That's too long to be a sign-in client." };
  return {
    ok: true,
    input: {
      orgId,
      service,
      client: { clientId: id, ...(secret === "" ? {} : { clientSecret: makeSecret(secret) }) },
    },
  };
}

/** The sign-in to start for a draft, or the one thing to fix first. */
export function kinSignInCheck(
  orgId: KinOrgId,
  draft: KinConnectionDraft,
  services: ReadonlyArray<KinConnectionService>,
  returnTo: KinConnectionSignInReturn,
):
  | { readonly ok: true; readonly input: KinConnectionSignInStartInput }
  | { readonly ok: false; readonly problem: string } {
  const service = services.find((entry) => entry.service === draft.service);
  if (service === undefined || service.connect !== "sign_in" || draft.service === "custom")
    return { ok: false, problem: "That service connects with a key." };
  const clientId = draft.clientId.trim();
  const clientSecret = draft.clientSecret.trim();
  const rule = kinIsOwnerClientService(draft.service)
    ? KIN_SIGN_IN_CLIENTS[draft.service]
    : undefined;
  const ownClient = rule?.accountClient === true && (clientId !== "" || clientSecret !== "");
  if (ownClient) {
    if (!rule.clientId.test(clientId)) return { ok: false, problem: rule.notClientId };
    if (clientSecret === "" && rule.secret === "required")
      return { ok: false, problem: "Paste the client secret too." };
  } else if (service.needsSetup) return { ok: false, problem: `Set up ${service.label} first.` };
  const label = draft.label.trim();
  const org = draft.org.trim();
  const secretUrl = draft.secretUrl.trim();
  if (label.length > 80) return { ok: false, problem: "Keep the name under 80 characters." };
  if (org !== "" && !/^[\w.-]{1,100}(\/[\w.-]{1,100})?$/.test(org))
    return { ok: false, problem: "Use the organization's short name, as in its address." };
  if (service.fields.includes("secretUrl")) {
    if (secretUrl === "")
      return { ok: false, problem: `Paste the server address ${service.label} gave you.` };
    if (!URL.canParse(secretUrl) || new URL(secretUrl).protocol !== "https:")
      return { ok: false, problem: "The address should start with https://." };
  }
  return {
    ok: true,
    input: {
      orgId,
      service: draft.service,
      returnTo,
      ...(label === "" ? {} : { label }),
      ...(org === "" || !service.fields.includes("org") ? {} : { org }),
      ...(secretUrl === "" || !service.fields.includes("secretUrl")
        ? {}
        : { secretUrl: makeSecret(secretUrl) }),
      ...(ownClient
        ? {
            client: {
              clientId,
              ...(clientSecret === "" ? {} : { clientSecret: makeSecret(clientSecret) }),
            },
          }
        : {}),
    },
  };
}

/** The services the sheet offers: those Kin can add now, then those whose sign-in comes later. */
export const kinAddableServices = (services: ReadonlyArray<KinConnectionService>) =>
  [...services].sort((a, b) => Number(b.available) - Number(a.available));

const makeKey = makeSecret;

/** The Add input for a draft, or the one thing to fix first. */
export function kinConnectionAddCheck(
  orgId: KinOrgId,
  draft: KinConnectionDraft,
  services: ReadonlyArray<KinConnectionService>,
):
  | { readonly ok: true; readonly input: KinConnectionAddInput }
  | { readonly ok: false; readonly problem: string } {
  const service = services.find((entry) => entry.service === draft.service);
  if (service === undefined || !service.available)
    return { ok: false, problem: `${service?.label ?? "That service"} can't be added yet.` };
  if (service.connect === "sign_in")
    return { ok: false, problem: `${service.label} connects by signing in.` };
  const label = draft.label.trim();
  const key = draft.key.trim();
  const url = draft.url.trim();
  if (label.length > 80) return { ok: false, problem: "Keep the name under 80 characters." };
  if (key.length > 4096) return { ok: false, problem: "That key is too long to be a key." };
  if (draft.service !== "custom" && key === "")
    return { ok: false, problem: `Paste your ${service.label} key to connect.` };
  if (draft.service === "custom") {
    if (url === "") return { ok: false, problem: "Enter the server's address." };
    if (!URL.canParse(url) || new URL(url).protocol !== "https:")
      return { ok: false, problem: "The address should start with https://." };
  }
  return {
    ok: true,
    input: {
      orgId,
      service: draft.service,
      ...(label === "" ? {} : { label }),
      ...(draft.service === "custom" ? { url, auth: key === "" ? "none" : "key" } : {}),
      ...(key === "" ? {} : { key: makeKey(key) }),
    },
  };
}

export interface KinCallRow {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly ok: boolean;
  readonly time: string;
}

/** One line of what an agent asked: who, which tool, how it went, when. */
export function kinCallRow(
  call: KinConnectionCall,
  now: Date,
  tools: ReadonlyArray<Pick<KinToolRow, "name" | "title">> = [],
): KinCallRow {
  const who = call.agentName ?? "An agent";
  const tool = tools.find((row) => row.name === call.toolName)?.title ?? call.toolName;
  const outcome =
    call.status === "ok"
      ? "Done"
      : call.status === "offered"
        ? "Asked you to connect it"
        : call.status === "awaiting_approval"
          ? "Waiting for your Confirm"
          : call.status === "refused"
            ? `Not allowed${call.refusedReason === null ? "" : `: ${call.refusedReason}`}`
            : `Failed${call.refusedReason === null ? "" : `: ${kinConnectionErrorText(call.refusedReason)}`}`;
  return {
    key: call.callId,
    title: call.status === "offered" ? `${who} · ${tool}` : `${who} used ${tool}`,
    detail: outcome,
    ok: call.status === "ok" || call.status === "offered",
    // @effect-diagnostics-next-line globalDate:off - the shared clock-and-day label takes a Date.
    time: formatKinTime(new Date(call.createdAt), now),
  };
}

type Sent<A> = Promise<AtomCommandResult<A, unknown>>;
type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly problem: string };

const settle = async <A>(sent: Sent<A>, doing: string): Promise<Outcome<A>> => {
  const result = await sent;
  return AsyncResult.isSuccess(result)
    ? { ok: true, value: result.value }
    : { ok: false, problem: kinConnectionProblem(squashAtomCommandFailure(result), doing) };
};

/**
 * The owner's changes to connections, each answered in plain words. The host's live refresh
 * redraws the screens; `refresh` reads again at once for the screen that made the change.
 */
export function createKinConnectionActions(options: {
  readonly orgId: KinOrgId;
  readonly add: (input: KinConnectionAddInput) => Sent<KinConnectionDetail>;
  readonly remove: (input: KinConnectionRef) => Sent<KinConnectionsView>;
  readonly signInStart: (input: KinConnectionSignInStartInput) => Sent<KinConnectionSignInStart>;
  readonly signInFinish: (input: KinConnectionSignInFinishInput) => Sent<KinConnectionDetail>;
  readonly setSignInClient: (input: KinConnectionSetSignInClientInput) => Sent<KinConnectionsView>;
  readonly refresh: () => void;
}) {
  const { orgId } = options;
  return {
    /** Starts signing in to a new service from the draft: the host answers with the page to open. */
    signInNew: async (
      draft: KinConnectionDraft,
      services: ReadonlyArray<KinConnectionService>,
      returnTo: KinConnectionSignInReturn,
    ): Promise<Outcome<KinConnectionSignInStart>> => {
      const checked = kinSignInCheck(orgId, draft, services, returnTo);
      if (!checked.ok) return checked;
      return settle(options.signInStart(checked.input), "start the sign-in");
    },
    /** Starts signing in again to a connection whose sign-in expired. */
    signInAgain: (connectionId: KinConnectionId, returnTo: KinConnectionSignInReturn) =>
      settle(options.signInStart({ orgId, connectionId, returnTo }), "start the sign-in"),
    /** Hands the address the service sent the browser back to to the host, which finishes. */
    signInFinish: async (response: string): Promise<Outcome<KinConnectionId>> => {
      const text = response.trim();
      if (text === "" || text.length > 16_384 || !/[?&]state=/.test(text))
        return { ok: false, problem: "Paste the whole address of the page you landed on." };
      const outcome = await settle(
        options.signInFinish({ orgId, response: text }),
        "finish the sign-in",
      );
      options.refresh();
      return outcome.ok ? { ok: true, value: outcome.value.connection.connectionId } : outcome;
    },
    setOwnerClient: async (
      service: KinOwnerClientService,
      clientId: string,
      clientSecret: string,
    ): Promise<Outcome<null>> => {
      const checked = kinSignInClientCheck(orgId, service, clientId, clientSecret);
      if (!checked.ok) return checked;
      const outcome = await settle(options.setSignInClient(checked.input), "save the client");
      options.refresh();
      return outcome.ok ? { ok: true, value: null } : outcome;
    },
    /** Checks the draft, then connects: nothing is saved unless the service answered. */
    add: async (
      draft: KinConnectionDraft,
      services: ReadonlyArray<KinConnectionService>,
    ): Promise<Outcome<KinConnectionId>> => {
      const checked = kinConnectionAddCheck(orgId, draft, services);
      if (!checked.ok) return checked;
      const outcome = await settle(options.add(checked.input), "connect it");
      options.refresh();
      return outcome.ok ? { ok: true, value: outcome.value.connection.connectionId } : outcome;
    },
    remove: async (connectionId: KinConnectionId): Promise<Outcome<null>> => {
      const outcome = await settle(options.remove({ orgId, connectionId }), "remove it");
      options.refresh();
      return outcome.ok ? { ok: true, value: null } : outcome;
    },
  };
}

export type KinConnectionActions = ReturnType<typeof createKinConnectionActions>;

/** Runs one owner change on a connection and answers with the problem, if any. */
export const kinConnectionChange = async <A>(sent: Sent<A>, doing: string) => {
  const outcome = await settle(sent, doing);
  return outcome.ok ? null : outcome.problem;
};

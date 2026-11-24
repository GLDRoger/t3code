import {
  KIN_SIGN_IN_CLIENTS,
  KinChatError,
  KinConnectionKey,
  kinIsOwnerClientService,
  type KinOwnerClientService,
  type KinConnection,
  type KinConnectionAcceptInput,
  type KinConnectionAddInput,
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
  type KinMyMailbox,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import { formatKinTime } from "./kinScreenState.ts";
import { KIN_SERVICE_SLOW, KIN_SERVICE_UNREACHED, kinFailureText } from "./kinAnswers.ts";
import { kinCount } from "./kinCount.ts";
import { kinSettingDiffers, kinSettingSetAll, kinSettingSpread } from "./kinSettingsSpread.ts";

/**
 * The owner's Connections screens: plain-word states for connections and their tools, the Add
 * form's check, and the add and remove flows. Web and mobile only draw what this returns.
 */
export const KIN_CONNECTIONS_COPY = {
  describedChanged: "What the service says it does changed too.",
  inputsChanged: "What it takes changed too.",
  title: "Connections",
  purpose: "What your agents can look things up in, and what they may do there.",
  noKin: "Connect to your Kin to manage its connections.",
  github: "GitHub",
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
  keyHint: "Kin keeps it and never shows it again.",
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
  secretUrlHint: "This address works like a password. Kin keeps it and never shows it again.",
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
  changedShort: "Changed",
  lookAt: "Look at the change",
  changedDetail: "Agents can't use it until you look at the change.",
  accept: "Allow the new version",
  acceptAll: "Allow all changes",
  instructionsChanged: "The service changed its notes to agents.",
  callsTitle: "Recent use",
  noCalls: "No agent has used this yet.",
  openWeb: "Can reach the open web",
  reachTitle: "Reaches only this service",
  reachRow: "Only reads this service",
  reachShort: "Turn off if it can also read other websites.",
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
    "Agents stop using it at once and Kin deletes its key. To use it again, add it again.",
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

/** The outside websites visuals may load from: rarely needed, so folded under Advanced. */
export const KIN_VISUAL_HOSTS = {
  allowFailed: "Couldn't allow it.",
  openLink: "Open this link?",
  advanced: "Advanced",
  section: "Charts",
  title: "Websites charts can load from",
  count: (count: number) => (count === 0 ? "None" : String(count)),
  summary: (hosts: ReadonlyArray<string>) =>
    hosts.length === 0
      ? "None. Charts stay offline."
      : hosts.length === 1
        ? (hosts[0] ?? "")
        : `${hosts[0]} and ${hosts.length - 1} more`,
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
          ? `${kinCount(changed, "tool changed", "tools changed")} since you allowed ${changed === 1 ? "it" : "them"}.`
          : KIN_CONNECTIONS_COPY.instructionsChanged,
    };
  return {
    tone: connection.readTools === 0 ? "muted" : "ok",
    label: connection.readTools === 0 ? "No tools on" : "On",
    detail:
      connection.readTools === 0
        ? "Turn on the tools agents may use."
        : (connection.sendAs?.length ?? 0) > 0 && connection.needsSignInToSend !== true
          ? "Kin reads it, and sends only after you confirm."
          : `Agents can use ${kinCount(connection.readTools, "tool", "tools")}.`,
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

/** Something was typed into the Add sheet, so closing it asks first. */
export const kinConnectionDraftTyped = (draft: KinConnectionDraft): boolean =>
  [
    draft.label,
    draft.url,
    draft.key,
    draft.org,
    draft.secretUrl,
    draft.clientId,
    draft.clientSecret,
  ].some((field) => field.trim() !== "");

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
 * paste back. A Microsoft app made as these steps say keeps no secret; one with a Web redirect does.
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
      "Google needs a sign-in client from your company's Google Cloud. It takes about ten minutes, on a computer, and you do it once. If your company already has a Google sign-in client for a mail app, you can use it instead: add the address below to its Authorized redirect URIs and paste its client ID and secret.",
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
      "Microsoft needs Kin registered as an app. It takes about ten minutes, on a computer, and you do it once; every work, school or outlook.com account then signs in with it. If your organization asks an admin to approve new apps, the admin approves Kin the first time. An app your company already has with a Web redirect and a client secret works too: add the address below to its Web redirect URIs and paste its application ID and secret.",
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

/**
 * Mail and calendar, said once: three decisions over every mail account's tools. Each writes
 * through the same per-tool modes; sending and calendar changes are only ever Off or Ask me.
 */
export type KinMailPermission = "read" | "send" | "calendar";

const MAIL_TOOL_GROUP: Readonly<Record<string, KinMailPermission>> = {
  mail_list_threads: "read",
  mail_search: "read",
  mail_read_thread: "read",
  calendar_list_events: "read",
  calendar_get_event: "read",
  mail_send: "send",
  mail_reply: "send",
  calendar_save_event: "calendar",
};

/** Each mail and calendar tool in a person's words, keyed by its stable name. */
const KIN_MAIL_TOOL_COPY: Readonly<
  Record<string, { readonly title: string; readonly line: string }>
> = {
  mail_list_threads: { title: "See recent mail", line: "The latest conversations in this inbox." },
  mail_search: { title: "Search mail", line: "Find messages by who sent them, words or dates." },
  mail_read_thread: { title: "Read a conversation", line: "One conversation, start to finish." },
  calendar_list_events: { title: "See the calendar", line: "Events over the coming days." },
  calendar_get_event: { title: "Read an event", line: "One event, with who's invited." },
  mail_send: { title: "Send an email", line: "A new email from this account." },
  mail_reply: { title: "Reply to a conversation", line: "An answer in a conversation." },
  calendar_save_event: {
    title: "Add or change an event",
    line: "An event on this calendar, and its invitations.",
  },
};

const kinMailToolGroup = (toolName: string): KinMailPermission | null =>
  MAIL_TOOL_GROUP[toolName] ?? null;

/** A mail account: Google or Microsoft, signed in through Kin. */
export const kinIsMailConnection = (connection: Pick<KinConnection, "kind" | "preset">) =>
  connection.kind === "builtin" &&
  (connection.preset === "google" || connection.preset === "microsoft");

export const KIN_MAIL_COPY = {
  section: "Mail and calendar",
  providerAccounts: (preset: "google" | "microsoft") =>
    preset === "google" ? "Google accounts" : "Microsoft accounts",
  open: "Open",
  sectionDetail: "For every account. Sending and calendar changes always wait for you.",
  accountDetail: "Sending and calendar changes always wait for you.",
  add: "Add account",
  addTitle: (provider: string) => `Add a ${provider} account`,
  empty: "Add a Google or Microsoft account and your agents can read mail and your calendar.",
  loadFailed: "Couldn't load your accounts.",
  changeFailed: "Couldn't change that. Nothing else was changed.",
  agentsMay: "What agents may do",
  eachTool: "Each tool",
  eachToolDetail: (on: number, all: number) => `${on} of ${all} on. Set them one by one here.`,
  pausedDetail: "Agents can't use it until you resume.",
  noteTitle: "What it's for",
  noteNone: "Not set",
  nameTitle: "Name",
  sendsFromTitle: "Sends from",
  signInTitle: "Sign-in",
  signInDetail: "Renew it if the service asks you to.",
  accountSection: (mail: boolean) => (mail ? "Account" : "Service"),
  keyDetail: "Kept out of sight. Replace it when the service gives you a new one.",
  keyHint: "Kin checks it right away and never shows it again.",
  hide: "Hide",
  show: "Show",
  turnOn: (count: number) => `Turn on (${count})`,
  refreshDetail: "Ask the service for its current list.",
  check: "Check",
  callsFailed: "Couldn't load recent use.",
  signInLapsed: "Its sign-in stopped working, so agents can't use it.",
  removeAccount: "Remove this account",
  removeService: "Remove this service",
  nameNeeded: "Give it a name.",
  keyNeeded: "Paste the new key.",
  tooLong: "That's too long.",
  saveName: "Save name",
  saveNote: "Save note",
  before: "Before",
  now: "Now",
  noDescription: "No description.",
  allFailed: "Couldn't change every account. Some may already have the new choice.",
  pauseTitle: "Pause",
  pauseDetail: "Agents stop using it until you resume. Nothing else changes.",
  resumeTitle: "Paused",
  removeRowDetail: "Agents stop using it at once.",
  pauseOrRemove: "Pause or remove",
  otherServices: "Other services",
  otherServicesEmpty: "Connect another service and your agents can look things up in it.",
  addService: "Add service",
  addServiceTitle: "Add a service",
  removeAccountTitle: (address: string) => `Remove ${address}?`,
  removeAccountDetail:
    "Agents stop using it at once and Kin forgets its sign-in. To use it again, add it again.",
} as const;

export const KIN_MAIL_PERMISSIONS: ReadonlyArray<{
  readonly permission: KinMailPermission;
  readonly title: string;
  readonly options: ReadonlyArray<{
    readonly value: KinConnectionToolMode;
    readonly label: string;
  }>;
}> = [
  {
    permission: "read",
    title: "Read mail and calendar",
    options: [
      { value: "read", label: "Allowed" },
      { value: "ask", label: "Ask me first" },
      { value: "off", label: "Off" },
    ],
  },
  {
    permission: "send",
    title: "Send mail and replies",
    options: [
      { value: "ask", label: "Ask me first" },
      { value: "off", label: "Off" },
    ],
  },
  {
    permission: "calendar",
    title: "Add or change calendar events",
    options: [
      { value: "ask", label: "Ask me first" },
      { value: "off", label: "Off" },
    ],
  },
];

/** A tool's mode in the same words as the rows above it. */
export const kinMailModeLabel = (mode: KinConnectionToolMode) =>
  mode === "read" ? "Allowed" : mode === "ask" ? "Ask me first" : "Off";

/** One account's value for a permission: one mode, `mixed` across its tools, or null with none. */
export type KinMailAccountValue = KinConnectionToolMode | "mixed";

const groupTools = (tools: ReadonlyArray<KinConnectionTool>, permission: KinMailPermission) =>
  tools.filter((tool) => tool.removedAt === null && kinMailToolGroup(tool.name) === permission);

export function kinMailAccountValue(
  tools: ReadonlyArray<KinConnectionTool>,
  permission: KinMailPermission,
): KinMailAccountValue | null {
  const spread = kinSettingSpread(groupTools(tools, permission).map((tool) => tool.mode));
  return spread.kind === "none" ? null : spread.kind === "same" ? spread.value : "mixed";
}

/**
 * The row said once over every account: the value every account has (null shows Mixed), and
 * whether one account's own page says it differs. Hidden (`null`) with no account to say it for.
 */
export function kinMailPermission(
  accounts: ReadonlyArray<ReadonlyArray<KinConnectionTool>>,
  permission: KinMailPermission,
) {
  const values = accounts.flatMap((tools) => {
    const value = kinMailAccountValue(tools, permission);
    return value === null ? [] : [value];
  });
  const spread = kinSettingSpread(values);
  if (spread.kind === "none") return null;
  return {
    value: spread.kind === "same" && spread.value !== "mixed" ? spread.value : null,
    differs: (tools: ReadonlyArray<KinConnectionTool>) => {
      const own = kinMailAccountValue(tools, permission);
      return own !== null && kinSettingDiffers(own, spread);
    },
  };
}

/**
 * What one account must be sent to have `mode` for a permission: only its tools that differ,
 * never one waiting for a look at a change, and never Read for a tool that sends.
 */
export function kinMailModes(
  tools: ReadonlyArray<KinConnectionTool>,
  permission: KinMailPermission,
  mode: KinConnectionToolMode,
): Modes {
  if (mode === "read" && permission !== "read") return [];
  const rows = kinToolRows(groupTools(tools, permission)).filter(
    (row) => row.state !== "changed" && row.modes.includes(mode),
  );
  return kinSettingSetAll(rows, (row) => row.mode, mode).flatMap((row) => kinToolMark(row, mode));
}

/** A tool's line on an account's page: a person's words for mail tools, nothing else's model text. */
export const kinToolCopy = (row: Pick<KinToolRow, "name" | "title">) =>
  KIN_MAIL_TOOL_COPY[row.name] ?? { title: row.title, line: null };

const MAIL_ORDER = Object.keys(KIN_MAIL_TOOL_COPY);

/** A mail account's tools in the order of the three rows: reads, sending, then the calendar. */
export const kinMailToolOrder = (rows: ReadonlyArray<KinToolRow>): ReadonlyArray<KinToolRow> =>
  [...rows].sort(
    (a, b) =>
      Number(b.state === "changed") - Number(a.state === "changed") ||
      (MAIL_ORDER.indexOf(a.name) + 1 || 99) - (MAIL_ORDER.indexOf(b.name) + 1 || 99),
  );

/**
 * One use on an account's page, in a person's words: what was done, who, how it went, when. The
 * reason the host gave the agent is never shown; only an expired sign-in is said, as it's yours to fix.
 */
export function kinUseRow(
  call: KinConnectionCall,
  now: Date,
  tools: ReadonlyArray<Pick<KinToolRow, "name" | "title">>,
): KinCallRow {
  const tool = tools.find((row) => row.name === call.toolName);
  const what = tool === undefined ? call.toolName : kinToolCopy(tool).title;
  const outcome =
    call.status === "ok"
      ? "Done"
      : call.status === "offered"
        ? "Asked you to connect it"
        : call.status === "awaiting_approval"
          ? "Waiting for you"
          : call.status === "refused"
            ? "Not allowed by your settings"
            : /sign-?in/i.test(call.refusedReason ?? "")
              ? "Didn't go through: the sign-in had expired"
              : "Didn't go through";
  return {
    key: call.callId,
    title: what,
    // @effect-diagnostics-next-line globalDate:off - the shared clock-and-day label takes a Date.
    detail: `${call.agentName ?? "An agent"} · ${outcome} · ${formatKinTime(new Date(call.createdAt), now)}`,
    ok: call.status === "ok" || call.status === "offered" || call.status === "awaiting_approval",
    // @effect-diagnostics-next-line globalDate:off - the shared clock-and-day label takes a Date.
    time: formatKinTime(new Date(call.createdAt), now),
  };
}

/**
 * Settings › Your mailbox, on web and phone: a person's own Google or Microsoft mail, which Kin
 * drafts their follow-ups from and only they confirm sends from. The owner level sees whose
 * mailbox is connected and which address, never what is in it.
 */
export const KIN_MY_MAILBOX_COPY = {
  title: "Your mailbox",
  none: "Connect your own Google or Microsoft mail, and Kin drafts your follow-ups from it. Nothing goes until you tap Confirm, and only you see what is in it.",
  connected: (address: string) =>
    `Connected as ${address}. Kin drafts your follow-ups from it; only you confirm what goes.`,
  needsSignIn: (address: string) =>
    `${address} needs signing in again before Kin can draft or send from it.`,
  connect: (label: string) => `Connect ${label}`,
  notReady: (label: string) =>
    `${label} isn't set up for this company yet. The owner sets it up once in Connections.`,
  signInAgain: "Sign in again",
  disconnect: "Disconnect",
  loadFailed: "Couldn't load your mailbox",
  teammatesTitle: "Teammates' mailboxes",
  teammatesFooter:
    "Which address each person connected. Kin never shows you what is in it or sends from it for you.",
  teammateNeedsSignIn: "Needs signing in again",
  /** Whose a connected mailbox is, said beside it. */
  companys: "The company's",
  yours: "Yours",
  makeMine: "Make this my own mailbox",
  makeMineRow: "Kin stops watching it for the company. Your sign-in stays.",
  makeMineTitle: (address: string) => `Make ${address} your own mailbox?`,
  makeMineDetail:
    "Kin will stop watching this mailbox for the company, and no bank alert is read from it. Only you, in your own chat with an agent, can have it read, and only you confirm what goes from it. Cards waiting to send from it close unsent. What Kin already made from it stays the company's.",
  makeMineAction: "Make it mine",
  makeCompanys: "Make this the company's mailbox",
  makeCompanysTitle: (address: string) => `Make ${address} the company's mailbox?`,
  makeCompanysDetail:
    "The company's agents will be able to read everything in it, older mail included, and what goes from it needs an owner's or co-owner's Confirm. Kin watches it for the company from now on: mail that came while it was yours isn't noticed. Cards waiting to send from it close unsent. What you sent from it stays yours.",
  makeCompanysAction: "Make it the company's",
  moving: "move this mailbox",
} as const;

/** What Your mailbox shows: none yet, connected, or connected and needing a sign-in. */
export const kinMyMailboxLine = (view: KinMyMailbox) => {
  const mailbox = view.mailbox;
  if (mailbox === null) return { _tag: "none" as const, text: KIN_MY_MAILBOX_COPY.none };
  const address = mailbox.account ?? mailbox.preset ?? KIN_MY_MAILBOX_COPY.title;
  return mailbox.state === "needs_sign_in"
    ? { _tag: "signIn" as const, text: KIN_MY_MAILBOX_COPY.needsSignIn(address) }
    : { _tag: "connected" as const, text: KIN_MY_MAILBOX_COPY.connected(address) };
};

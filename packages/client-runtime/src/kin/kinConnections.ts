import {
  EnvironmentAuthorizationError,
  KinChatError,
  KinConnectionKey,
  type KinConnection,
  type KinConnectionAcceptInput,
  type KinConnectionAddInput,
  type KinConnectionCall,
  type KinConnectionDetail,
  type KinConnectionId,
  type KinConnectionRef,
  type KinConnectionService,
  type KinConnectionSetToolModesInput,
  type KinConnectionsView,
  type KinConnectionTool,
  type KinConnectionToolDefinition,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import { formatKinTime } from "./kinScreenState.ts";

/**
 * The owner's Connections screens: plain-word states for connections and their tools, the Add
 * form's check, and the add and remove flows. Web and mobile only draw what this returns.
 */
export const KIN_CONNECTIONS_COPY = {
  title: "Connections",
  rowDetail: "Outside services your agents can read from.",
  intro:
    "Services your agents can read from, in chats only you can see. You choose each tool they may use.",
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
  soon: "Sign-in arrives in a later update",
  toolsTitle: "Tools",
  toolsDetail:
    "Off: agents can't use it. Read: agents use it when they need to, in chats only you can see.",
  noTools: "This service lists no tools.",
  suggested: "Turn on suggested",
  suggestedDetail: "Tools the service says only read.",
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
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/** A failure the host sent back, in the owner's words, with what to do about it. */
function kinConnectionErrorText(message: string): string {
  if (/refused the key/i.test(message))
    return "The service didn't accept the key. Make a new key there and use Replace key.";
  if (/key is missing/i.test(message)) return "The key is missing. Use Replace key to add it.";
  if (/couldn't reach/i.test(message))
    return `${message} Check the address, or try again in a minute.`;
  if (/didn't answer in time/i.test(message)) return `${message} Try again in a minute.`;
  if (/public internet addresses|only over https|name or password/i.test(message))
    return `${message} Use the service's public https address.`;
  if (/redirect/i.test(message)) return `${message} Use the address the redirect points to.`;
  if (/HTTP (404|405)/.test(message))
    return `${message} Check the server address the service gave you.`;
  return message;
}

/** Why an owner action on a connection failed, from the command's result. */
function kinConnectionProblem(error: unknown, doing: string): string {
  if (isAuthorizationError(error)) return `This device isn't allowed to ${doing}.`;
  if (!isChatError(error)) return `Couldn't ${doing}. Check your connection and try again.`;
  switch (error.reason) {
    case "not_allowed":
      return error.message === "" ? KIN_CONNECTIONS_COPY.onlyOwner : error.message;
    case "not_found":
      return "That connection is no longer here.";
    case "disabled":
      return "Kin is turned off on this server.";
    default:
      return error.message === ""
        ? `Couldn't ${doing} right now. Try again in a moment.`
        : kinConnectionErrorText(error.message);
  }
}

export type KinConnectionTone = "ok" | "attention" | "error" | "muted";

export interface KinConnectionStatus {
  readonly tone: KinConnectionTone;
  readonly label: string;
  readonly detail: string;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** One line on how a connection stands: paused, broken, waiting on the owner, or working. */
export function kinConnectionStatus(connection: KinConnection): KinConnectionStatus {
  if (connection.paused)
    return { tone: "muted", label: "Paused", detail: KIN_CONNECTIONS_COPY.pausedDetail };
  if (connection.state === "error" || connection.lastError !== null)
    return {
      tone: "error",
      label: "Can't connect",
      detail: kinConnectionErrorText(connection.lastError ?? "Kin couldn't reach it."),
    };
  if (connection.state === "needs_sign_in")
    return { tone: "error", label: "Needs sign-in", detail: "Sign in again to keep using it." };
  const changed = connection.changedTools;
  const instructions =
    connection.instructionsDigest !== null &&
    connection.instructions !== connection.acceptedInstructions;
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
  /** The service says it only reads: Kin suggests Read. */
  readonly suggested: boolean;
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
        suggested: tool.suggestedMode === "read",
        openWeb: tool.openWorld,
        change: tool.changed ? toolChange(tool.definition, tool.accepted) : null,
        digest: tool.pinDigest,
      };
    })
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

type Modes = KinConnectionSetToolModesInput["modes"];

/** Switching one tool: turning it on names the definition shown, so a later change waits. */
export const kinToolSwitch = (row: KinToolRow, on: boolean): Modes =>
  on ? [{ tool: row.name, mode: "read", digest: row.digest }] : [{ tool: row.name, mode: "off" }];

/** The off tools the service says only read, unchanged since shown: one tap turns them on. */
export const kinSuggestedModes = (rows: ReadonlyArray<KinToolRow>): Modes =>
  rows
    .filter((row) => !row.on && row.suggested && row.state !== "changed")
    .map((row) => ({ tool: row.name, mode: "read", digest: row.digest }));

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
}

export const kinConnectionDraft = (
  service: KinConnectionService["service"],
): KinConnectionDraft => ({ service, label: "", url: "", key: "" });

/** The services the sheet offers: those Kin can add now, then those whose sign-in comes later. */
export const kinAddableServices = (services: ReadonlyArray<KinConnectionService>) =>
  [...services].sort((a, b) => Number(b.available) - Number(a.available));

const makeKey = Schema.decodeSync(KinConnectionKey);

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
          ? "Waiting for you"
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
  readonly refresh: () => void;
}) {
  const { orgId } = options;
  return {
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

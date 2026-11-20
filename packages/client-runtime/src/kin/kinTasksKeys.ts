// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import { kinNow } from "./kinNow.ts";
import {
  KIN_TASKS_KEY_LIMIT,
  KIN_TASKS_KEY_PATH,
  kinIsLocalOnlyHost,
  type KinTasksKey,
} from "@t3tools/contracts";

import type { KinDevice } from "./kinDevice.ts";
import { formatKinTime } from "./kinScreenState.ts";

/** The longest label the host takes for a key. */
export const KIN_TASKS_KEY_LABEL_MAX = 60;
// The name each setup below gives Kin's server in the coding agent's own config.
const SERVER_NAME = "kin";
const CODEX_KEY_ENV = "KIN_TASKS_KEY";

/** Every sentence both clients say about a person's coding agent keys. */
export const KIN_TASKS_KEYS_COPY = {
  title: "Coding agent keys",
  intro:
    "Let your own coding agent, such as Claude Code, Codex or Cursor, read and update the tasks you hold.",
  theirsIntro: (name: string) =>
    `Keys ${name} made for their coding agent. Only ${name} can make one; you can remove them.`,
  none: "No keys yet.",
  noneTheirs: (name: string) => `${name} has no coding agent keys.`,
  loadFailed: "Couldn't load coding agent keys.",
  make: "Make a key",
  makeTitle: "Make a coding agent key",
  labelLabel: "What is it for?",
  labelHint: "A short name, such as the computer or tool, so you know which key is which.",
  labelMissing: "Give the key a short name.",
  create: "Make key",
  makeFailed: "Couldn't make the key.",
  remove: "Remove",
  removeFailed: "Couldn't remove the key.",
  removeGone: "That key is already gone, or isn't yours to remove.",
  copy: "Copy",
  copied: "Copied",
  done: "Done",
  madeTitle: (label: string) => `Key made: ${label}`,
  once: "Copy it now. Kin won't show this key again. If you lose it, remove it and make another.",
  can: "With it, your coding agent can read the tasks you hold, add notes to them, and set them to to-do, in progress or done.",
  cannot: "It can't reach anyone else's tasks, or any chats, money or files.",
  keyLabel: "Key",
  addressLabel: "Address",
  setupTitle: "Set up your coding agent",
  /** The phone knows only the address it reaches Kin by, which a computer may not share. */
  phoneAddress:
    "This is the address this phone reaches Kin by. If your coding agent's computer reaches Kin another way, use that address with the same ending.",
  localOnly:
    "This address only works on this computer. A coding agent anywhere else needs the address your team reaches Kin by.",
  dropped:
    "The connection dropped before the address could be shown. Remove this key and make another.",
} as const;

/** One key as a row: its label and one line of when it was made, when it ends and when last used. */
export interface KinTasksKeyRow {
  readonly sessionId: KinTasksKey["sessionId"];
  readonly label: string;
  readonly line: string;
  /** Offer Remove: false only when the host says this reader may not; an older host doesn't say. */
  readonly canRemove: boolean;
}

const DAY_MS = 86_400_000;
const days = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;

function expiresText(expiresAt: Date, now: Date): string {
  const when = formatKinTime(expiresAt, now);
  if (expiresAt.toDateString() === now.toDateString()) return `Expires today at ${when}`;
  const left = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS));
  return `Expires ${when}, in ${days(left)}`;
}

/** "Made 11 Nov · Expires 11 Dec, in 30 days · Never used". */
export function kinTasksKeyRows(
  keys: readonly KinTasksKey[],
  now: Date = kinNow(),
): readonly KinTasksKeyRow[] {
  return keys.map((key) => ({
    sessionId: key.sessionId,
    label: key.label,
    line: [
      `Made ${formatKinTime(new Date(key.createdAt), now)}`,
      expiresText(new Date(key.expiresAt), now),
      key.lastUsedAt === null
        ? "Never used"
        : `Last used ${formatKinTime(new Date(key.lastUsedAt), now)}`,
    ].join(" · "),
    canRemove: key.canRevoke !== false,
  }));
}

/** Why "Make a key" is off, or null while another key fits. */
export function kinTasksKeyMakeBlocked(count: number): string | null {
  return count < KIN_TASKS_KEY_LIMIT
    ? null
    : `You have ${KIN_TASKS_KEY_LIMIT} keys, the most one person can hold. Remove one to make another.`;
}

/** The label as the host takes it, or why it can't be sent yet. */
export function kinTasksKeyLabelCheck(
  typed: string,
):
  | { readonly ok: true; readonly label: string }
  | { readonly ok: false; readonly problem: string } {
  const label = typed.trim();
  return label === "" || label.length > KIN_TASKS_KEY_LABEL_MAX
    ? { ok: false, problem: KIN_TASKS_KEYS_COPY.labelMissing }
    : { ok: true, label };
}

/** The confirm before a key is removed; `holder` is null on your own keys. */
export function kinTasksKeyRemoveCopy(label: string, holder: string | null) {
  const whose = holder === null ? "your" : `${holder}'s`;
  return {
    title: `Remove "${label}"?`,
    detail: `The coding agent using this key stops reaching ${whose} tasks on its next call. A removed key can't be brought back; ${holder === null ? "make a new one" : `${holder} can make a new one`} to connect again.`,
    confirm: "Remove key",
  };
}

/** Where a coding agent reaches the tasks: the host's public origin, else this client's, plus the path. */
function kinTasksKeyAddress(origin: string): string {
  return new URL(KIN_TASKS_KEY_PATH, origin).toString();
}

/** One way to set up a common coding agent: a command to run, or a file to add to. */
export interface KinTasksKeySetup {
  readonly agent: string;
  readonly where: string;
  readonly text: string;
}

/**
 * Ready-to-paste setup for each common coding agent. Shapes: `claude mcp add --help` (2.1),
 * `codex mcp add --help` (0.166), and Cursor's `mcp.json` (`McpServerConfig` in @cursor/sdk).
 */
function kinTasksKeySetups(address: string, secret: string): readonly KinTasksKeySetup[] {
  return [
    {
      agent: "Claude Code",
      where: "Run in a terminal:",
      text: `claude mcp add --transport http --scope user ${SERVER_NAME} ${address} --header "Authorization: Bearer ${secret}"`,
    },
    {
      agent: "Codex",
      where: `Run in a terminal; Codex reads the key from ${CODEX_KEY_ENV}, so keep the first line in your shell profile:`,
      text: `export ${CODEX_KEY_ENV}="${secret}"\ncodex mcp add ${SERVER_NAME} --url ${address} --bearer-token-env-var ${CODEX_KEY_ENV}`,
    },
    {
      agent: "Cursor",
      where: "Add to ~/.cursor/mcp.json, beside any servers already there:",
      text: JSON.stringify(
        {
          mcpServers: {
            [SERVER_NAME]: { url: address, headers: { Authorization: `Bearer ${secret}` } },
          },
        },
        null,
        2,
      ),
    },
    {
      agent: "Another MCP client",
      where: "Add a remote MCP server (Streamable HTTP) at the address, with this header:",
      text: `Authorization: Bearer ${secret}`,
    },
  ];
}

/** The once-only panel after a key is made: what it is, where it goes, and how to set it up. */
export function kinTasksKeyMade(made: {
  readonly key: KinTasksKey;
  readonly secret: string;
  /** The address the host says anyone reaches it by; absent when it knows none. */
  readonly origin?: string | undefined;
  readonly httpBaseUrl: string;
  readonly device: KinDevice;
}) {
  const address = kinTasksKeyAddress(made.origin ?? made.httpBaseUrl);
  const host = new URL(address).hostname;
  return {
    title: KIN_TASKS_KEYS_COPY.madeTitle(made.key.label),
    lines: [
      KIN_TASKS_KEYS_COPY.once,
      KIN_TASKS_KEYS_COPY.can,
      KIN_TASKS_KEYS_COPY.cannot,
      `${expiresText(new Date(made.key.expiresAt), new Date(made.key.createdAt))}. Make a new key then to keep going.`,
    ],
    secret: made.secret,
    address,
    addressNote: kinIsLocalOnlyHost(host)
      ? KIN_TASKS_KEYS_COPY.localOnly
      : made.device === "phone" && made.origin === undefined
        ? KIN_TASKS_KEYS_COPY.phoneAddress
        : null,
    setups: kinTasksKeySetups(address, made.secret),
  };
}

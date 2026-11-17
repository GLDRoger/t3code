import type {
  KinConnectionField,
  KinConnectionPreset,
  KinConnectionReach,
  KinConnectionService,
} from "@t3tools/contracts";

import { googleMail } from "./Google.ts";
import { microsoftMail } from "./Microsoft.ts";

/** A preset Kin can add today: a remote MCP server that takes a key as a bearer token. */
type KeyPreset = {
  readonly label: string;
  readonly url: string;
  readonly reach: KinConnectionReach;
  readonly setup: string;
};

// Presets reach only the vendor that already holds the owner's data, so they are `closed`.
export const KEY_PRESETS: Partial<Record<KinConnectionPreset, KeyPreset>> = {
  posthog: {
    label: "PostHog",
    url: "https://mcp.posthog.com/mcp",
    reach: "closed",
    setup:
      "In PostHog: Settings → Personal API keys → New key, preset MCP Server, choose the project.",
  },
};

/**
 * A preset the owner connects by signing in at the service. `remote` ones are MCP servers whose
 * sign-in Kin discovers; `url: null` means the owner's own address, which is itself a secret.
 * Google and Microsoft are Kin's own mail tools, signed in with a client the owner made there.
 */
type SignInPreset = {
  readonly label: string;
  readonly kind: "remote" | "builtin";
  readonly url: string | null;
  readonly host: string;
  readonly fields: ReadonlyArray<KinConnectionField>;
  readonly setup: string;
};

export const SIGN_IN_PRESETS: Partial<Record<KinConnectionPreset, SignInPreset>> = {
  sentry: {
    label: "Sentry",
    kind: "remote",
    url: "https://mcp.sentry.dev/mcp",
    host: "mcp.sentry.dev",
    fields: ["org"],
    setup: "Sign in to Sentry. Name an organization to keep agents to it, or leave it empty.",
  },
  zoho_books: {
    label: "Zoho Books",
    kind: "remote",
    url: null,
    host: "zohomcp.com",
    fields: ["secretUrl"],
    setup:
      "In Zoho MCP: create a server, add Zoho Books and the tools agents may use, then copy its server address here and sign in.",
  },
  google: {
    label: googleMail.name,
    kind: "builtin",
    url: null,
    host: "googleapis.com",
    fields: [],
    setup: "Mail and calendar. Nothing is sent until you tap Confirm.",
  },
  microsoft: {
    label: microsoftMail.name,
    kind: "builtin",
    url: null,
    host: "graph.microsoft.com",
    fields: [],
    setup:
      "Outlook mail and calendar, for a work or school account or an outlook.com one. Nothing is sent until you tap Confirm.",
  },
};

/** What the Add sheet lists: every preset, and a custom server. */
export const SERVICES: ReadonlyArray<KinConnectionService> = [
  ...Object.entries(KEY_PRESETS).map(([service, preset]) => ({
    service: service as KinConnectionPreset,
    label: preset.label,
    available: true,
    setup: preset.setup,
    connect: "key" as const,
    fields: ["key" as const],
    needsSetup: false,
  })),
  ...Object.entries(SIGN_IN_PRESETS).map(([service, preset]) => ({
    service: service as KinConnectionPreset,
    label: preset.label,
    available: true,
    setup: preset.setup,
    connect: "sign_in" as const,
    fields: preset.fields,
    needsSetup: false,
  })),
  {
    service: "custom",
    label: "Another service",
    available: true,
    setup: "Paste the server address the service gives for connecting AI tools.",
    connect: "key",
    fields: ["url", "key"],
    needsSetup: false,
  },
];

/** The redirect every service sends the browser back to: Kin's static sign-in return page. */
export const DEFAULT_SIGN_IN_ADDRESS = "https://gldroger.github.io/t3code/kin/oauth/callback/";

/** A custom server can reach anywhere until the owner says it only talks to its own vendor. */
export const CUSTOM_REACH: KinConnectionReach = "open";
export const DEFAULT_KEY_HEADER = "authorization";

/** A key as the header carries it: a bare key in `Authorization` is sent as a bearer token. */
export const keyHeaderValue = (header: string, key: string) =>
  header.toLowerCase() === DEFAULT_KEY_HEADER && !/^\w+\s/.test(key) ? `Bearer ${key}` : key;

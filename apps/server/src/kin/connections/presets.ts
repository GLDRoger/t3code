import type {
  KinConnectionPreset,
  KinConnectionReach,
  KinConnectionService,
} from "@t3tools/contracts";

/** A preset Kin can add today: a remote MCP server that takes a key as a bearer token. */
type KeyPreset = {
  readonly label: string;
  readonly url: string;
  readonly reach: KinConnectionReach;
  readonly setup: string;
};

// Presets reach only the vendor that already holds the owner's data, so they are `closed`.
export const KEY_PRESETS: Partial<Record<KinConnectionPreset, KeyPreset>> = {
  github: {
    label: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    reach: "closed",
    setup:
      "In GitHub: Settings → Developer settings → Fine-grained tokens → Generate, read-only, for the repositories agents may read.",
  },
  posthog: {
    label: "PostHog",
    url: "https://mcp.posthog.com/mcp",
    reach: "closed",
    setup:
      "In PostHog: Settings → Personal API keys → New key, preset MCP Server, choose the project.",
  },
};

const SIGN_IN_COMING: ReadonlyArray<readonly [KinConnectionPreset, string]> = [
  ["sentry", "Sentry"],
  ["google", "Google Workspace"],
  ["zoho_books", "Zoho Books"],
];

/** What the Add sheet lists: every preset, whether it can be added yet, and a custom server. */
export const SERVICES: ReadonlyArray<KinConnectionService> = [
  ...Object.entries(KEY_PRESETS).map(([service, preset]) => ({
    service: service as KinConnectionPreset,
    label: preset.label,
    available: true,
    setup: preset.setup,
  })),
  ...SIGN_IN_COMING.map(([service, label]) => ({ service, label, available: false, setup: null })),
  { service: "custom", label: "Another MCP server", available: true, setup: null },
];

/** A custom server can reach anywhere until the owner says it only talks to its own vendor. */
export const CUSTOM_REACH: KinConnectionReach = "open";
export const DEFAULT_KEY_HEADER = "authorization";

/** A key as the header carries it: a bare key in `Authorization` is sent as a bearer token. */
export const keyHeaderValue = (header: string, key: string) =>
  header.toLowerCase() === DEFAULT_KEY_HEADER && !/^\w+\s/.test(key) ? `Bearer ${key}` : key;

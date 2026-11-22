import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { KIN_INVITE_LINK_PATH } from "@t3tools/shared/remote";
import { redirect } from "@tanstack/react-router";

import { isElectron } from "../env";
import { GUEST_PAGE_PATH } from "../guestPage";
import { KIN_WEB_ONLY } from "./kinWebOnly";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** A coding thread's address that Kin turned back, so Kin can say whose it was. */
    kinStrayThread?: { readonly environmentId: string; readonly threadId: string };
  }
}

/** Addresses the Kin web app shows: Kin's pages, the app's settings over them, and sign-in. */
const KIN_KEEPS = [
  "/kin",
  "/settings",
  "/usage",
  "/pair",
  "/connect",
  "/connect-agent",
  "/approve-agent",
  "/welcome",
  GUEST_PAGE_PATH,
  KIN_INVITE_LINK_PATH,
];

/** T3 Code's Settings pages that only serve coding threads; the Kin web app shows none of them. */
export const KIN_CODING_SETTINGS: ReadonlySet<string> = new Set([
  "/settings/chat",
  "/settings/diffs",
  "/settings/voice",
  "/settings/snap-shot",
  "/settings/threads",
  "/settings/browser",
  "/settings/devices",
  "/settings/scheduled-tasks",
  "/settings/projects",
  "/settings/source-control",
  "/settings/worktrees",
  "/settings/archived",
]);

/**
 * Rows and sections on the Settings pages Kin keeps that only serve coding threads, by their
 * search anchor. Search leaves them out and the pages don't draw them; a section is named here
 * when nothing Kin keeps is left in it.
 */
export const KIN_CODING_SETTING_ROWS: ReadonlySet<string> = new Set([
  // General
  "notifications",
  "thread-notifications",
  "in-app-notifications",
  "sidebar",
  "project-grouping",
  "project-order",
  "working-shelf",
  "unpin-confirmation",
  "archive-confirmation",
  "delete-confirmation",
  "terminal-close-confirmation",
  // Appearance
  "chat-width",
  "thread-details-items",
  "effort-display",
  "composer-context",
  "prompt-font",
  "terminal-font",
  "separate-fonts",
  // Providers
  "text-generators",
  // Environments
  "load-balancing",
  "pull-request-routing",
  // Maintenance
  "git-fetch-interval",
  // Labs
  "boring-sidebar",
  "boring-sidebar-multiline",
  "guest-links",
  "prompt-suggestions-beta",
  "simlock-hosts",
  "worktree-fast-checkout",
  // About: T3 Code's CLI, and T3 Code's phone app in the stores
  "cli-command",
  "mobile-app",
]);

/** Keys that work over Kin's own pages; Keybindings lists no other command in the Kin web app. */
const KIN_APP_KEYS: ReadonlySet<string> = new Set([
  "commandPalette.toggle",
  "kin.switchList",
  "sidebar.toggle",
  "navigation.back",
  "navigation.forward",
  "workspace.focusNext",
  "workspace.focusPrevious",
  "theme.select",
  "appearance.cycle",
  "themeEditor.toggle",
  "usage.open",
  "usage.cost",
  "usage.tokens",
  "usage.limits",
  "usage.period.day",
  "usage.period.week",
  "usage.period.month",
  "usage.period.quarter",
]);

const KEYBINDING_ANCHOR = "keybinding-";

/** Whether the Kin web app leaves out the Settings row or section with this anchor. */
export function kinSettingHidden(id: string | undefined, kinOnly = KIN_WEB_ONLY): boolean {
  if (!kinOnly || id === undefined) return false;
  // Desktop keeps its quit shortcut there; on the web nothing in Confirmations is left.
  if (id === "confirmations") return !isElectron;
  if (id.startsWith(KEYBINDING_ANCHOR))
    return !KIN_APP_KEYS.has(id.slice(KEYBINDING_ANCHOR.length));
  return KIN_CODING_SETTING_ROWS.has(id);
}

/** Whether Keybindings lists this command in the app; the Kin web app lists only `KIN_APP_KEYS`. */
export const kinKeyShown = (command: string, kinOnly = KIN_WEB_ONLY): boolean =>
  !kinSettingHidden(`${KEYBINDING_ANCHOR}${command}`, kinOnly);

/** The settings pages and search rows the app offers, less the coding ones in the Kin web app. */
export function kinSettingsShown<Item extends { readonly id?: string; readonly to: string }>(
  items: ReadonlyArray<Item>,
  kinOnly = KIN_WEB_ONLY,
): ReadonlyArray<Item> {
  return kinOnly
    ? items.filter((item) => !KIN_CODING_SETTINGS.has(item.to) && !kinSettingHidden(item.id, true))
    : items;
}

// T3 Code's two-part addresses that aren't a thread's `/<environmentId>/<threadId>`.
const NOT_A_THREAD = new Set(["draft", "projects", "settings", "kin"]);

const decoded = (part: string | undefined) => {
  if (part === undefined || part === "") return null;
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
};

/**
 * Where an address lands in the Kin web app: null when Kin shows it, else Kin's home, naming the
 * thread when the address was one (`/<environmentId>/<threadId>` or `/threads/…`).
 */
export function kinCodingLanding(
  pathname: string,
): { readonly stray: ScopedThreadRef | null; readonly settings?: true } | null {
  if (KIN_CODING_SETTINGS.has(pathname.replace(/\/$/, ""))) return { stray: null, settings: true };
  if (KIN_KEEPS.some((kept) => pathname === kept || pathname.startsWith(`${kept}/`))) return null;
  const parts = pathname.replace(/\/$/, "").split("/").slice(1);
  const [environmentId, threadId] =
    parts.length === 2 && !NOT_A_THREAD.has(parts[0]!)
      ? [decoded(parts[0]), decoded(parts[1])]
      : parts.length === 3 && parts[0] === "threads"
        ? [decoded(parts[1]), decoded(parts[2])]
        : [null, null];
  return {
    stray:
      environmentId === null || threadId === null
        ? null
        : scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
  };
}

/**
 * Kin has no code mode: in the Kin web app any T3 Code coding address opens Kin's home instead,
 * and a coding settings page opens Kin's Settings.
 */
export function redirectCodingToKin(pathname: string, kinOnly = KIN_WEB_ONLY) {
  if (!kinOnly) return;
  const landing = kinCodingLanding(pathname);
  if (landing === null) return;
  const { stray } = landing;
  throw redirect({
    to: "/kin",
    replace: true,
    ...(landing.settings ? { search: { settings: "" } } : {}),
    ...(stray === null
      ? {}
      : {
          state: {
            kinStrayThread: { environmentId: stray.environmentId, threadId: stray.threadId },
          },
        }),
  });
}

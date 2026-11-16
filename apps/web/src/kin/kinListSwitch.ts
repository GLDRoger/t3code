import {
  kinInboxAttention,
  kinOtherList,
  kinStartListFor,
  NO_KIN_LIST_ATTENTION,
  type KinList,
  type KinListAttention,
} from "@t3tools/client-runtime/kin/kinListSwitch";
import type { KinHost } from "@t3tools/client-runtime/kin/kinHost";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import type { KinDestination } from "@t3tools/client-runtime/kin/kinNavigation";
import type { EnvironmentId } from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import type { AnyRouter } from "@tanstack/react-router";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { isAppModalPage, mainAppReturnHref } from "../components/sidebar/mainAppLocation";
import { ensureClientSettingsHydrated, getClientSettings } from "../hooks/useSettings";
import { registerCommands } from "../shortcuts/dispatcher";
import { environmentPresentations } from "../state/presentation";
import { environmentThreadShells } from "../state/threads";
import { kinClient } from "./kinClient";
import { hasSavedKinHost, kinHostAtom } from "./useKinHost";

const LAST_LIST_STORAGE_KEY = "t3code:kin:lastList";

export function kinListAt(pathname: string): KinList {
  return pathname === "/kin" || pathname.startsWith("/kin/") ? "kin" : "threads";
}

function readLastList(): KinList | null {
  try {
    const value = window.localStorage.getItem(LAST_LIST_STORAGE_KEY);
    return value === "kin" || value === "threads" ? value : null;
  } catch {
    return null;
  }
}

let lastUsed: KinList | null = typeof window === "undefined" ? null : readLastList();
let lastKinHref: string | null = null;
let listBehindModal: KinList = "threads";
let lastKinChatHref: string | null = null;

// Pages under a company that aren't a chat; anything else there is a chat id.
const KIN_NOT_CHAT = new Set([
  "tasks",
  "money",
  "clients",
  "docs",
  "settings",
  "team",
  "memory",
  "work",
]);

/** Which of the five destinations `pathname` is in: a chat, the list or Settings are Chats. */
export function kinDestinationAt(pathname: string): KinDestination | null {
  if (kinListAt(pathname) !== "kin") return null;
  const page = pathname.split("/")[4];
  if (page === "tasks" || page === "money" || page === "clients" || page === "docs") return page;
  return "chats";
}

/** The chat last open, for Chats on a wide window; null before one has been. */
export function kinLastChatHref(): string | null {
  return lastKinChatHref;
}

/**
 * The list on screen at `pathname`. Settings and Usage open over the page they came from, so
 * they keep that page's list instead of swapping the thread list in behind them.
 */
export function kinListShownAt(pathname: string): KinList {
  return isAppModalPage(pathname) ? listBehindModal : kinListAt(pathname);
}

function recordList(list: KinList) {
  if (list === lastUsed) return;
  lastUsed = list;
  try {
    window.localStorage.setItem(LAST_LIST_STORAGE_KEY, list);
  } catch {
    // Storage can be full or blocked; the next launch falls back to threads.
  }
}

/** Where the mark leads from `current`: the other list, back where you left it. */
export function kinListSwitchHref(current: KinList): string {
  return kinOtherList(current) === "kin" ? (lastKinHref ?? "/kin") : mainAppReturnHref();
}

// Before environments connect and answer, the resolver reads `none` or a host it hasn't probed; only a
// connected environment can say whether Kin still runs.
const settledKinHostAtom = Atom.make((get): KinHost => {
  const host = get(kinHostAtom);
  if (host._tag === "host") {
    return host.connected && host.probe._tag !== "pending" ? host : { _tag: "searching" };
  }
  if (host._tag !== "none") return host;
  const anyConnected = [...get(environmentPresentations.presentationsAtom).values()].some(
    (presentation) => presentation.connection.phase === "connected",
  );
  return anyConnected ? host : { _tag: "searching" };
}).pipe(Atom.withLabel("kin:host-settled"));

/**
 * Remembers the last list and Kin chat, and opens a fresh launch to the list the setting picks.
 * Only a launch at `/` is redirected; a deep link or a reload keeps its page.
 */
export function startKinListTracking(
  router: AnyRouter,
  registry: AtomRegistry.AtomRegistry,
): () => void {
  const record = () => {
    const { pathname, href } = router.state.location;
    if (isAppModalPage(pathname)) return;
    const list = kinListAt(pathname);
    listBehindModal = list;
    if (pathname === "/") return;
    if (list === "kin") lastKinHref = href;
    const page = pathname.split("/")[4];
    if (page !== undefined && !KIN_NOT_CHAT.has(page) && pathname.split("/").length === 5)
      lastKinChatHref = href;
    recordList(list);
  };
  record();
  const stopRecording = router.subscribe("onResolved", record);

  let stopBounce = () => {};
  let cancelled = false;
  const openStartList = async () => {
    await ensureClientSettingsHydrated().catch(() => undefined);
    if (cancelled || router.state.location.pathname !== "/") return;
    const start = kinStartListFor({
      setting: getClientSettings().kinStartList,
      lastUsed,
      kinSeen: true,
    });
    if (start !== "kin") return;
    await router.navigate({ to: "/kin", replace: true });
    if (cancelled) return;
    // The saved host may have turned Kin off since; then the launch belongs on threads.
    let settled = false;
    const unsubscribe = registry.subscribe(
      settledKinHostAtom,
      (host) => {
        if (settled || host._tag === "searching") return;
        settled = true;
        stopBounce();
        if (host._tag === "none" && router.state.location.pathname === "/kin") {
          void router.navigate({ to: "/", replace: true });
        }
      },
      { immediate: true },
    );
    stopBounce = unsubscribe;
    if (settled) unsubscribe();
  };
  if (router.state.location.pathname === "/" && hasSavedKinHost()) void openStartList();

  return () => {
    cancelled = true;
    stopRecording();
    stopBounce();
  };
}

/** The switch shortcut; it passes the key on while no host runs Kin. */
export function registerKinListCommands(
  router: AnyRouter,
  registry: AtomRegistry.AtomRegistry,
): () => void {
  const stopDestinations = registerCommands(
    {},
    {
      // Over Kin, ⌘1 to ⌘5 (Ctrl elsewhere) open the destinations in the order the nav shows them.
      // Over threads the digits stay T3's thread jumps; capture runs ahead of the hidden thread list's.
      capture: true,
      when: () => kinListShownAt(router.state.location.pathname) === "kin",
      onKeyDown: (event) => {
        const mod = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
        if (!mod || event.altKey || event.shiftKey || !/^Digit[1-5]$/.test(event.code))
          return false;
        const shown = [...document.querySelectorAll<HTMLElement>("[data-kin-destination]")].filter(
          (element) => element.offsetParent !== null,
        );
        const link = shown[Number(event.code.slice(5)) - 1];
        if (link === undefined) return false;
        event.preventDefault();
        if (!event.repeat) link.click();
      },
    },
  );
  const stopSwitch = registerCommands({
    "kin.switchList": (event) => {
      if (registry.get(kinHostAtom)._tag !== "host") return false;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      void router.navigate({
        href: kinListSwitchHref(kinListShownAt(router.state.location.pathname)),
      });
    },
  });
  return () => {
    stopDestinations();
    stopSwitch();
  };
}

const KIN_LIST_ATTENTION = {
  none: NO_KIN_LIST_ATTENTION,
  unread: { waiting: false, unread: true },
  waiting: { waiting: true, unread: false },
  both: { waiting: true, unread: true },
} as const satisfies Record<string, KinListAttention>;

// One shared object per state, so the mark re-renders only when its dot can change.
function stableAttention(attention: KinListAttention): KinListAttention {
  if (attention.waiting)
    return attention.unread ? KIN_LIST_ATTENTION.both : KIN_LIST_ATTENTION.waiting;
  return attention.unread ? KIN_LIST_ATTENTION.unread : KIN_LIST_ATTENTION.none;
}

/** The Kin inbox's unread and waiting state, read from the inbox stream the chat list uses. */
export const kinInboxAttentionAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): KinListAttention => {
    const result = get(kinClient.inbox({ environmentId, input: {} }));
    return result._tag === "Success"
      ? stableAttention(kinInboxAttention(result.value.value))
      : NO_KIN_LIST_ATTENTION;
  }).pipe(Atom.withLabel(`kin:inbox-attention:${environmentId}`)),
);

/**
 * Coding threads that wait on you: an approval, a question, or a guest message. T3 has no cheap
 * all-thread unread signal; per-thread visits merge server and local watermarks.
 */
export const threadsAttentionAtom = Atom.make((get): KinListAttention => {
  const waiting = get(environmentThreadShells.visibleThreadShellsAtom).some(
    (thread) =>
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      thread.pendingSubagentRequest != null ||
      (thread.pendingGuestMessageCount ?? 0) > 0,
  );
  return waiting ? KIN_LIST_ATTENTION.waiting : KIN_LIST_ATTENTION.none;
}).pipe(Atom.withLabel("kin:threads-attention"));

/** How many unread messages the Kin inbox holds, for the badge on Chats. */
export const kinInboxUnreadAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): number => {
    const result = get(kinClient.inbox({ environmentId, input: {} }));
    return result._tag === "Success" ? selectKinInboxView(result.value.value).unreadCount : 0;
  }).pipe(Atom.withLabel(`kin:inbox-unread:${environmentId}`)),
);

export const noAttentionAtom = Atom.make(NO_KIN_LIST_ATTENTION).pipe(
  Atom.withLabel("kin:no-attention"),
);

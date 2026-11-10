import {
  kinInboxAttention,
  kinOtherList,
  kinStartListFor,
  NO_KIN_LIST_ATTENTION,
  type KinList,
  type KinListAttention,
} from "@t3tools/client-runtime/kin/kinListSwitch";
import type { KinHost } from "@t3tools/client-runtime/kin/kinHost";
import type { EnvironmentId } from "@t3tools/contracts";
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
    if (pathname === "/" || isAppModalPage(pathname)) return;
    const list = kinListAt(pathname);
    if (list === "kin") lastKinHref = href;
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
  return registerCommands({
    "kin.switchList": (event) => {
      if (registry.get(kinHostAtom)._tag !== "host") return false;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      void router.navigate({
        href: kinListSwitchHref(kinListAt(router.state.location.pathname)),
      });
    },
  });
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

export const noAttentionAtom = Atom.make(NO_KIN_LIST_ATTENTION).pipe(
  Atom.withLabel("kin:no-attention"),
);

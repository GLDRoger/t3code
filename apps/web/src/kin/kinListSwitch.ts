import {
  kinInboxAttention,
  NO_KIN_LIST_ATTENTION,
  type KinList,
  type KinListAttention,
} from "@t3tools/client-runtime/kin/kinListSwitch";
import type { KinHost } from "@t3tools/client-runtime/kin/kinHost";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import type { KinDestination } from "@t3tools/client-runtime/kin/kinNavigation";
import {
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type EnvironmentId,
  type KeybindingCommand,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import type { AnyRouter } from "@tanstack/react-router";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { resolveShortcutCommand } from "../keybindings";
import { registerCommands } from "../shortcuts/dispatcher";
import { environmentPresentations } from "../state/presentation";
import { primaryServerKeybindingsAtom } from "../state/server";
import { kinClient } from "./kinClient";
import { KIN_PLACE_PATH } from "./kinPlaces";
import type { KinWorkTarget } from "./useKinWork";
import { hasSavedKinHost, kinHostAtom, kinHostTarget } from "./useKinHost";
import { kinPlacesAtom } from "./kinPlacesAtom";

export function kinListAt(pathname: string): KinList {
  return pathname === "/kin" || pathname.startsWith("/kin/") ? "kin" : "threads";
}

let lastKinHref: string | null = null;
let listBehindModal: KinList = "threads";
// The chat last open, for Chats on a wide window; null before one has been.
// With its host: every host uses the same org id, so a chat id means nothing on another one.
let lastKinChat: { readonly environmentId: string; readonly chatId: string } | null = null;

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

/**
 * The list on screen at `pathname`. Settings and Usage open over the page they came from, so
 * they keep that page's list instead of swapping the thread list in behind them.
 */
export function kinListShownAt(pathname: string): KinList {
  return isAppModalPage(pathname) ? listBehindModal : kinListAt(pathname);
}

/** The way back into Kin: the Kin page last open, or Kin's home. */
export function kinReturnHref(): string {
  return lastKinHref ?? "/kin";
}

/** T3's keys for coding threads and project files; Kin has neither, so over Kin they do nothing. */
const CODING_COMMANDS: ReadonlySet<KeybindingCommand> = new Set([
  "chat.new",
  "chat.newLocal",
  "chat.newWithoutProject",
  "thread.previous",
  "thread.next",
  "view.reopenClosed",
  "filePicker.toggle",
  "projectSearch.toggle",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
]);

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
 * Remembers the last Kin page and chat, and always opens a fresh launch to Kin while a host runs it.
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
    const [, , environmentId, , page] = pathname.split("/");
    if (
      environmentId !== undefined &&
      page !== undefined &&
      !KIN_NOT_CHAT.has(page) &&
      pathname.split("/").length === 5
    )
      lastKinChat = { environmentId, chatId: page };
  };
  record();
  const stopRecording = router.subscribe("onResolved", record);

  let stopSettle = () => {};
  let cancelled = false;
  const whenSettled = (onSettled: (host: KinHost) => void) => {
    let settled = false;
    const unsubscribe = registry.subscribe(
      settledKinHostAtom,
      (host) => {
        if (settled || host._tag === "searching") return;
        settled = true;
        stopSettle();
        onSettled(host);
      },
      { immediate: true },
    );
    stopSettle = unsubscribe;
    if (settled) unsubscribe();
  };
  const openStartList = async () => {
    if (cancelled || router.state.location.pathname !== "/") return;
    await router.navigate({ to: "/kin", replace: true });
    if (cancelled) return;
    // The saved host may have turned Kin off since; then the launch belongs on threads.
    whenSettled((host) => {
      if (host._tag === "none" && router.state.location.pathname === "/kin") {
        void router.navigate({ to: "/", replace: true });
      }
    });
  };
  if (router.state.location.pathname === "/") {
    if (hasSavedKinHost()) void openStartList();
    // A host first found during this launch still opens it to Kin.
    else
      whenSettled((host) => {
        if (host._tag === "host" && router.state.location.pathname === "/") {
          void router.navigate({ to: "/kin", replace: true });
        }
      });
  }

  return () => {
    cancelled = true;
    stopRecording();
    stopSettle();
  };
}

/** Kin's shortcuts, and the coding ones closed over Kin; all pass the key on while no host runs Kin. */
export function registerKinListCommands(
  router: AnyRouter,
  registry: AtomRegistry.AtomRegistry,
): () => void {
  const keybindings = () => registry.get(primaryServerKeybindingsAtom);
  const stopCoding = registerCommands(
    {},
    {
      // Capture runs ahead of the hidden thread list's listener; the destinations below run first.
      capture: true,
      when: () =>
        registry.get(kinHostAtom)._tag === "host" &&
        kinListShownAt(router.state.location.pathname) === "kin",
      onKeyDown: (event) => {
        const command = resolveShortcutCommand(event, keybindings());
        if (command === null || !CODING_COMMANDS.has(command)) return false;
        event.preventDefault();
      },
    },
  );
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
        const index = Number(event.code.slice(5)) - 1;
        const link = shown[index];
        // A narrow window's sidebar sheet hides its links while closed, so go by the nav's places.
        const target = link === undefined ? kinHostTarget(registry.get(kinHostAtom)) : null;
        const destination =
          target === null ? undefined : registry.get(kinPlacesAtom(target)).destinations[index];
        const go =
          link !== undefined
            ? () => link.click()
            : target !== null && destination !== undefined
              ? () => void router.navigate(kinDestinationLink(destination, target, true))
              : null;
        if (go === null) return false;
        event.preventDefault();
        if (!event.repeat) go();
      },
    },
  );
  const stopSwitch = registerCommands(
    {
      "kin.switchList": (event) => {
        // Kin doesn't offer the coding threads, so the shortcut only leads back into Kin.
        if (registry.get(kinHostAtom)._tag !== "host") return false;
        if (kinListShownAt(router.state.location.pathname) === "kin") return false;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        void router.navigate({ href: kinReturnHref() });
      },
    },
    { keybindings },
  );
  return () => {
    stopDestinations();
    stopCoding();
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

/** Where a destination opens; the nav and the command palette both go through it. */
export function kinDestinationLink(
  destination: KinDestination,
  target: KinWorkTarget,
  narrow = false,
) {
  if (destination !== "chats") return { to: KIN_PLACE_PATH[destination], params: target } as const;
  // A wide window shows the list beside the chat, so Chats comes back to the chat you left.
  const chatId =
    narrow || lastKinChat?.environmentId !== target.environmentId ? null : lastKinChat.chatId;
  return chatId === null
    ? ({ to: "/kin" } as const)
    : ({ to: "/kin/$environmentId/$orgId/$chatId", params: { ...target, chatId } } as const);
}

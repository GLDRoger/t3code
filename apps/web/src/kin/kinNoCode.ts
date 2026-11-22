import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { KIN_INVITE_LINK_PATH } from "@t3tools/shared/remote";
import { redirect } from "@tanstack/react-router";

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
): { readonly stray: ScopedThreadRef | null } | null {
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

/** Kin has no code mode: in the Kin web app any T3 Code coding address opens Kin's home instead. */
export function redirectCodingToKin(pathname: string, kinOnly = KIN_WEB_ONLY) {
  if (!kinOnly) return;
  const landing = kinCodingLanding(pathname);
  if (landing === null) return;
  const { stray } = landing;
  throw redirect({
    to: "/kin",
    replace: true,
    ...(stray === null
      ? {}
      : {
          state: {
            kinStrayThread: { environmentId: stray.environmentId, threadId: stray.threadId },
          },
        }),
  });
}

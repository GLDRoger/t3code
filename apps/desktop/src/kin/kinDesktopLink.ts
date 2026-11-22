import {
  getPairingTokenFromUrl,
  readHostedPairingRequest,
  readKinJoinLink,
  readPairingAppLink,
} from "@t3tools/shared/remote";

export type KinDesktopLink =
  | { readonly _tag: "Link"; readonly url: string; readonly origin: string }
  | { readonly _tag: "NotALink" }
  | { readonly _tag: "Insecure" };

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A device link on the host's own address: `/pair#token=…`, bare or in a `kin://pair` link. */
function readPairLink(text: string): string | null {
  for (const word of text.split(/\s+/)) {
    const candidate = word.replace(/^[<("']+|[>)"',.;]+$/g, "");
    const inner = readPairingAppLink(candidate) ?? candidate;
    if (!URL.canParse(inner)) continue;
    const url = new URL(inner);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.pathname === "/pair" &&
      getPairingTokenFromUrl(url) !== null &&
      readHostedPairingRequest(url) === null
    ) {
      return url.toString();
    }
  }
  return null;
}

/**
 * The link a Kin host makes to sign a device in, found in pasted text or an app link: a
 * teammate's join link or a link for another device. Plain http is refused off this machine.
 */
export function readKinDesktopLink(text: string): KinDesktopLink {
  const found = readKinJoinLink(text) ?? readPairLink(text);
  if (found === null) return { _tag: "NotALink" };
  const url = new URL(found);
  if (url.protocol !== "https:" && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return { _tag: "Insecure" };
  }
  return { _tag: "Link", url: url.toString(), origin: url.origin };
}

/**
 * Where a page in the main window may send it: the team's host, or the system browser. Only the
 * main process opens the app's own pages, so a page asking for one is refused.
 */
export function kinShellNavigation(input: {
  readonly url: string;
  readonly hostOrigin: string | null;
  readonly isAppPage: (url: string) => boolean;
}): "stay" | "outside" | "refuse" {
  if (input.isAppPage(input.url)) return "refuse";
  if (!URL.canParse(input.url)) return "refuse";
  const url = new URL(input.url);
  if (input.hostOrigin !== null && url.origin === input.hostOrigin) return "stay";
  return url.protocol === "https:" || url.protocol === "http:" ? "outside" : "refuse";
}

/** Kin's own home on the team's host; the host's bare root is T3 Code's, which an owner can reach. */
export function kinTeamHome(origin: string): string {
  return new URL("/kin", origin).toString();
}

/** A top-level load of the team host's bare root goes to Kin's home instead. */
export function kinShellRootRedirect(url: string, hostOrigin: string | null): string | null {
  if (hostOrigin === null || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  return parsed.origin === hostOrigin && parsed.pathname === "/" ? kinTeamHome(hostOrigin) : null;
}

const HOST_PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write"]);

/** Kin's web app asks for alerts and for copying links; nothing else touches this computer. */
export function kinShellAllowsPermission(input: {
  readonly permission: string;
  readonly requestingUrl: string;
  readonly hostOrigin: string | null;
}): boolean {
  return (
    input.hostOrigin !== null &&
    HOST_PERMISSIONS.has(input.permission) &&
    URL.canParse(input.requestingUrl) &&
    new URL(input.requestingUrl).origin === input.hostOrigin
  );
}

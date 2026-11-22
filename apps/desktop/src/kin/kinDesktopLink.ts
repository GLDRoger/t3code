import {
  getPairingTokenFromUrl,
  KIN_INVITE_LINK_PATH,
  readHashParams,
} from "@t3tools/shared/remote";

import { isAppScheme } from "./appPage.ts";

export type KinDesktopLink =
  | { readonly _tag: "Link"; readonly url: string; readonly origin: string }
  | { readonly _tag: "NotALink" }
  | { readonly _tag: "Insecure" }
  | { readonly _tag: "Ambiguous" };

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PAIR_PATH = "/pair";
const PAIR_TOKEN_PARAM = "token";
const SPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f]/;
const NOT_A_LINK = { _tag: "NotALink" } as const;

const onlyKeys = (params: URLSearchParams, allowed: string) =>
  [...params.keys()].every((key) => key === allowed);

/**
 * One join or device link, exactly as a Kin host makes it, in the form the window loads: an
 * invite keeps its secret in the fragment, and a device link's token moves to the fragment so it
 * never reaches a request line. Anything else in the link, or a name and password, is refused.
 */
function readTarget(raw: string): KinDesktopLink {
  if (SPACE_OR_CONTROL.test(raw) || !/^https?:\/\//i.test(raw) || !URL.canParse(raw)) {
    return NOT_A_LINK;
  }
  const url = new URL(raw);
  if (url.username !== "" || url.password !== "") return NOT_A_LINK;
  let target: URL;
  if (url.pathname === KIN_INVITE_LINK_PATH) {
    if (url.search !== "" || url.hash.slice(1).trim() === "") return NOT_A_LINK;
    if (getPairingTokenFromUrl(url) !== null) return NOT_A_LINK;
    target = url;
  } else if (url.pathname === PAIR_PATH) {
    const query = url.searchParams;
    const fragment = readHashParams(url);
    const tokens = [...query.getAll(PAIR_TOKEN_PARAM), ...fragment.getAll(PAIR_TOKEN_PARAM)];
    const token = tokens[0]?.trim() ?? "";
    if (tokens.length !== 1 || token === "") return NOT_A_LINK;
    if (!onlyKeys(query, PAIR_TOKEN_PARAM) || !onlyKeys(fragment, PAIR_TOKEN_PARAM)) {
      return NOT_A_LINK;
    }
    target = new URL(PAIR_PATH, url.origin);
    target.hash = new URLSearchParams([[PAIR_TOKEN_PARAM, token]]).toString();
  } else {
    return NOT_A_LINK;
  }
  if (target.protocol !== "https:" && !LOOPBACK_HOSTNAMES.has(target.hostname)) {
    return { _tag: "Insecure" };
  }
  return { _tag: "Link", url: target.toString(), origin: target.origin };
}

/** The one link inside the app's own `kin://kin/join?link=…` or `kin://pair?pairingUrl=…`. */
function readWrapped(url: URL): KinDesktopLink {
  const param =
    url.host === "kin" && url.pathname === "/join"
      ? "link"
      : url.host === "pair" && (url.pathname === "" || url.pathname === "/")
        ? "pairingUrl"
        : null;
  if (param === null || url.username !== "" || url.password !== "" || url.hash !== "") {
    return NOT_A_LINK;
  }
  const values = url.searchParams.getAll(param);
  if (values.length !== 1 || !onlyKeys(url.searchParams, param)) return NOT_A_LINK;
  return readTarget(values[0] ?? "");
}

/** The app's own link shape, which the operating system hands over; other app links are not Kin's. */
export function isKinOsLink(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    isAppScheme(url.protocol) &&
    ((url.host === "kin" && url.pathname === "/join") || url.host === "pair")
  );
}

/**
 * A link the operating system handed over (`kin://kin/join?link=…`, `kin://pair?…`): exactly one
 * wrapper holding exactly one target, with nothing to hide which host it names.
 */
export function readKinOsLink(value: string): KinDesktopLink {
  if (SPACE_OR_CONTROL.test(value) || !isKinOsLink(value)) return NOT_A_LINK;
  return readWrapped(new URL(value));
}

/**
 * The link a Kin host makes to sign a device in, found in pasted text: a teammate's join link or
 * a link for another device, bare or wrapped once for the app. Two different links are refused
 * rather than guessed between. Plain http is refused off this machine.
 */
export function readKinDesktopLink(text: string): KinDesktopLink {
  const found = new Map<string, KinDesktopLink>();
  for (const word of text.split(/\s+/)) {
    const candidate = word.replace(/^[<("']+|[>)"',.;]+$/g, "");
    if (!URL.canParse(candidate)) continue;
    const url = new URL(candidate);
    const read = isAppScheme(url.protocol) ? readWrapped(url) : readTarget(candidate);
    if (read._tag === "Link") found.set(read.url, read);
    else if (read._tag === "Insecure") found.set(candidate, read);
  }
  const [first, ...rest] = found.values();
  if (first === undefined) return NOT_A_LINK;
  return rest.length === 0 ? first : { _tag: "Ambiguous" };
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

/** How long after a click or Enter a navigation counts as the person's; a link opens in ms. */
export const KIN_PERSON_ACTION_MS = 1_000;

/**
 * Whether an address outside the team's host opens in the system browser. A click or Enter in the
 * window just before counts as the person's; a page acting alone opens nothing. A server redirect
 * after a click may not be what the person chose, so it is asked about.
 */
export function kinShellOutsideOpen(input: {
  readonly cause: "navigate" | "new-window" | "redirect";
  readonly sincePersonAction: number;
}): "open" | "ask" | "block" {
  if (input.sincePersonAction > KIN_PERSON_ACTION_MS || input.sincePersonAction < 0) {
    return "block";
  }
  return input.cause === "redirect" ? "ask" : "open";
}

export type KinSessionProbe = "signed-in" | "signed-out" | "unreachable";

/** Only a direct answer from the team's own host says whether this computer is signed in. */
export function kinShellSessionProbe(input: {
  readonly origin: string;
  readonly response: {
    readonly status: number;
    readonly url: string;
    readonly redirected: boolean;
    readonly body: unknown;
  } | null;
}): KinSessionProbe {
  const { response } = input;
  if (response === null || response.redirected || response.status < 200 || response.status > 299) {
    return "unreachable";
  }
  if (!URL.canParse(response.url) || new URL(response.url).origin !== input.origin) {
    return "unreachable";
  }
  const body = response.body;
  if (typeof body !== "object" || body === null || !("authenticated" in body)) {
    return "unreachable";
  }
  if (body.authenticated === true) return "signed-in";
  return body.authenticated === false ? "signed-out" : "unreachable";
}

/** What the host's answer to redeeming a link means; `null` is a dropped connection. */
export function kinShellRedeemResult(
  status: number | null,
): "joined" | "limit" | "try-again" | "spent" {
  if (status === null || status >= 500) return "try-again";
  if (status >= 200 && status < 300) return "joined";
  return status === 409 ? "limit" : "spent";
}

const CRASH_WINDOW_MS = 60_000;
const CRASH_RELOADS = 3;

/** A crashed page reloads a few times a minute at most; then the person gets the local page. */
export function kinShellCrashReload(
  crashes: ReadonlyArray<number>,
  now: number,
): { readonly reload: boolean; readonly crashes: ReadonlyArray<number> } {
  const recent = [...crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
  return { reload: recent.length <= CRASH_RELOADS, crashes: recent };
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

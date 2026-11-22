import { DESKTOP_HOST, getDesktopScheme } from "../electron/ElectronProtocol.ts";

const APP_PAGE_PROTOCOLS = new Set([`${getDesktopScheme(false)}:`, `${getDesktopScheme(true)}:`]);

/** The app's own pages; the main window can show another origin, which gets no IPC. */
export function isAppPageUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return APP_PAGE_PROTOCOLS.has(url.protocol) && url.host === DESKTOP_HOST;
}

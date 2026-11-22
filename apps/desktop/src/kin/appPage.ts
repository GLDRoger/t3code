// Kept free of imports so the sandboxed preload and the main process share this exact test. The
// literals match ElectronProtocol.ts, and branding rewrites both (DesktopIpc.kin.test.ts pins it).
const DESKTOP_PRODUCTION_SCHEME = "t3code";
const DESKTOP_DEVELOPMENT_SCHEME = "t3code-dev";
const APP_HOST = "app";

const APP_ORIGINS = new Set([
  `${DESKTOP_PRODUCTION_SCHEME}://${APP_HOST}`,
  `${DESKTOP_DEVELOPMENT_SCHEME}://${APP_HOST}`,
]);

/** The schemes of the app's own links, `kin://kin/join?…` and `kin://pair?…` once branded. */
export function isAppScheme(protocol: string): boolean {
  return (
    protocol === `${DESKTOP_PRODUCTION_SCHEME}:` || protocol === `${DESKTOP_DEVELOPMENT_SCHEME}:`
  );
}

/** The app's own pages; the main window can show another origin, which gets no IPC. */
export function isAppPageUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return isAppScheme(url.protocol) && url.host === APP_HOST;
}

/** A frame's committed security origin, as Chromium serializes it, is the app's own. */
export function isAppPageOrigin(origin: string): boolean {
  return APP_ORIGINS.has(origin);
}

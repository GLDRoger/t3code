import { KIN_DEVICE_BROWSER_RENEW_ROUTE } from "@t3tools/contracts";

const RENEW_EVERY_MS = 24 * 60 * 60 * 1000;
let lastAskedAt: number | null = null;

/**
 * Keeps a teammate's browser session from running out while it is in use: the host answers with a
 * fresh cookie. Asked on the first load and then at most once a day; a session that isn't a
 * renewable teammate's (401/403) or a failed request changes nothing, so neither is reported.
 */
export function renewKinBrowserSession(now: number = Date.now()): void {
  if (lastAskedAt !== null && now - lastAskedAt < RENEW_EVERY_MS) return;
  lastAskedAt = now;
  void fetch(KIN_DEVICE_BROWSER_RENEW_ROUTE, { method: "POST", credentials: "same-origin" }).catch(
    () => undefined,
  );
}

import { KIN_DEVICE_BROWSER_RENEW_ROUTE } from "@t3tools/contracts";

const RENEW_EVERY_MS = 24 * 60 * 60 * 1000;
let lastAskedAt: number | null = null;
let watching = false;

/**
 * Keeps a teammate's browser session from running out while it is in use: the host answers with a
 * fresh cookie. Asked on the first load, then at most once a day when the tab is shown again. A session that isn't a
 * renewable teammate's (401/403) settles it for the day; a failed request asks again next load.
 */
export function renewKinBrowserSession(now: number = Date.now()): void {
  if (!watching) {
    watching = true;
    // A tab left open for weeks asks again whenever it is looked at.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") renewKinBrowserSession();
    });
  }
  if (lastAskedAt !== null && now - lastAskedAt < RENEW_EVERY_MS) return;
  lastAskedAt = now;
  const retry = () => {
    if (lastAskedAt === now) lastAskedAt = null;
  };
  void fetch(KIN_DEVICE_BROWSER_RENEW_ROUTE, { method: "POST", credentials: "same-origin" }).then(
    (response) => {
      if (!response.ok && response.status !== 401 && response.status !== 403) retry();
    },
    retry,
  );
}

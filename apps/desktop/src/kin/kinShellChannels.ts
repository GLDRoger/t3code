export const KIN_SHELL_STATE_CHANNEL = "kin-shell:state";
export const KIN_SHELL_JOIN_CHANNEL = "kin-shell:join";
export const KIN_SHELL_RETRY_CHANNEL = "kin-shell:retry";
export const KIN_SHELL_USE_DIFFERENT_LINK_CHANNEL = "kin-shell:use-different-link";
export const KIN_SHELL_BACK_CHANNEL = "kin-shell:back";

/**
 * T3 Code's sign-in (`@clerk/electron`) answers any window's main frame, whatever page it shows.
 * Kin's build never creates it (KinOsLinks.ts); the shell still removes these before it shows
 * anything, in case a library registers them some other way.
 */
export const CLERK_CHANNELS = [
  "clerk:token-cache:get",
  "clerk:token-cache:save",
  "clerk:token-cache:clear",
  "clerk:oauth-transport:get-redirect-url",
  "clerk:oauth-transport:open",
  "clerk:passkeys:create",
  "clerk:passkeys:get",
  "clerk:passkeys:capabilities",
] as const;

/** electron-store's renderer hook, which Clerk's storage installs; it answers with the data folder. */
export const ELECTRON_STORE_CHANNEL = "electron-store-get-data";

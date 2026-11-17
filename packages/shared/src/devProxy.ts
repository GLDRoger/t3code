/** Vite's proxy and the server's dev 404 handler must share prefixes to avoid index.html responses or redirect loops. Vite takes the first match, so specific prefixes go first. */
export const DEV_PROXIED_PATH_PREFIXES = [
  "/api/kin/github-app",
  "/api",
  "/oauth",
  "/.well-known",
  "/ws",
  "/mcp",
] as const;

/**
 * Preserve origins for OAuth metadata validation, /ws cookie-session Origin/Host checks, and the
 * GitHub App manifest's return address, which must be the browser's origin.
 */
export const DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES: ReadonlySet<string> = new Set([
  "/api/kin/github-app",
  "/oauth",
  "/.well-known",
  "/mcp",
  "/ws",
]);

export function isDevProxiedPath(pathname: string): boolean {
  return DEV_PROXIED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

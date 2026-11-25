// Kin's build step rewrites this literal, as it does apps/desktop/src/kin/KinDesktopOnly.ts.
const KIN_DESKTOP_BUILD: string = "kin-desktop:off";
const KIN_DESKTOP_ONLY = KIN_DESKTOP_BUILD === "kin-desktop:on";

const WEB_SCHEMES = new Set(["http", "https"]);

/**
 * Kin's desktop window opens only its team's links (`kin://`), so the Kin build never registers
 * as a web browser: no http/https handler and no HTML document type. T3 Code's build is unchanged.
 */
export function kinDesktopMac<
  T extends {
    readonly extendInfo: Record<string, unknown>;
    readonly protocols: ReadonlyArray<{ readonly schemes: ReadonlyArray<string> }>;
  },
>(mac: T): T {
  if (!KIN_DESKTOP_ONLY) return mac;
  const { CFBundleDocumentTypes: _webPages, ...extendInfo } = mac.extendInfo;
  return {
    ...mac,
    extendInfo,
    protocols: mac.protocols.filter(
      (protocol) => !protocol.schemes.some((scheme) => WEB_SCHEMES.has(scheme)),
    ),
  };
}

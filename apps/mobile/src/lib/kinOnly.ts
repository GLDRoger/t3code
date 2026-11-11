// The Kin build's branding step rewrites this literal, here and in app.config.ts (branding/rules.yaml).
const KIN_ONLY_BUILD: string = "kin-only:off";

/**
 * A build that is Kin and nothing else: no coding threads, tabs or settings. Fixed when the app
 * is built, so it never changes under a running app. `EXPO_PUBLIC_KIN_ONLY=1` turns it on for dev.
 */
export const KIN_ONLY =
  KIN_ONLY_BUILD === "kin-only:on" || process.env.EXPO_PUBLIC_KIN_ONLY === "1";

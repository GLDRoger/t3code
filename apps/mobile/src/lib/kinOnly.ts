// The Kin build's branding step rewrites this literal (branding/rules.yaml); app.config.ts reads it here.
const KIN_ONLY_BUILD: string = "kin-only:off";

/** Whether this is the Kin build itself, before any dev override. */
export const KIN_ONLY_BUILT = KIN_ONLY_BUILD === "kin-only:on";

/**
 * A build that is Kin and nothing else: no coding threads, tabs or settings. Fixed when the app
 * is built, so it never changes under a running app. `EXPO_PUBLIC_KIN_ONLY=1` turns it on for dev.
 */
export const KIN_ONLY = KIN_ONLY_BUILT || process.env.EXPO_PUBLIC_KIN_ONLY === "1";

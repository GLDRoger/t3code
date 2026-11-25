// The Kin build's branding step rewrites this literal (branding/rules.yaml, scope web).
const KIN_WEB_BUILD: string = "kin-web:off";

/**
 * The Kin web app, which has no coding threads: T3 Code's thread, draft, project and pull request
 * screens are never shown, whatever a link or a reload asks for. Fixed when the app is built.
 * `VITE_KIN_WEB_ONLY=1` turns it on for dev.
 */
export const KIN_WEB_ONLY =
  KIN_WEB_BUILD === "kin-web:on" || import.meta.env.VITE_KIN_WEB_ONLY === "1";

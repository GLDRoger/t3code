// Kin's build step rewrites this literal (branding/rules.yaml), as the phone's kinOnly.ts does.
const KIN_DESKTOP_BUILD: string = "kin-desktop:off";

/**
 * A desktop build that is Kin and nothing else: a window on the team's own Kin host, joined with
 * a link. No bundled server, no projects, no provider set-up. Fixed when the app is built.
 */
export const KIN_DESKTOP_ONLY = KIN_DESKTOP_BUILD === "kin-desktop:on";

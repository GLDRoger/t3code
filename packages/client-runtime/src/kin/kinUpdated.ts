export const KIN_UPDATED_LINE = "Kin was updated. Reload to get the latest.";
export const KIN_UPDATED_RELOAD = "Reload";
/** In place of a page whose code the update replaced, once the one automatic reload is spent. */
export const KIN_UPDATED_CONTINUE = { title: "Kin was updated.", detail: "Reload to continue." };

export type KinUpdatedAction = "none" | "reload" | "notice";

/**
 * Whether a page on an older web build than its server's reloads now, says so, or does nothing.
 * It reloads only when nothing would be lost; after the notice, only once hidden, so a reload never
 * lands under someone's pointer. A page already reloaded for this build says so instead of looping.
 */
export function kinUpdatedAction(input: {
  readonly dev: boolean;
  readonly pageBuild: string | null;
  readonly serverBuild: string | undefined;
  readonly busy: boolean;
  readonly hidden: boolean;
  readonly noticeShown: boolean;
  readonly reloadedFor: string | null;
}): KinUpdatedAction {
  const { pageBuild, serverBuild } = input;
  if (input.dev || pageBuild === null || serverBuild === undefined) return "none";
  if (pageBuild === serverBuild || pageBuild.endsWith(`/${serverBuild}`)) return "none";
  if (input.busy || input.reloadedFor === serverBuild) return "notice";
  if (input.noticeShown && !input.hidden) return "notice";
  return "reload";
}

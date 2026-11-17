import { KIN_ACCESS_ENDED } from "@t3tools/client-runtime/kin/kinJoin";

const KEY = "t3code:kin:teammate";

/**
 * Remembers whether this browser was signed in as a Kin teammate, so once that session ends
 * (removed, or signed out by the owner) it says so instead of asking for a pairing token.
 */
export function rememberKinTeammate(teammate: boolean) {
  try {
    if (teammate) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage off: the pairing page is the fallback.
  }
}

export function wasKinTeammate() {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** A screen that can't tell who you are says your access ended, when this was a teammate's. */
export function kinAccessCopy(
  tag: string,
  copy: { readonly title: string; readonly detail: string },
) {
  return (tag === "noIdentity" || tag === "unauthorized") && wasKinTeammate()
    ? KIN_ACCESS_ENDED
    : copy;
}

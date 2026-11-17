import { kinAccessEndedCopy } from "@t3tools/client-runtime/kin/kinJoin";

const KEY = "t3code:kin:teammate";

/**
 * Remembers whether this browser was signed in as a Kin teammate, so once that session ends
 * (removed, or signed out by the owner) it says so instead of asking for a pairing token.
 */
export function rememberKinTeammate(teammate: boolean | "left") {
  try {
    if (teammate !== false) window.localStorage.setItem(KEY, teammate === "left" ? "left" : "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage off: the pairing page is the fallback.
  }
}

function mark() {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function wasKinTeammate() {
  const was = mark();
  return was === "1" || was === "left";
}

/** Why this browser has no session: they left the team here, or their access ended. */
export const kinAccessEnded = () => kinAccessEndedCopy("browser", mark() === "left");

/** A screen that can't tell who you are says your access ended, when this was a teammate's. */
export function kinAccessCopy(
  tag: string,
  copy: { readonly title: string; readonly detail: string },
) {
  return (tag === "noIdentity" || tag === "unauthorized") && wasKinTeammate()
    ? kinAccessEnded()
    : copy;
}

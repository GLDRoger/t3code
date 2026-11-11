import { KIN_ONLY } from "../../../lib/kinOnly";
import { readKinAppShell, useKinAppShell } from "./kinChatOnly";

/**
 * Whether Home is the Kin chat list and its tabs, with no coding workspace under it: always in a
 * Kin-only build, and on a phone that holds nothing but a teammate's session.
 */
export function useKinIsHome(): boolean {
  const shell = useKinAppShell();
  return KIN_ONLY || shell === "chatOnly";
}

export function readKinIsHome(): boolean {
  return KIN_ONLY || readKinAppShell() === "chatOnly";
}

/** The route that shows the chat list: Home where Kin is home, its own page over coding threads otherwise. */
export function kinListRoute(): "Home" | "KinChats" {
  return readKinIsHome() ? "Home" : "KinChats";
}

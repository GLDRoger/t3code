import { useAtomValue } from "@effect/atom-react";
import { installForPhoneHome, kinPhoneHome } from "@t3tools/client-runtime/kin/kinListSwitch";
import { AsyncResult, Atom } from "effect/reactivity";

import { KIN_ONLY } from "../../../lib/kinOnly";
import { appAtomRegistry } from "../../../state/atom-registry";
import { kinAppShellAtom } from "./kinChatOnly";
import { kinHostAtom, savedKinHostAtom } from "./useKinHost";

const kinHomeAtom = Atom.make((get) => {
  const saved = get(savedKinHostAtom);
  return kinPhoneHome({
    kinOnly: KIN_ONLY,
    shell: get(kinAppShellAtom),
    host: get(kinHostAtom)._tag,
    savedHost: saved._tag === "Initial" ? null : AsyncResult.getOrElse(saved, () => null) !== null,
  });
}).pipe(Atom.withLabel("kin:home"));

/** What Home is: Kin's chat list and its tabs, or the coding workspace; "loading" until known. */
export function useKinHome(): "loading" | "kin" | "coding" {
  return useAtomValue(kinHomeAtom);
}

/**
 * Whether Home is the Kin chat list and its tabs, with no coding workspace under it: always in a
 * Kin-only build, and wherever a host runs Kin.
 */
export function useKinIsHome(): boolean {
  return useKinHome() === "kin" || KIN_ONLY;
}

export function readKinIsHome(): boolean {
  return appAtomRegistry.get(kinHomeAtom) === "kin" || KIN_ONLY;
}

/** Whether Kin is Home, once this device has read what it saved. */
export function whenKinIsHomeKnown(): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let done = false;
    const read = (home: "loading" | "kin" | "coding") => {
      if (done || home === "loading") return;
      done = true;
      unsubscribe?.();
      resolve(home === "kin" || KIN_ONLY);
    };
    unsubscribe = appAtomRegistry.subscribe(kinHomeAtom, read, { immediate: true });
    if (done) unsubscribe();
  });
}

/** App-lifetime: runs `kin` where Kin is Home (always in a Kin-only build) and `coding` elsewhere. */
export function installForKinHome(installs: {
  readonly kin: () => () => void;
  readonly coding: () => () => void;
}): () => void {
  if (KIN_ONLY) return installs.kin();
  return installForPhoneHome(
    (onHome) => appAtomRegistry.subscribe(kinHomeAtom, onHome, { immediate: true }),
    installs,
  );
}

/** The route that shows the chat list: Home where Kin is home, its own page over coding threads otherwise. */
export function kinListRoute(): "Home" | "KinChats" {
  return readKinIsHome() ? "Home" : "KinChats";
}

const homeShellAtom = Atom.make((get) => {
  const home = get(kinHomeAtom);
  const shell = get(kinAppShellAtom);
  return home === "loading" || shell === "loading" ? null : `${home}:${shell}`;
});

/**
 * Home is a different screen in each shell, and a route keeps the bar its last screen set. When
 * Home changes under a running app (a first join, a host turning Kin on or off, leaving the last
 * team), start Home afresh.
 */
export function installKinShellReset(resetToHome: () => void): () => void {
  let last = appAtomRegistry.get(homeShellAtom);
  return appAtomRegistry.subscribe(homeShellAtom, (next) => {
    const changed = last !== null && next !== null && next !== last;
    last = next;
    if (changed) resetToHome();
  });
}

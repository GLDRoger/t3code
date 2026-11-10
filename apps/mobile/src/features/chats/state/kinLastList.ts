import { kinStartListFor, type KinList } from "@t3tools/client-runtime/kin/kinListSwitch";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../../connection/runtime";
import * as MobileSecureStorage from "../../../persistence/mobile-secure-storage";
import { appAtomRegistry } from "../../../state/atom-registry";
import { savedKinHostAtom } from "./useKinHost";

const KIN_LAST_LIST_KEY = "kin.lastList";

const lastKinListAtom = connectionAtomRuntime.atom(
  MobileSecureStorage.MobileSecureStorage.pipe(
    Effect.flatMap((storage) => storage.getItem(KIN_LAST_LIST_KEY)),
    Effect.map((list): KinList | null => (list === "kin" || list === "threads" ? list : null)),
    Effect.orElseSucceed(() => null),
  ),
);

/** Saves the list the owner is looking at, so the next launch opens to it. */
export const rememberKinListAtom = connectionAtomRuntime.fn((list: KinList) =>
  MobileSecureStorage.MobileSecureStorage.pipe(
    Effect.flatMap((storage) => storage.setItem(KIN_LAST_LIST_KEY, list)),
    Effect.catch(() => Effect.logWarning("Saving the last Kin list failed")),
  ),
);

const startListAtom = Atom.make((get): KinList | null => {
  const last = get(lastKinListAtom);
  const saved = get(savedKinHostAtom);
  if (last._tag === "Initial" || saved._tag === "Initial") return null;
  return kinStartListFor({
    setting: "lastUsed",
    lastUsed: AsyncResult.getOrElse(last, () => null),
    kinSeen: AsyncResult.getOrElse(saved, () => null) !== null,
  });
});

/**
 * Opens the Kin list on launch when it was the list last used. `shouldOpen` is read at that
 * moment, so a notification that already opened a chat keeps the screen.
 */
export function installKinStartList(openKin: () => void, shouldOpen: () => boolean): () => void {
  let settled = false;
  let unsubscribe = () => {};
  const read = (list: KinList | null) => {
    if (settled || list === null) return;
    settled = true;
    unsubscribe();
    if (list === "kin" && shouldOpen()) openKin();
  };
  unsubscribe = appAtomRegistry.subscribe(startListAtom, read, { immediate: true });
  if (settled) unsubscribe();
  return () => {
    settled = true;
    unsubscribe();
  };
}

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../../../connection/catalog";
import { connectionAtomRuntime } from "../../../connection/runtime";
import * as MobileSecureStorage from "../../../persistence/mobile-secure-storage";
import { environmentPresentations } from "../../../state/presentation";
import { kinClient, markKinHostKnown } from "./kinClient";
import { classifyKinProbe, kinHostIdToSave, resolveKinHost, type KinHost } from "./kinHost";

const KIN_HOST_STORAGE_KEY = "kin.hostEnvironmentId";

const savedKinHostAtom = connectionAtomRuntime.atom(
  Effect.gen(function* () {
    const storage = yield* MobileSecureStorage.MobileSecureStorage;
    const id = yield* storage.getItem(KIN_HOST_STORAGE_KEY);
    return id === null ? null : EnvironmentId.make(id);
  }).pipe(Effect.orElseSucceed(() => null)),
);

const saveKinHostAtom = connectionAtomRuntime.fn((environmentId: EnvironmentId, get) =>
  MobileSecureStorage.MobileSecureStorage.pipe(
    Effect.flatMap((storage) => storage.setItem(KIN_HOST_STORAGE_KEY, environmentId)),
    // Re-read so `saved` matches what was written and the write isn't repeated.
    Effect.andThen(Effect.sync(() => get.refresh(savedKinHostAtom))),
    Effect.catch(() => Effect.logWarning("Saving the Kin host failed")),
  ),
);

export const kinHostAtom: Atom.Atom<KinHost> = Atom.make((get): KinHost => {
  if (!get(environmentCatalog.catalogValueAtom).isReady) return { _tag: "searching" };
  const saved = get(savedKinHostAtom);
  const candidates = [...get(environmentPresentations.presentationsAtom)].map(
    ([environmentId, presentation]) => ({
      environmentId,
      connected: presentation.connection.phase === "connected",
    }),
  );
  const savedHostId =
    saved._tag === "Initial" ? undefined : AsyncResult.getOrElse(saved, () => null);
  // Before its first probe runs, so an outage there keeps it rather than hiding Kin.
  if (savedHostId) markKinHostKnown(savedHostId);
  return resolveKinHost({
    candidates,
    savedHostId,
    probe: (environmentId) => classifyKinProbe(get(kinClient.orgs({ environmentId, input: {} }))),
  });
}).pipe(Atom.withLabel("kin:host"));

/** The connected environment that hosts Kin. `none` on plain T3 servers and with Kin off. */
export function useKinHost(): KinHost {
  const host = useAtomValue(kinHostAtom);
  const saved = AsyncResult.getOrElse(useAtomValue(savedKinHostAtom), () => null);
  const save = useAtomSet(saveKinHostAtom);
  const toSave = kinHostIdToSave(host);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the discovered host to device storage so a cold start offline can show its cache
  useEffect(() => {
    if (toSave !== null && toSave !== saved) save(toSave);
  }, [toSave, saved, save]);
  return host;
}

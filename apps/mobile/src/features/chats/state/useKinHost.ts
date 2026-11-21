import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { kinGate, type KinGate, type KinPermission } from "@t3tools/client-runtime/kin/kinAccess";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../../../connection/catalog";
import { connectionAtomRuntime } from "../../../connection/runtime";
import * as MobileSecureStorage from "../../../persistence/mobile-secure-storage";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentPresentations } from "../../../state/presentation";
import { kinCachedOrgsAtom, kinClient, markKinHostKnown } from "./kinClient";
import {
  classifyKinProbe,
  kinHostCandidate,
  kinHostLink,
  kinHostIdToSave,
  makeKinHostAtoms,
  type KinHost,
  type KinRouteHost,
  type KinHostCandidate,
} from "@t3tools/client-runtime/kin/kinHost";

const KIN_HOST_STORAGE_KEY = "kin.hostEnvironmentId";

export const savedKinHostAtom = connectionAtomRuntime.atom(
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

const kinHostCandidates = (get: Atom.AtomContext): ReadonlyArray<KinHostCandidate> =>
  [...get(environmentPresentations.presentationsAtom)].map(([environmentId, presentation]) =>
    kinHostCandidate(environmentId, presentation.connection),
  );

const kinProbe = (get: Atom.AtomContext) => (environmentId: EnvironmentId) =>
  classifyKinProbe(get(kinClient.orgs({ environmentId, input: {} })));

const kinCachedOrgs = (get: Atom.AtomContext) => (environmentId: EnvironmentId) =>
  AsyncResult.getOrElse(get(kinCachedOrgsAtom(environmentId)), () => null);

const kinHostAtoms = makeKinHostAtoms({
  ready: (get) => get(environmentCatalog.catalogValueAtom).isReady,
  candidates: kinHostCandidates,
  probe: kinProbe,
  cachedOrgs: kinCachedOrgs,
  savedHostId: (get) => {
    const saved = get(savedKinHostAtom);
    return saved._tag === "Initial" ? undefined : AsyncResult.getOrElse(saved, () => null);
  },
  markKnown: markKinHostKnown,
});
export const kinHostAtom = kinHostAtoms.hostAtom;
const kinHostAtAtom = kinHostAtoms.hostAtAtom;

/** Whether the host a route names is reachable right now, asked at the moment of a change. */
export function kinHostConnected(environmentId: EnvironmentId): boolean {
  const host = appAtomRegistry.get(kinHostAtAtom(environmentId));
  return host._tag === "host" && host.connected;
}

/** What a page gated on one permission shows before its reads; null once it may read. */
export function useKinGate(
  permission: Atom.Atom<KinPermission>,
  environmentId: EnvironmentId,
): KinGate {
  return kinGate(useAtomValue(permission), kinHostLink(useKinHostAt(environmentId)));
}

/** The Kin host a route names, connected or not; `unpaired` when it left the catalog. */
export function useKinHostAt(environmentId: EnvironmentId): KinRouteHost {
  return useAtomValue(kinHostAtAtom(environmentId));
}

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

/** Makes the computer standing in the usual one, so Kin opens there first from now on. */
export function useKinHostChooser(): (environmentId: EnvironmentId) => void {
  return useAtomSet(saveKinHostAtom);
}

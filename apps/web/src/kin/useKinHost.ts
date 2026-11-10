import { useAtomValue } from "@effect/atom-react";
import {
  classifyKinProbe,
  kinHostIdToSave,
  resolveKinHost,
  resolveKinHostAt,
  type KinHost,
  type KinHostCandidate,
  type KinRouteHost,
} from "@t3tools/client-runtime/kin/kinHost";
import type { KinInboxState } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  kinInboxScreenState,
  type KinInboxScreenState,
} from "@t3tools/client-runtime/kin/kinScreenState";
import type { KinSynced } from "@t3tools/client-runtime/kin/kinStreams";
import { EnvironmentId, type KinOrgsListResult } from "@t3tools/contracts";
import { Atom, type AsyncResult } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { kinClient } from "./kinClient";

const KIN_HOST_STORAGE_KEY = "t3code:kin:host";

// The host that last answered with an identity, so a reload picks the same one first.
function readSavedHost(): EnvironmentId | null {
  try {
    const id = window.localStorage.getItem(KIN_HOST_STORAGE_KEY);
    return id === null ? null : EnvironmentId.make(id);
  } catch {
    return null;
  }
}
const savedHost = { id: typeof window === "undefined" ? null : readSavedHost() };

/** This browser has reached a Kin host before. */
export function hasSavedKinHost(): boolean {
  return savedHost.id !== null;
}

const kinHostCandidates = (get: Atom.AtomContext): ReadonlyArray<KinHostCandidate> =>
  [...get(environmentPresentations.presentationsAtom)].map(([environmentId, presentation]) => ({
    environmentId,
    connected: presentation.connection.phase === "connected",
  }));

// Each host's last directory, so an offline chat still names its lead and knows the viewer.
const lastOrgs = new Map<EnvironmentId, KinOrgsListResult>();

const kinProbe = (get: Atom.AtomContext) => (environmentId: EnvironmentId) => {
  const result = get(kinClient.orgs({ environmentId, input: {} }));
  if (result._tag === "Success") lastOrgs.set(environmentId, result.value);
  return classifyKinProbe(result);
};
const cachedOrgs = (environmentId: EnvironmentId) => lastOrgs.get(environmentId) ?? null;

export const kinHostAtom: Atom.Atom<KinHost> = Atom.make((get): KinHost => {
  if (!get(environmentCatalog.catalogValueAtom).isReady) return { _tag: "searching" };
  const host = resolveKinHost({
    candidates: kinHostCandidates(get),
    savedHostId: savedHost.id,
    probe: kinProbe(get),
    cachedOrgs,
  });
  const toSave = kinHostIdToSave(host);
  if (toSave !== null && toSave !== savedHost.id) {
    savedHost.id = toSave;
    try {
      window.localStorage.setItem(KIN_HOST_STORAGE_KEY, toSave);
    } catch {
      // Storage can be full or blocked; the next load just searches again.
    }
  }
  return host;
}).pipe(Atom.withLabel("kin:host"));

const kinHostAtAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): KinRouteHost => {
    if (!get(environmentCatalog.catalogValueAtom).isReady) return { _tag: "searching" };
    return resolveKinHostAt({
      candidates: kinHostCandidates(get),
      environmentId,
      probe: kinProbe(get),
      cachedOrgs,
    });
  }).pipe(Atom.withLabel(`kin:host:${environmentId}`)),
);

/** The connected environment that hosts Kin. `none` on plain T3 servers and with Kin off. */
export function useKinHost(): KinHost {
  return useAtomValue(kinHostAtom);
}

/** The Kin host a route names; `unpaired` when it isn't in this browser's catalog. */
export function useKinHostAt(environmentId: EnvironmentId): KinRouteHost {
  return useAtomValue(kinHostAtAtom(environmentId));
}

type InboxResult = AsyncResult.AsyncResult<KinSynced<KinInboxState>, unknown> | null;
const noInboxAtom: Atom.Atom<InboxResult> = Atom.make<InboxResult>(null);

/** The Kin host's inbox as one screen state, plus a retry for whichever read failed. */
export function useKinInbox(): {
  readonly host: KinHost;
  readonly state: KinInboxScreenState;
  readonly retry: () => void;
} {
  const host = useKinHost();
  const environmentId = host._tag === "host" ? host.environmentId : null;
  const inboxAtom: Atom.Atom<InboxResult> =
    environmentId === null ? noInboxAtom : kinClient.inbox({ environmentId, input: {} });
  const state = kinInboxScreenState(host, useAtomValue(inboxAtom));
  const retry = () => {
    if (environmentId === null || state._tag !== "error") return;
    if (state.retry === "orgs")
      appAtomRegistry.refresh(kinClient.orgs({ environmentId, input: {} }));
    else appAtomRegistry.refresh(inboxAtom);
  };
  return { host, state, retry };
}

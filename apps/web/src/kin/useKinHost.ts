import { useAtomValue } from "@effect/atom-react";
import { kinGate, type KinGate, type KinPermission } from "@t3tools/client-runtime/kin/kinAccess";
import {
  classifyKinProbe,
  kinHostCandidate,
  kinHostLink,
  kinHostIdToSave,
  makeKinHostAtoms,
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
import { kinWorkingAgents } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import {
  EnvironmentId,
  type KinAgentId,
  type KinOrgId,
  type KinOrgsListResult,
} from "@t3tools/contracts";
import { Atom, type AsyncResult } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { kinClient, markKinHostKnown } from "./kinClient";

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
  [...get(environmentPresentations.presentationsAtom)].map(([environmentId, presentation]) =>
    kinHostCandidate(environmentId, presentation.connection),
  );

// Each host's last directory, so an offline chat still names its lead and knows the viewer.
const lastOrgs = new Map<EnvironmentId, KinOrgsListResult>();

const kinProbe = (get: Atom.AtomContext) => (environmentId: EnvironmentId) => {
  const result = get(kinClient.orgs({ environmentId, input: {} }));
  if (result._tag === "Success") lastOrgs.set(environmentId, result.value);
  return classifyKinProbe(result);
};
const cachedOrgs = (environmentId: EnvironmentId) => lastOrgs.get(environmentId) ?? null;

const kinHostAtoms = makeKinHostAtoms({
  ready: (get) => get(environmentCatalog.catalogValueAtom).isReady,
  candidates: kinHostCandidates,
  probe: kinProbe,
  cachedOrgs: () => cachedOrgs,
  savedHostId: () => savedHost.id,
  markKnown: markKinHostKnown,
});
const kinHostAtAtom = kinHostAtoms.hostAtAtom;

export const kinHostAtom: Atom.Atom<KinHost> = Atom.make((get): KinHost => {
  const host = get(kinHostAtoms.hostAtom);
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
}).pipe(Atom.withLabel("kin:host:saved"));

/** Whether the host a route names is reachable right now, asked at the moment of a change. */
export function kinHostConnected(environmentId: EnvironmentId): boolean {
  const host = appAtomRegistry.get(kinHostAtAtom(environmentId));
  return host._tag === "host" && host.connected;
}

/** The directory a host last answered with, while this page has seen one. */
export const kinCachedOrgs = cachedOrgs;

/** Makes `environmentId` the usual host, so Kin opens there first and stops standing in. */
export function chooseKinHost(environmentId: EnvironmentId) {
  savedHost.id = environmentId;
  try {
    window.localStorage.setItem(KIN_HOST_STORAGE_KEY, environmentId);
  } catch {
    // Storage can be full or blocked; this page still uses it until reload.
  }
  appAtomRegistry.refresh(kinHostAtoms.hostAtom);
}

/** The company this browser's Kin host names first; null until a connected host has answered. */
export function kinHostTarget(host: KinHost) {
  return host._tag === "host" && host.connected ? kinHostKeptTarget(host) : null;
}

/** The same company while its host is offline too, from its last answer: for finding your way. */
export function kinHostKeptTarget(host: KinHost) {
  if (host._tag !== "host" || host.probe._tag !== "ready") return null;
  const me = host.probe.orgs.me[0];
  return me === undefined ? null : { environmentId: host.environmentId, orgId: me.orgId };
}

/** The connected environment that hosts Kin. `none` on plain T3 servers and with Kin off. */
export function useKinHost(): KinHost {
  return useAtomValue(kinHostAtom);
}

/** What a page gated on one permission shows before its reads; null once it may read. */
export function useKinGate(
  permission: Atom.Atom<KinPermission>,
  environmentId: EnvironmentId,
): KinGate {
  return kinGate(useAtomValue(permission), kinHostLink(useKinHostAt(environmentId)));
}

/** The Kin host a route names; `unpaired` when it isn't in this browser's catalog. */
export function useKinHostAt(environmentId: EnvironmentId): KinRouteHost {
  return useAtomValue(kinHostAtAtom(environmentId));
}

type InboxResult = AsyncResult.AsyncResult<KinSynced<KinInboxState>, unknown> | null;
const noInboxAtom: Atom.Atom<InboxResult> = Atom.make<InboxResult>(null);

/** The Kin host's inbox as one screen state, plus a retry for whichever read failed. */
/** The agents on a live run, from the chat list's live rows (`kinWorkingAgents`). */
export function useKinWorkingAgents(
  environmentId: EnvironmentId,
  orgId: KinOrgId,
): ReadonlySet<KinAgentId> {
  const inbox = useAtomValue(kinClient.inbox({ environmentId, input: {} }));
  const leads = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  return kinWorkingAgents(
    inbox._tag === "Success" ? inbox.value.value.chats : null,
    leads._tag === "Success" ? leads.value.leads : [],
  );
}

export function useKinInbox(): {
  readonly host: KinHost;
  readonly state: KinInboxScreenState;
  readonly retry: () => void;
  /** Reads the inbox again, for a row the host says has moved on. */
  readonly reread: () => void;
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
  const reread = () => {
    if (environmentId !== null) appAtomRegistry.refresh(inboxAtom);
  };
  return { host, state, retry, reread };
}

import { useAtomValue } from "@effect/atom-react";
import {
  kinAccessAtom,
  kinAccessKnownAtom,
  kinAccessMeAtom,
  kinOwnerLevelAtom,
} from "@t3tools/client-runtime/kin/kinAccess";
import { kinDealsStartFilter, type KinDealsFilter } from "@t3tools/client-runtime/kin/kinDeals";
import { kinPlaceReach, type KinPlaceReach } from "@t3tools/client-runtime/kin/kinJoin";
import {
  KIN_CLIENTS_DEFAULT_FILTER,
  kinClientsStartFilter,
  kinSeesClients,
  type KinClientsFilter,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KIN_SCOPE_ALL,
  kinViewerScope,
  type KinViewerScope,
} from "@t3tools/client-runtime/kin/kinViewerScope";
import { kinOwnerLevel, type EnvironmentId } from "@t3tools/contracts";

import { useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { isChatOnlySession } from "../environments/primary";
import { refreshKinAccessMe } from "./kinClient";

/**
 * Whether the viewer runs the company here: the owner's own session always does; a chat-only
 * session does once the host says its person is the owner or a co-owner.
 */
export function useKinOwnerLevel(environmentId: EnvironmentId): boolean {
  const stored = useAtomValue(kinOwnerLevelAtom(connectionAtomRuntime, environmentId));
  return !isChatOnlySession() || stored;
}

/** As `useKinOwnerLevel`, but undefined while a chat-only session waits for the host to say. */
export function useKinOwnerLevelKnown(environmentId: EnvironmentId): boolean | undefined {
  const access = useAtomValue(kinAccessAtom(connectionAtomRuntime, environmentId));
  if (!isChatOnlySession()) return true;
  return access === null ? undefined : kinOwnerLevel(access);
}

/** The places a member reaches here (switched on, or a project they lead); null until known. */
export function useKinPlaceReach(environmentId: EnvironmentId): KinPlaceReach | null {
  return kinPlaceReach(useAtomValue(kinAccessMeAtom(connectionAtomRuntime, environmentId)));
}

/** What part of the company the viewer sees, for words that must not overclaim. */
export function useKinViewerScope(environmentId: EnvironmentId): KinViewerScope {
  const me = useAtomValue(kinAccessMeAtom(connectionAtomRuntime, environmentId));
  return isChatOnlySession() ? kinViewerScope(me) : KIN_SCOPE_ALL;
}

/** Whether a client's name opens its page for this viewer: owner level, Clients on, or a lead. */
export function useKinOpensClients(environmentId: EnvironmentId): boolean {
  const ownerLevel = useKinOwnerLevel(environmentId);
  return useKinPlaceReach(environmentId)?.clients === true || ownerLevel;
}

/** Whether this viewer sees every client and may add a prospect: owner level, or Clients on. */
export function useKinSeesClients(environmentId: EnvironmentId): boolean {
  const ownerLevel = useKinOwnerLevel(environmentId);
  const me = useAtomValue(kinAccessMeAtom(connectionAtomRuntime, environmentId));
  return ownerLevel || kinSeesClients(me);
}

/** Where the clients list starts: a teammate with Clients on, on their own. */
export function useKinClientsStart(environmentId: EnvironmentId): KinClientsFilter {
  const me = useAtomValue(kinAccessMeAtom(connectionAtomRuntime, environmentId));
  return isChatOnlySession() ? kinClientsStartFilter(me) : KIN_CLIENTS_DEFAULT_FILTER;
}

/** Where the Deals tab starts; null while a chat-only session waits for the host to say who. */
export function useKinDealsStart(environmentId: EnvironmentId): KinDealsFilter | null {
  const known = useAtomValue(kinAccessKnownAtom(connectionAtomRuntime, environmentId));
  return kinDealsStartFilter(isChatOnlySession() ? known : "owner");
}

/**
 * The host's public address, for a link shown to another device; undefined when it has none or
 * is older. Read again as the link shows: the address follows the host's tunnel.
 */
export function useKinPublicUrl(environmentId: EnvironmentId): string | undefined {
  const publicUrl = useAtomValue(kinAccessMeAtom(connectionAtomRuntime, environmentId))?.publicUrl;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- nothing announces a tunnel coming up or going down, so a shown link reads the host again.
  useEffect(() => refreshKinAccessMe(environmentId), [environmentId]);
  return publicUrl;
}

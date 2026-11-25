import { kinOwnerLevelAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { makeKinPlaces } from "@t3tools/client-runtime/kin/kinPlaces";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { isChatOnlySession } from "../environments/primary";
import { kinClient } from "./kinClient";

/**
 * Whether the viewer runs the company here: the owner's own session always does; a chat-only
 * session does once the host says its person is the owner or a co-owner.
 */
export const kinOwnerLevelHereAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => !isChatOnlySession() || get(kinOwnerLevelAtom(connectionAtomRuntime, environmentId)),
  ),
);

/** The destinations this person has here, for the nav, the palette and the shortcuts. */
export const kinPlacesAtom = makeKinPlaces({
  kinClient,
  runtime: connectionAtomRuntime,
  ownerLevel: kinOwnerLevelHereAtom,
});

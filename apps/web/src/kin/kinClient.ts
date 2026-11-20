import { makeKinClient } from "@t3tools/client-runtime/kin/kinClient";
import { kinOutboxIdentity } from "@t3tools/client-runtime/kin/kinOutbox";
import { makeKinScreenReads } from "@t3tools/client-runtime/kin/kinScreenReads";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

/** Kin's shared reads and commands on this browser's connection. */
const kin = makeKinClient(connectionAtomRuntime, appAtomRegistry, {
  // Lazy: the outbox sends through this client.
  onOrgs: (environmentId, result) =>
    Effect.promise(() =>
      import("./kinOutbox").then((outbox) =>
        outbox.syncKinOutboxIdentity(environmentId, kinOutboxIdentity(result) ?? null),
      ),
    ),
});

export const kinClient = kin.kinClient;
export const refreshKinAgents = kin.refreshKinAgents;
export const refreshKinBriefs = kin.refreshKinBriefs;
export const retryKinAccess = kin.retryAccess;
export const refreshKinAccessMe = kin.refreshAccessMe;
/** Which atom each data hook reads, and what a change reads again. */
export const kinReads = makeKinScreenReads(kinClient, appAtomRegistry);

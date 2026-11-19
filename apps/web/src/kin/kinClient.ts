import { makeKinClient } from "@t3tools/client-runtime/kin/kinClient";
import { makeKinScreenReads } from "@t3tools/client-runtime/kin/kinScreenReads";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

/** Kin's shared reads and commands on this browser's connection. The web adds nothing of its own. */
const kin = makeKinClient(connectionAtomRuntime, appAtomRegistry);

export const kinClient = kin.kinClient;
export const refreshKinAgents = kin.refreshKinAgents;
export const refreshKinBriefs = kin.refreshKinBriefs;
export const retryKinAccess = kin.retryAccess;
/** Which atom each data hook reads, and what a change reads again. */
export const kinReads = makeKinScreenReads(kinClient, appAtomRegistry);

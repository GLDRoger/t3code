import type { KinHookApp } from "@t3tools/client-runtime/kin/react/kinHookApp";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { appAtomRegistry } from "../../../state/atom-registry";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient, kinReads } from "./kinClient";
import { kinHostConnected } from "./useKinHost";

/** This phone's client, registry and runtime, for Kin's shared data hooks. */
export const kinHookApp = {
  kinClient,
  kinReads,
  registry: appAtomRegistry,
  runtime: connectionAtomRuntime,
  useAtomCommand,
  kinHostConnected,
} satisfies KinHookApp<never, unknown>;

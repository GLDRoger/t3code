import type { KinHookApp } from "@t3tools/client-runtime/kin/react/kinHookApp";

import { randomUUID } from "../lib/utils";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient, kinReads } from "./kinClient";
import { kinHostConnected } from "./useKinHost";

/** This browser's client, registry and runtime, for Kin's shared data hooks. */
export const kinHookApp = {
  kinClient,
  kinReads,
  registry: appAtomRegistry,
  runtime: connectionAtomRuntime,
  useAtomCommand,
  kinHostConnected,
  newId: randomUUID,
} satisfies KinHookApp<never, unknown>;

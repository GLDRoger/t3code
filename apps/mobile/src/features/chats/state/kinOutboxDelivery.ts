import { environmentSessionGenerationAtom } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";
import { AppState } from "react-native";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { writeFileAtomically } from "../../../lib/atomic-file";
import { uuidv4 } from "../../../lib/uuid";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentPresentations } from "../../../state/presentation";
import { kinClient } from "./kinClient";
import { classifyKinSendFailure, createKinOutbox, type KinOutboxStorage } from "./kinOutbox";
import { createKinOutboxRetry } from "./kinOutboxRetry";

const OUTBOX_FILE = "kin-outbox.json";

async function outboxFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, OUTBOX_FILE);
}

const fileStorage: KinOutboxStorage = {
  load: async () => {
    const file = await outboxFile();
    return file.exists ? await file.text() : null;
  },
  save: async (payload) => writeFileAtomically(await outboxFile(), payload),
};

export const kinOutbox = createKinOutbox({
  registry: appAtomRegistry,
  storage: fileStorage,
  makeId: uuidv4,
  send: async (record) => {
    const result = await kinClient.send.run(appAtomRegistry, {
      environmentId: record.environmentId,
      input: { chatId: record.chatId, clientMessageId: record.clientMessageId, body: record.body },
    });
    return result._tag === "Success"
      ? { _tag: "sent", message: result.value }
      : classifyKinSendFailure(Cause.squash(result.cause));
  },
});

const connectedEnvironments = (): ReadonlySet<EnvironmentId> => {
  const connected = new Set<EnvironmentId>();
  for (const [environmentId, presentation] of appAtomRegistry.get(
    environmentPresentations.presentationsAtom,
  )) {
    if (presentation.connection.phase === "connected") connected.add(environmentId);
  }
  return connected;
};

// One key per connected environment and session, so a reconnect reads as new even when the
// presentation never leaves "connected".
const connectedSessionsAtom = Atom.make((get): string => {
  const keys: string[] = [];
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    if (presentation.connection.phase !== "connected") continue;
    const generation = get(environmentSessionGenerationAtom(connectionAtomRuntime, environmentId));
    keys.push(`${environmentId}\u0000${generation}`);
  }
  return keys.join("\n");
}).pipe(Atom.withLabel("kin:outbox:sessions"));

const retry = createKinOutboxRetry({
  isForeground: () => AppState.currentState === "active",
  deliver: () => kinOutbox.deliverConnected(connectedEnvironments),
});

/** Delivers waiting sends for every connected environment, retrying with backoff. */
export const deliverKinOutbox = (): Promise<void> => retry.run();

/** The environment was removed; drop its unsent messages from memory and disk. */
export const clearKinOutboxEnvironment = (environmentId: EnvironmentId): Promise<void> =>
  kinOutbox.clearEnvironment(environmentId);

/** Loads the persisted outbox and sends it whenever a host comes back or the app wakes. */
export function startKinOutbox(): () => void {
  const unsubscribe = appAtomRegistry.subscribe(
    connectedSessionsAtom,
    (keys) => void retry.sessionsChanged(new Set(keys === "" ? [] : keys.split("\n"))),
    { immediate: true },
  );
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") void retry.resume();
    else retry.pause();
  });
  return () => {
    unsubscribe();
    appState.remove();
    retry.pause();
  };
}

import {
  classifyKinSendFailure,
  createKinOutbox,
  type KinOutboxStorage,
} from "@t3tools/client-runtime/kin/kinOutbox";
import { createKinOutboxRetry } from "@t3tools/client-runtime/kin/kinOutboxRetry";
import { environmentSessionGenerationAtom } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { kinClient } from "./kinClient";

const OUTBOX_KEY = "t3code:kin:outbox";

// Unsent messages survive a reload; the host dedupes a resend by `clientMessageId`.
const localStorageOutbox: KinOutboxStorage = {
  load: async () => {
    try {
      return window.localStorage.getItem(OUTBOX_KEY);
    } catch {
      return null;
    }
  },
  save: async (payload) => {
    window.localStorage.setItem(OUTBOX_KEY, payload);
  },
};

export const kinOutbox = createKinOutbox({
  registry: appAtomRegistry,
  storage: localStorageOutbox,
  makeId: randomUUID,
  send: async (record) => {
    const result = await kinClient.send.run(appAtomRegistry, {
      environmentId: record.environmentId,
      input: {
        chatId: record.chatId,
        clientMessageId: record.clientMessageId,
        body: record.body,
        ...(record.attachments === undefined ? {} : { attachments: record.attachments }),
      },
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

// One key per connected environment and session, so a reconnect reads as new.
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
  isForeground: () => document.visibilityState === "visible",
  deliver: () => kinOutbox.deliverConnected(connectedEnvironments),
});

/** Delivers waiting sends for every connected environment, retrying with backoff. */
export const deliverKinOutbox = (): Promise<void> => retry.run();

let started = false;

/** Loads the saved outbox and sends it whenever a host comes back or the tab returns. Idempotent. */
export function startKinOutbox(): void {
  if (started) return;
  started = true;
  appAtomRegistry.subscribe(
    connectedSessionsAtom,
    (keys) => void retry.sessionsChanged(new Set(keys === "" ? [] : keys.split("\n"))),
    { immediate: true },
  );
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void retry.resume();
    else retry.pause();
  });
}

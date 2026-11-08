import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { writeFileAtomically } from "../../../lib/atomic-file";
import { uuidv4 } from "../../../lib/uuid";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentPresentations } from "../../../state/presentation";
import { kinClient } from "./kinClient";
import { classifyKinSendFailure, createKinOutbox, type KinOutboxStorage } from "./kinOutbox";

const OUTBOX_FILE = "kin-outbox.json";
/** A transient failure while the host still reads as connected tries again after this. */
const RETRY_WHILE_CONNECTED_MS = 5_000;

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

let started = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Delivers waiting sends for every connected environment. */
export async function deliverKinOutbox(): Promise<void> {
  await kinOutbox.load();
  const connected = connectedEnvironments();
  const waiting = [...kinOutbox.waitingEnvironments()].filter((id) => connected.has(id));
  await Promise.all(waiting.map((environmentId) => kinOutbox.deliver(environmentId)));
  const stillWaiting = [...kinOutbox.waitingEnvironments()].some((id) =>
    connectedEnvironments().has(id),
  );
  if (stillWaiting && retryTimer === null) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void deliverKinOutbox();
    }, RETRY_WHILE_CONNECTED_MS);
  }
}

/** Loads the persisted outbox once and sends it whenever an environment comes back. */
export function startKinOutbox(): void {
  if (started) return;
  started = true;
  let previous: ReadonlySet<EnvironmentId> = new Set();
  appAtomRegistry.subscribe(
    environmentPresentations.presentationsAtom,
    () => {
      const connected = connectedEnvironments();
      const reconnected = [...connected].some((id) => !previous.has(id));
      previous = connected;
      if (reconnected) void deliverKinOutbox();
    },
    { immediate: true },
  );
}

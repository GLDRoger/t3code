import {
  classifyKinSendFailure,
  createKinOutbox,
  kinOutboxIdentity,
  type KinOutboxStorage,
} from "@t3tools/client-runtime/kin/kinOutbox";
import { createKinLocalPreviews } from "@t3tools/client-runtime/kin/kinAttachments";
import { kinDocRefInput } from "@t3tools/client-runtime/kin/kinDocs";
import { createKinOutboxRetry } from "@t3tools/client-runtime/kin/kinOutboxRetry";
import { environmentSessionGenerationAtom } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { kinClient } from "./kinClient";

const OUTBOX_KEY = "t3code:kin:outbox";
/** Who each host last said this browser's session is, so a change of person is noticed. */
const PEOPLE_KEY = "t3code:kin:outbox:people";
const People = Schema.fromJsonString(Schema.Record(EnvironmentId, Schema.NullOr(Schema.String)));
const decodePeople = Schema.decodeUnknownOption(People);
const encodePeople = Schema.encodeSync(People);

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

/** Blob copies of the images this tab sent, until their posted message's own copies load. */
export const kinLocalPreviews = createKinLocalPreviews((url) => URL.revokeObjectURL(url));

// The directory query drops the last person's answer when the host is paired as someone else.
const sessionOrgsAtom = (environmentId: EnvironmentId) =>
  kinClient.orgs({ environmentId, input: {} });

export const kinOutbox = createKinOutbox({
  registry: appAtomRegistry,
  storage: localStorageOutbox,
  makeId: randomUUID,
  identity: (environmentId) =>
    kinOutboxIdentity(
      AsyncResult.getOrElse(appAtomRegistry.get(sessionOrgsAtom(environmentId)), () => null),
    ),
  send: async (record) => {
    const result = await kinClient.send.run(appAtomRegistry, {
      environmentId: record.environmentId,
      input: {
        chatId: record.chatId,
        clientMessageId: record.clientMessageId,
        body: record.body,
        ...(record.attachments === undefined ? {} : { attachments: record.attachments }),
        ...(record.mentions === undefined ? {} : { mentions: record.mentions }),
        ...(record.refs === undefined ? {} : { refs: record.refs.map(kinDocRefInput) }),
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

// One key per connected environment and session, so a reconnect reads as new; with who the
// session is while a send waits on that.
const connectedSessionsAtom = Atom.make((get): string => {
  const keys: string[] = [];
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    if (presentation.connection.phase !== "connected") continue;
    const generation = get(environmentSessionGenerationAtom(connectionAtomRuntime, environmentId));
    const identity = get(kinOutbox.waitingAtom(environmentId))
      ? kinOutboxIdentity(AsyncResult.getOrElse(get(sessionOrgsAtom(environmentId)), () => null))
      : undefined;
    keys.push(`${environmentId}\u0000${generation}\u0000${JSON.stringify(identity ?? "")}`);
  }
  return keys.join("\n");
}).pipe(Atom.withLabel("kin:outbox:sessions"));

const retry = createKinOutboxRetry({
  isForeground: () => document.visibilityState === "visible",
  deliver: () => kinOutbox.deliverConnected(connectedEnvironments),
});

/** Delivers waiting sends for every connected environment, retrying with backoff. */
export const deliverKinOutbox = (): Promise<void> => retry.run();

/** The host said who this session is: unsent messages another person wrote here go unsent. */
export async function syncKinOutboxIdentity(
  environmentId: EnvironmentId,
  identity: string | null,
): Promise<void> {
  let people: Record<EnvironmentId, string | null> = {};
  try {
    people = Option.getOrElse(
      decodePeople(window.localStorage.getItem(PEOPLE_KEY) ?? "{}"),
      () => ({}),
    );
  } catch {}
  const previous = people[environmentId];
  if (previous !== identity) {
    try {
      window.localStorage.setItem(
        PEOPLE_KEY,
        encodePeople({ ...people, [environmentId]: identity }),
      );
    } catch {}
  }
  // A browser that never noted a person here held only that session's messages.
  await kinOutbox.syncIdentity(
    environmentId,
    identity,
    previous !== undefined && previous !== identity,
  );
}

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

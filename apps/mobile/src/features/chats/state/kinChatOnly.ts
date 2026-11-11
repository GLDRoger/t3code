import { useAtomValue } from "@effect/atom-react";
import {
  kinAccessEnded,
  kinAppShell,
  kinChatOnlyEnvironments,
  type KinAppShell,
} from "@t3tools/client-runtime/kin/kinJoin";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../../../connection/catalog";
import { connectionAtomRuntime } from "../../../connection/runtime";
import * as MobileSecureStorage from "../../../persistence/mobile-secure-storage";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentSession } from "../../../state/session";

const KIN_CHAT_ONLY_STORAGE_KEY = "kin.chatOnlyEnvironmentIds";
const RememberedIds = Schema.fromJsonString(Schema.Array(EnvironmentId));
const decodeRemembered = Schema.decodeUnknownOption(RememberedIds);
const encodeRemembered = Schema.encodeSync(RememberedIds);

const rememberedAtom = connectionAtomRuntime.atom(
  MobileSecureStorage.MobileSecureStorage.pipe(
    Effect.flatMap((storage) => storage.getItem(KIN_CHAT_ONLY_STORAGE_KEY)),
    Effect.map(
      (saved) => new Set(saved === null ? [] : Option.getOrElse(decodeRemembered(saved), () => [])),
    ),
    Effect.orElseSucceed(() => new Set<EnvironmentId>()),
  ),
);

const rememberAtom = connectionAtomRuntime.fn((ids: ReadonlyArray<EnvironmentId>, get) =>
  MobileSecureStorage.MobileSecureStorage.pipe(
    Effect.flatMap((storage) => storage.setItem(KIN_CHAT_ONLY_STORAGE_KEY, encodeRemembered(ids))),
    Effect.andThen(Effect.sync(() => get.refresh(rememberedAtom))),
    Effect.catch(() => Effect.logWarning("Saving the chat-only environments failed")),
  ),
);

interface ChatOnlyState {
  /** False until the saved environments and the remembered answers have loaded. */
  readonly ready: boolean;
  readonly saved: number;
  readonly chatOnly: ReadonlyArray<EnvironmentId>;
  readonly remembered: ReadonlySet<EnvironmentId> | null;
}

/** Which saved environments hold a teammate's session, from each session's own grants. */
const chatOnlyStateAtom = Atom.make((get): ChatOnlyState => {
  const rememberedResult = get(rememberedAtom);
  const remembered = AsyncResult.getOrElse(rememberedResult, () => null);
  const catalog = get(environmentCatalog.catalogValueAtom);
  const saved = [...catalog.entries.keys()];
  if (remembered === null) return { ready: false, saved: saved.length, chatOnly: [], remembered };
  const chatOnly = kinChatOnlyEnvironments({
    saved,
    remembered,
    session: (environmentId) => {
      const session = get(environmentSession.sessionStateAtom(environmentId));
      return session._tag === "Success" ? session.value : null;
    },
  });
  // An owner's device remembers none and never waits on the catalog.
  return {
    ready: catalog.isReady || remembered.size === 0,
    saved: saved.length,
    chatOnly,
    remembered,
  };
}).pipe(Atom.withLabel("kin:chat-only-environments"));

const sameIds = (left: ReadonlyArray<EnvironmentId>, right: ReadonlySet<EnvironmentId>) =>
  left.length === right.size && left.every((id) => right.has(id));

const appShellAtom = Atom.make((get): KinAppShell => {
  const state = get(chatOnlyStateAtom);
  return kinAppShell({ ready: state.ready, saved: state.saved, chatOnly: state.chatOnly.length });
});

const environmentChatOnlyAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(chatOnlyStateAtom).chatOnly.includes(environmentId)),
);

/** Whether the app is the coding app or, on a teammate's phone, only Kin. */
export function useKinAppShell(): KinAppShell {
  return useAtomValue(appShellAtom);
}

export function readKinAppShell(): KinAppShell {
  return appAtomRegistry.get(appShellAtom);
}

/** The saved environments this device reaches as a teammate. */
export function useChatOnlyEnvironments(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(chatOnlyStateAtom, (state) => state.chatOnly);
}

export function readEnvironmentChatOnly(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(environmentChatOnlyAtom(environmentId));
}

const accessEndedAtom = Atom.make((get) =>
  get(chatOnlyStateAtom).chatOnly.filter((environmentId) =>
    kinAccessEnded(
      AsyncResult.getOrElse(get(environmentCatalog.stateAtom(environmentId)), () => null),
    ),
  ),
).pipe(Atom.withLabel("kin:access-ended"));

/** The teammate sessions the host has ended; each needs a new join link. */
export function useKinAccessEnded(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(accessEndedAtom);
}

/** Runs `onEnded` when a teammate's access ends under a running app, so no open chat is left retrying. */
export function installKinAccessEnded(onEnded: () => void): () => void {
  let last = appAtomRegistry.get(accessEndedAtom).length;
  return appAtomRegistry.subscribe(accessEndedAtom, (ended) => {
    if (ended.length > last) onEnded();
    last = ended.length;
  });
}

/** Resolves once this environment's own session says what it is, so a join lands on the right app. */
export function whenEnvironmentSessionKnown(environmentId: EnvironmentId): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    let done = false;
    const read = (session: AsyncResult.AsyncResult<unknown, unknown>) => {
      if (done || session._tag !== "Success") return;
      done = true;
      unsubscribe();
      resolve();
    };
    unsubscribe = appAtomRegistry.subscribe(
      environmentSession.sessionStateAtom(environmentId),
      read,
      { immediate: true },
    );
    if (done) unsubscribe();
  });
}

/** Keeps the device's memory of its teammate sessions current, for a cold start offline. */
export function installKinChatOnlyMemory(): () => void {
  return appAtomRegistry.subscribe(
    chatOnlyStateAtom,
    (state) => {
      if (!state.ready || state.remembered === null) return;
      if (!sameIds(state.chatOnly, state.remembered))
        appAtomRegistry.set(rememberAtom, state.chatOnly);
    },
    { immediate: true },
  );
}

/**
 * Home is a different screen in each shell, and a route keeps the bar its last screen set. When
 * the shell changes under a running app (a first join, leaving the last team), start Home afresh.
 */
export function installKinShellReset(resetToHome: () => void): () => void {
  let last = appAtomRegistry.get(appShellAtom);
  return appAtomRegistry.subscribe(appShellAtom, (shell) => {
    const changed = last !== "loading" && shell !== "loading" && shell !== last;
    last = shell;
    if (changed) resetToHome();
  });
}

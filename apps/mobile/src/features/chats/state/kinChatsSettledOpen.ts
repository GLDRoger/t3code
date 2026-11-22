import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../../../connection/runtime";
import * as MobileSecureStorage from "../../../persistence/mobile-secure-storage";

const STORAGE_KEY = "kin.chatsSettledOpen";

const read = MobileSecureStorage.MobileSecureStorage.pipe(
  Effect.flatMap((storage) => storage.getItem(STORAGE_KEY)),
  Effect.map((saved) => saved === "true"),
);

/** Whether this phone keeps the Chats list's Settled fold open; closed until opened here. */
export const kinChatsSettledOpenAtom = connectionAtomRuntime.atom(
  read.pipe(Effect.orElseSucceed(() => false)),
);

export const setKinChatsSettledOpenAtom = connectionAtomRuntime.fn((open: boolean, get) =>
  MobileSecureStorage.MobileSecureStorage.pipe(
    Effect.flatMap((storage) => storage.setItem(STORAGE_KEY, open ? "true" : "false")),
    Effect.andThen(Effect.sync(() => get.refresh(kinChatsSettledOpenAtom))),
    Effect.catch(() => Effect.logWarning("Saving whether Settled is open failed")),
  ),
);

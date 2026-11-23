import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { connectionAtomRuntime } from "../../../connection/runtime";
import * as MobileSecureStorage from "../../../persistence/mobile-secure-storage";

const STORAGE_KEY = "kin.chatsIntroDismissed";
const Dismissed = Schema.fromJsonString(Schema.Array(Schema.String));
const decode = Schema.decodeUnknownOption(Dismissed);
const encode = Schema.encodeSync(Dismissed);

/** One person on one Kin, as this phone remembers them. */
export const kinIntroPersonKey = (environmentId: string, personId: string) =>
  `${environmentId}:${personId}`;

const read = MobileSecureStorage.MobileSecureStorage.pipe(
  Effect.flatMap((storage) => storage.getItem(STORAGE_KEY)),
  Effect.map((saved) => (saved === null ? [] : Option.getOrElse(decode(saved), () => []))),
);

/** Who on this phone dismissed the line that says what Kin is. */
export const kinIntroDismissedAtom = connectionAtomRuntime.atom(
  read.pipe(
    Effect.map((keys) => new Set(keys)),
    Effect.orElseSucceed(() => new Set<string>()),
  ),
);

export const dismissKinIntroAtom = connectionAtomRuntime.fn((person: string, get) =>
  read.pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
    Effect.flatMap((keys) =>
      keys.includes(person)
        ? Effect.void
        : MobileSecureStorage.MobileSecureStorage.pipe(
            Effect.flatMap((storage) => storage.setItem(STORAGE_KEY, encode([...keys, person]))),
          ),
    ),
    Effect.andThen(Effect.sync(() => get.refresh(kinIntroDismissedAtom))),
    Effect.catch(() => Effect.logWarning("Saving that the Kin intro was dismissed failed")),
  ),
);

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { connectionAtomRuntime } from "../../../connection/runtime";
import * as MobileSecureStorage from "../../../persistence/mobile-secure-storage";

const STORAGE_KEY = "kin.calendarHidden";
const Hidden = Schema.fromJsonString(Schema.Array(Schema.String));
const decode = Schema.decodeUnknownOption(Hidden);
const encode = Schema.encodeSync(Hidden);

const read = MobileSecureStorage.MobileSecureStorage.pipe(
  Effect.flatMap((storage) => storage.getItem(STORAGE_KEY)),
  Effect.map((saved) => (saved === null ? [] : Option.getOrElse(decode(saved), () => []))),
);

/** Who on this phone turned calendar events off in Dates (`kinCalendarDeviceKey`); on until then. */
export const kinCalendarHiddenAtom = connectionAtomRuntime.atom(
  read.pipe(
    Effect.map((keys) => new Set(keys)),
    Effect.orElseSucceed(() => new Set<string>()),
  ),
);

export const setKinCalendarShownAtom = connectionAtomRuntime.fn(
  ({ key, shown }: { readonly key: string; readonly shown: boolean }, get) =>
    read.pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
      Effect.flatMap((keys) =>
        MobileSecureStorage.MobileSecureStorage.pipe(
          Effect.flatMap((storage) =>
            storage.setItem(
              STORAGE_KEY,
              encode(shown ? keys.filter((held) => held !== key) : [...new Set([...keys, key])]),
            ),
          ),
        ),
      ),
      Effect.andThen(Effect.sync(() => get.refresh(kinCalendarHiddenAtom))),
      Effect.catch(() => Effect.logWarning("Saving whether Dates shows calendar events failed")),
    ),
);

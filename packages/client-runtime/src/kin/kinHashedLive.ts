import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { EnvironmentSupervisor } from "../connection/index.ts";
import { resubscribeWhenKinReturns, retryWhileKinUnavailable } from "./kinStreams.ts";

type HashedEvent =
  | { readonly _tag: "snapshot"; readonly hash: string }
  | { readonly _tag: "current"; readonly hash: string }
  | { readonly _tag: "changed"; readonly hash: string };

/**
 * A hashed live read as the host streams it (the server's `hashedLive.ts`): the whole of it, then
 * kept current from what moved. Each new session names the hash held, so when nothing moved the
 * host sends `current` and nothing again. `open` subscribes with the input `makeInput` gives each session.
 */
export function kinHashedLive<
  Input extends { readonly held?: string | undefined },
  Event extends HashedEvent,
  Held,
  E,
  R,
>(
  input: Input,
  open: (makeInput: () => Effect.Effect<Input>) => Stream.Stream<Event, E, R>,
  fold: {
    readonly snapshot: (event: Extract<Event, { readonly _tag: "snapshot" }>) => Held;
    readonly apply: (held: Held, event: Extract<Event, { readonly _tag: "changed" }>) => Held;
  },
): Stream.Stream<Held, E, R | EnvironmentSupervisor.EnvironmentSupervisor> {
  return Stream.suspend(() => {
    let held: { readonly value: Held; readonly hash: string } | null = null;
    return resubscribeWhenKinReturns(
      retryWhileKinUnavailable(
        open(() => Effect.sync(() => (held === null ? input : { ...input, held: held.hash }))),
      ),
      Stream.empty,
      Stream.empty,
    ).pipe(
      Stream.map((event): { readonly value: Held } | null => {
        switch (event._tag) {
          case "snapshot":
            held = {
              value: fold.snapshot(event as Extract<Event, { readonly _tag: "snapshot" }>),
              hash: event.hash,
            };
            return held;
          // What is held still stands; what shows it already has it.
          case "current":
            return null;
          case "changed":
            if (held === null) return null;
            held = {
              value: fold.apply(held.value, event as Extract<Event, { readonly _tag: "changed" }>),
              hash: event.hash,
            };
            return held;
        }
      }),
      Stream.filter((one): one is { readonly value: Held } => one !== null),
      Stream.map((one) => one.value),
    );
  });
}

import { KinChatError, KinTaskCardState, KinOwnerCheckCard } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const schemas = new Map<string, Schema.Codec<unknown>>([
  ["task", KinTaskCardState],
  ["owner_check", KinOwnerCheckCard],
]);

export const validateState = Effect.fn("KinWidgetRegistry.validateState")(function* (
  type: string,
  state: unknown,
) {
  const schema = schemas.get(type);
  if (schema === undefined)
    return yield* new KinChatError({ reason: "invalid_state", message: "Unknown widget type." });
  return yield* Schema.decodeUnknownEffect(schema)(state).pipe(
    Effect.mapError(
      () => new KinChatError({ reason: "invalid_state", message: "Invalid widget state." }),
    ),
  );
});

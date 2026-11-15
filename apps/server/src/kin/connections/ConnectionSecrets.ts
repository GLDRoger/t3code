import { KinChatError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

/** A connection's key and the header it travels in. Redacted from the moment it is read. */
export type ConnectionKey = { readonly header: string; readonly key: string };

const Stored = Schema.fromJsonString(Schema.Struct({ header: Schema.String, key: Schema.String }));
const decode = Schema.decodeUnknownOption(Stored);
const encode = Schema.encodeSync(Stored);

// The store's own errors name only the secret, never its value; callers see none of them.
const unavailable = new KinChatError({
  reason: "unavailable",
  message: "Kin couldn't reach its secret store.",
});

const secretName = (connectionId: string) => `kin-connection-${connectionId}`;

/**
 * Connection credentials, kept only in the server's secret store (a 0600 file in its 0700
 * secrets directory), never in SQLite, logs, spans, errors, tool output or call rows.
 */
export class KinConnectionSecrets extends Context.Service<
  KinConnectionSecrets,
  {
    readonly get: (
      connectionId: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<ConnectionKey>>, KinChatError>;
    readonly set: (
      connectionId: string,
      key: Redacted.Redacted<ConnectionKey>,
    ) => Effect.Effect<void, KinChatError>;
    readonly remove: (connectionId: string) => Effect.Effect<void, KinChatError>;
  }
>()("t3/kin/connections/ConnectionSecrets/KinConnectionSecrets") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  return KinConnectionSecrets.of({
    get: Effect.fn("KinConnectionSecrets.get")(function* (connectionId) {
      const bytes = yield* store
        .get(secretName(connectionId))
        .pipe(Effect.mapError(() => unavailable));
      return Option.flatMap(bytes, (value) =>
        decode(new TextDecoder().decode(value)).pipe(Option.map((key) => Redacted.make(key))),
      );
    }),
    set: Effect.fn("KinConnectionSecrets.set")(function* (connectionId, key) {
      yield* store
        .set(secretName(connectionId), new TextEncoder().encode(encode(Redacted.value(key))))
        .pipe(Effect.mapError(() => unavailable));
    }),
    remove: Effect.fn("KinConnectionSecrets.remove")(function* (connectionId) {
      yield* store.remove(secretName(connectionId)).pipe(Effect.mapError(() => unavailable));
    }),
  });
});

/** Brings its own secret store, as `KeySeal.layer` does: the same files as the server's. */
export const layer = Layer.effect(KinConnectionSecrets, make).pipe(
  Layer.provide(ServerSecretStore.layer),
);

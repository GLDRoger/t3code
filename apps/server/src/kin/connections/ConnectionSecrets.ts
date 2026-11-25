import { KinChatError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";

/** A connection's key and the header it travels in. Redacted from the moment it is read. */
export type ConnectionKey = { readonly header: string; readonly key: string };

const Stored = Schema.fromJsonString(Schema.Struct({ header: Schema.String, key: Schema.String }));
const decode = Schema.decodeUnknownOption(Stored);
const encode = Schema.encodeSync(Stored);

const SignInFields = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
  issuer: Schema.String,
  tokenEndpoint: Schema.String,
  basicOnly: Schema.Boolean,
  clientId: Schema.String,
  clientSecret: Schema.optional(Schema.String),
  resource: Schema.optional(Schema.String),
  /** A server address that is itself a password (Zoho), kept here rather than in SQLite. */
  secretUrl: Schema.optional(Schema.String),
});
/** A connection's sign-in: its tokens, and the client and server they belong to. */
export type SignInSecret = typeof SignInFields.Type;
const StoredSignIn = Schema.fromJsonString(Schema.Struct({ signIn: SignInFields }));
const decodeSignIn = Schema.decodeUnknownOption(StoredSignIn);
const encodeSignIn = Schema.encodeSync(StoredSignIn);

/** A sign-in client the owner made at a service and pasted once; Microsoft's needs no secret. */
export type SignInClient = {
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
};
const StoredClient = Schema.fromJsonString(
  Schema.Struct({ clientId: Schema.String, clientSecret: Schema.optional(Schema.String) }),
);
const decodeClient = Schema.decodeUnknownOption(StoredClient);
const encodeClient = Schema.encodeSync(StoredClient);
const clientName = (service: string) => `kin-oauth-client-${service}`;

// The store's own errors name only the secret, never its value; callers see none of them.
const unavailable = new KinChatError({
  reason: "unavailable",
  message: "Kin couldn't reach its secret store.",
});

const secretName = (connectionId: string) => `kin-connection-${connectionId}`;
const socialName = (groupId: string) => `kin-social-${groupId}`;
const picturesName = (vendor: string) => `kin-pictures-${vendor}`;
// The store keeps each secret as `<name>.bin`; connection ids are `conn_` and 24 hex digits.
const storedName = /^kin-connection-(conn_[0-9a-f]{24})\.bin$/;

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
    readonly getSignIn: (
      connectionId: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<SignInSecret>>, KinChatError>;
    readonly setSignIn: (
      connectionId: string,
      secret: Redacted.Redacted<SignInSecret>,
    ) => Effect.Effect<void, KinChatError>;
    readonly getClient: (
      service: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<SignInClient>>, KinChatError>;
    /** `None` forgets the client. */
    readonly setClient: (
      service: string,
      client: Option.Option<Redacted.Redacted<SignInClient>>,
    ) => Effect.Effect<void, KinChatError>;
    /** A social group's key for its posting service, by group id. */
    readonly getSocialKey: (
      groupId: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, KinChatError>;
    readonly setSocialKey: (
      groupId: string,
      key: Redacted.Redacted<string>,
    ) => Effect.Effect<void, KinChatError>;
    readonly removeSocialKey: (groupId: string) => Effect.Effect<void, KinChatError>;
    /** The company's key for a picture service, by vendor name. */
    readonly getPicturesKey: (
      vendor: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, KinChatError>;
    readonly setPicturesKey: (
      vendor: string,
      key: Redacted.Redacted<string>,
    ) => Effect.Effect<void, KinChatError>;
    readonly removePicturesKey: (vendor: string) => Effect.Effect<void, KinChatError>;
    /** The connection ids that have a credential stored, for the sweep at start. */
    readonly stored: () => Effect.Effect<ReadonlyArray<string>, KinChatError>;
  }
>()("t3/kin/connections/ConnectionSecrets/KinConnectionSecrets") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const read = (name: string) =>
    store.get(name).pipe(
      Effect.mapError(() => unavailable),
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    );
  const write = (name: string, text: string) =>
    store.set(name, new TextEncoder().encode(text)).pipe(Effect.mapError(() => unavailable));
  return KinConnectionSecrets.of({
    getSignIn: Effect.fn("KinConnectionSecrets.getSignIn")(function* (connectionId) {
      const text = yield* read(secretName(connectionId));
      return Option.flatMap(text, (value) =>
        decodeSignIn(value).pipe(Option.map((stored) => Redacted.make(stored.signIn))),
      );
    }),
    setSignIn: Effect.fn("KinConnectionSecrets.setSignIn")(function* (connectionId, secret) {
      yield* write(secretName(connectionId), encodeSignIn({ signIn: Redacted.value(secret) }));
    }),
    getClient: Effect.fn("KinConnectionSecrets.getClient")(function* (service) {
      const text = yield* read(clientName(service));
      return Option.flatMap(text, (value) => decodeClient(value).pipe(Option.map(Redacted.make)));
    }),
    setClient: Effect.fn("KinConnectionSecrets.setClient")(function* (service, client) {
      if (Option.isNone(client))
        return yield* store.remove(clientName(service)).pipe(Effect.mapError(() => unavailable));
      yield* write(clientName(service), encodeClient(Redacted.value(client.value)));
    }),
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
    getSocialKey: Effect.fn("KinConnectionSecrets.getSocialKey")(function* (groupId) {
      return Option.map(yield* read(socialName(groupId)), Redacted.make);
    }),
    setSocialKey: Effect.fn("KinConnectionSecrets.setSocialKey")(function* (groupId, key) {
      yield* write(socialName(groupId), Redacted.value(key));
    }),
    removeSocialKey: Effect.fn("KinConnectionSecrets.removeSocialKey")(function* (groupId) {
      yield* store.remove(socialName(groupId)).pipe(Effect.mapError(() => unavailable));
    }),
    getPicturesKey: Effect.fn("KinConnectionSecrets.getPicturesKey")(function* (vendor) {
      return Option.map(yield* read(picturesName(vendor)), Redacted.make);
    }),
    setPicturesKey: Effect.fn("KinConnectionSecrets.setPicturesKey")(function* (vendor, key) {
      yield* write(picturesName(vendor), Redacted.value(key));
    }),
    removePicturesKey: Effect.fn("KinConnectionSecrets.removePicturesKey")(function* (vendor) {
      yield* store.remove(picturesName(vendor)).pipe(Effect.mapError(() => unavailable));
    }),
    stored: Effect.fn("KinConnectionSecrets.stored")(function* () {
      const names = yield* fs
        .readDirectory(config.secretsDir)
        .pipe(Effect.mapError(() => unavailable));
      return names.flatMap((name) => {
        const match = storedName.exec(name);
        return match === null ? [] : [match[1]!];
      });
    }),
  });
});

/** Brings its own secret store, as `KeySeal.layer` does: the same files as the server's. */
export const layer = Layer.effect(KinConnectionSecrets, make).pipe(
  Layer.provide(ServerSecretStore.layer),
);

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** The only items Kin keeps; anything else is refused so a caller can't read unrelated secrets. */
export const KinKeychainService = Schema.Literals(["kin-github-app", "kin-owner-merge"]);
export type KinKeychainService = typeof KinKeychainService.Type;

export class KinKeychainError extends Schema.TaggedError<KinKeychainError>()("KinKeychainError", {
  service: KinKeychainService,
  operation: Schema.Literals(["load", "get", "set", "remove"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `The OS keychain refused to ${this.operation} the ${this.service} item.`;
  }
}

/** OS keychain items. Values are secret: they leave only as `Redacted`, never in errors or logs. */
export class KinKeychain extends Context.Service<
  KinKeychain,
  {
    readonly get: (
      service: KinKeychainService,
      account: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, KinKeychainError>;
    readonly set: (
      service: KinKeychainService,
      account: string,
      value: Redacted.Redacted<string>,
    ) => Effect.Effect<void, KinKeychainError>;
    readonly remove: (
      service: KinKeychainService,
      account: string,
    ) => Effect.Effect<void, KinKeychainError>;
  }
>()("t3/kin/github/Keychain/KinKeychain") {}

const make = Effect.sync(() => {
  // Loading the native binding at startup can stop other platforms from opening (ChromiumKeys).
  const entry = (
    service: KinKeychainService,
    account: string,
    operation: KinKeychainError["operation"],
  ) =>
    Effect.tryPromise({
      try: () => import("@napi-rs/keyring"),
      catch: (cause) => new KinKeychainError({ service, operation: "load", cause }),
    }).pipe(
      Effect.map((Keyring) => new Keyring.AsyncEntry(service, account)),
      Effect.withSpan("KinKeychain.entry", { attributes: { service, operation } }),
    );

  const get = Effect.fn("KinKeychain.get")(function* (
    service: KinKeychainService,
    account: string,
  ) {
    const item = yield* entry(service, account, "get");
    const value = yield* Effect.tryPromise({
      try: () => item.getPassword(),
      catch: (cause) => new KinKeychainError({ service, operation: "get", cause }),
    });
    return value === undefined || value === null || value === ""
      ? Option.none()
      : Option.some(Redacted.make(value));
  });

  const set = Effect.fn("KinKeychain.set")(function* (
    service: KinKeychainService,
    account: string,
    value: Redacted.Redacted<string>,
  ) {
    const item = yield* entry(service, account, "set");
    yield* Effect.tryPromise({
      try: () => item.setPassword(Redacted.value(value)),
      catch: (cause) => new KinKeychainError({ service, operation: "set", cause }),
    });
  });

  const remove = Effect.fn("KinKeychain.remove")(function* (
    service: KinKeychainService,
    account: string,
  ) {
    const item = yield* entry(service, account, "remove");
    yield* Effect.tryPromise({
      try: () => item.deleteCredential(),
      catch: (cause) => new KinKeychainError({ service, operation: "remove", cause }),
    });
  });

  return KinKeychain.of({ get, set, remove });
});

export const layer = Layer.effect(KinKeychain, make);

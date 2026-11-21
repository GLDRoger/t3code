import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { KinKeychain } from "./Keychain.ts";

/** The secret store's name for an App's key: `{"privateKeyPem": …}`, as GitHub's key in JSON. */
export const appKeyName = (appId: string) => `kin-github-app-${appId}`;
/** The secret GitHub signs one App's webhook deliveries with (`appHook.ts`); it goes with the App. */
export const hookSecretName = (appId: string) => `kin-github-app-hook-${appId}`;
/** The hook address GitHub accepted with that secret: set only after its answer said so. */
export const hookSetName = (appId: string) => `kin-github-app-hook-${appId}-set`;

/**
 * Kin's GitHub App key, kept in the server's secret store like every other Kin secret. Hosts set
 * up before kept it in the OS keyring: Kin reads that item when the store has none and copies it
 * in once, leaving the item where it is. The value leaves only as `Redacted`.
 */
export class KinGitHubAppKey extends Context.Service<
  KinGitHubAppKey,
  {
    readonly get: (appId: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
    readonly set: (
      appId: string,
      key: Redacted.Redacted<string>,
    ) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
    readonly remove: (appId: string) => Effect.Effect<void>;
  }
>()("t3/kin/github/appKey/KinGitHubAppKey") {}

export const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const keychain = yield* KinKeychain;
  const encode = (text: string) => new TextEncoder().encode(text);

  const get = Effect.fn("KinGitHubAppKey.get")(function* (appId: string) {
    const kept = yield* store
      .get(appKeyName(appId))
      .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    if (Option.isSome(kept))
      return Option.some(Redacted.make(new TextDecoder().decode(kept.value)));
    const old = yield* keychain
      .appSecret(appId)
      .pipe(Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()));
    if (Option.isNone(old)) return old;
    // Logged without its cause, so nothing of the key can reach the log.
    yield* store
      .set(appKeyName(appId), encode(Redacted.value(old.value)))
      .pipe(
        Effect.catch(() =>
          Effect.logWarning(
            "Kin couldn't copy its GitHub App key from the keyring into its secret store; it reads the keyring again next time.",
          ),
        ),
      );
    return old;
  });

  return KinGitHubAppKey.of({
    get,
    set: Effect.fn("KinGitHubAppKey.set")(function* (appId, key) {
      yield* store.set(appKeyName(appId), encode(Redacted.value(key)));
    }),
    remove: Effect.fn("KinGitHubAppKey.remove")(function* (appId) {
      yield* store.remove(appKeyName(appId)).pipe(Effect.ignore);
      yield* store.remove(hookSetName(appId)).pipe(Effect.ignore);
      yield* store.remove(hookSecretName(appId)).pipe(Effect.ignore);
    }),
  });
});

export const layer = Layer.effect(KinGitHubAppKey, make);

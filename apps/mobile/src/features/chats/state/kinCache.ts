import { EnvironmentQueryStore } from "@t3tools/client-runtime/state/query-persistence";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { MobileDatabase } from "../../../persistence/mobile-database";

const KIND = "kin";
const VERSION = 1;
const INDEX_KEY = "index";
/** The inbox plus the most recently saved chats; older entries are evicted. */
export const KIN_CACHE_MAX_ENTRIES = 40;
/** A record past this is not worth the disk; the next live answer replaces it anyway. */
export const KIN_CACHE_MAX_PAYLOAD_BYTES = 512 * 1024;

/** Whose cache this is (absent until the host first answers), and every key, most recent first. */
const KinCacheIndex = Schema.Struct({
  identity: Schema.optionalKey(Schema.NullOr(Schema.String)),
  keys: Schema.Array(Schema.String),
});
const indexCodec = Schema.fromJsonString(Schema.toCodecJson(KinCacheIndex));
const decodeIndex = Schema.decodeUnknownOption(indexCodec);
const encodeIndex = Schema.encodeSync(indexCodec);

const encoder = new TextEncoder();

// Index read-modify-writes from concurrent streams must not interleave.
const indexLock = Semaphore.makeUnsafe(1);

const rowKey = (key: string) => `v${VERSION}:${key}`;

type Database = MobileDatabase["Service"];

const readIndex = (database: Database, environmentId: EnvironmentId) =>
  database.loadCache(environmentId, KIND, INDEX_KEY).pipe(
    Effect.map(Option.flatMap(decodeIndex)),
    Effect.catch(() => Effect.succeedNone),
  );

const writeIndex = (
  database: Database,
  environmentId: EnvironmentId,
  index: typeof KinCacheIndex.Type,
) => database.saveCache(environmentId, KIND, INDEX_KEY, VERSION, encodeIndex(index));

function makeStore(database: Database): NonNullable<typeof EnvironmentQueryStore.Service> {
  return {
    load: (environmentId, key) =>
      database
        .loadCache(environmentId, KIND, rowKey(key))
        .pipe(Effect.catch(() => Effect.succeedNone)),
    save: Effect.fn("KinCache.save")(
      function* (environmentId, key, payload) {
        if (encoder.encode(payload).length > KIN_CACHE_MAX_PAYLOAD_BYTES) return;
        yield* database.saveCache(environmentId, KIND, rowKey(key), VERSION, payload);
        const index = Option.getOrElse(
          yield* readIndex(database, environmentId),
          (): typeof KinCacheIndex.Type => ({ keys: [] }),
        );
        const keys = [key, ...index.keys.filter((held) => held !== key)];
        for (const evicted of keys.slice(KIN_CACHE_MAX_ENTRIES)) {
          yield* database.removeCache(environmentId, KIND, rowKey(evicted));
        }
        yield* writeIndex(database, environmentId, {
          ...index,
          keys: keys.slice(0, KIN_CACHE_MAX_ENTRIES),
        });
      },
      indexLock.withPermit,
      Effect.catch(() => Effect.logWarning("Kin cache save failed")),
    ),
  };
}

/** Runs Kin's `persistQuery` loads and saves against the `kin` cache kind. */
export const withKinCache = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  MobileDatabase.use((database) =>
    effect.pipe(Effect.provideService(EnvironmentQueryStore, makeStore(database))),
  );

export const removeKinCacheEntry = Effect.fn("KinCache.remove")(function* (
  environmentId: EnvironmentId,
  key: string,
) {
  const database = yield* MobileDatabase;
  yield* Effect.gen(function* () {
    yield* database.removeCache(environmentId, KIND, rowKey(key));
    const index = yield* readIndex(database, environmentId);
    if (Option.isNone(index)) return;
    yield* writeIndex(database, environmentId, {
      ...index.value,
      keys: index.value.keys.filter((held) => held !== key),
    });
  }).pipe(
    indexLock.withPermit,
    Effect.catch(() => Effect.logWarning("Kin cache remove failed")),
  );
});

/**
 * Drops an environment's Kin cache when the person it maps this session to changes, so a re-paired
 * phone never shows the previous person's inbox. `null` is a host with no identity.
 */
export const syncKinCacheIdentity = Effect.fn("KinCache.syncIdentity")(function* (
  environmentId: EnvironmentId,
  identity: string | null,
) {
  const database = yield* MobileDatabase;
  yield* Effect.gen(function* () {
    const index = yield* readIndex(database, environmentId);
    if (Option.isNone(index) || index.value.identity === undefined) {
      // Saved before the host first answered: it was this session's, so adopt it.
      yield* writeIndex(database, environmentId, {
        identity,
        keys: Option.match(index, { onNone: () => [], onSome: (held) => held.keys }),
      });
      return;
    }
    if (index.value.identity === identity) return;
    yield* database.clearCacheKind(environmentId, KIND);
    yield* writeIndex(database, environmentId, { identity, keys: [] });
  }).pipe(
    indexLock.withPermit,
    Effect.catch(() => Effect.logWarning("Kin cache identity sync failed")),
  );
});

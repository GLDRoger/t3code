import type { KinOrgId, MemoryItemHead } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { MemoryConfig } from "./MemoryConfig.ts";
import * as Semaphore from "effect/Semaphore";
import * as Layer from "effect/Layer";

export interface MemoryItem {
  readonly head: MemoryItemHead;
  readonly body: string;
}

export interface CachedMemoryItem extends MemoryItem {
  readonly fingerprint: string;
}

export class MemoryHistoryError extends Schema.TaggedError<MemoryHistoryError>()(
  "MemoryHistoryError",
  {
    orgId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class MemoryCache extends Context.Service<
  MemoryCache,
  {
    readonly get: (orgId: KinOrgId, path: string) => Effect.Effect<CachedMemoryItem | undefined>;
    readonly replace: (
      orgId: KinOrgId,
      items: ReadonlyArray<CachedMemoryItem>,
    ) => Effect.Effect<void>;
    readonly read: (orgId: KinOrgId, path: string) => Effect.Effect<void, MemoryHistoryError>;
    readonly lastReads: (
      orgId: KinOrgId,
    ) => Effect.Effect<Readonly<Record<string, number>>, MemoryHistoryError>;
  }
>()("t3/kin/memory/MemoryCache") {}

const make = Effect.gen(function* () {
  const orgs = new Map<KinOrgId, Map<string, CachedMemoryItem>>();
  const fs = yield* FileSystem.FileSystem;
  const pathModule = yield* Path.Path;
  const config = yield* MemoryConfig;
  const lock = Semaphore.makeUnsafe(1);
  const historySchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number));
  const historyFile = (orgId: KinOrgId) =>
    pathModule.join(config.baseDirectory, ".read-history", `${encodeURIComponent(orgId)}.json`);
  const history = Effect.fn("MemoryCache.history")(
    function* (orgId: KinOrgId) {
      const file = historyFile(orgId);
      if (!(yield* fs.exists(file))) return {};
      return yield* fs
        .readFileString(file)
        .pipe(Effect.flatMap(Schema.decodeEffect(historySchema)));
    },
    (effect, orgId) =>
      effect.pipe(Effect.mapError((cause) => new MemoryHistoryError({ orgId, cause }))),
  );

  return MemoryCache.of({
    get: Effect.fn("MemoryCache.get")((orgId, path) =>
      Effect.sync(() => orgs.get(orgId)?.get(path)),
    ),
    replace: Effect.fn("MemoryCache.replace")((orgId, items) =>
      Effect.sync(() => {
        orgs.set(orgId, new Map(items.map((item) => [item.head.path, item])));
      }),
    ),
    read: Effect.fn("MemoryCache.read")(function* (orgId, path) {
      const now = yield* Clock.currentTimeMillis;
      const reads = yield* history(orgId);
      const json = yield* Schema.encodeEffect(historySchema)({ ...reads, [path]: now }).pipe(
        Effect.mapError((cause) => new MemoryHistoryError({ orgId, cause })),
      );
      const file = historyFile(orgId);
      yield* fs.makeDirectory(pathModule.dirname(file), { recursive: true }).pipe(
        Effect.andThen(fs.writeFileString(`${file}.tmp`, json)),
        Effect.andThen(fs.rename(`${file}.tmp`, file)),
        Effect.mapError((cause) => new MemoryHistoryError({ orgId, cause })),
      );
    }, lock.withPermits(1)),
    lastReads: history,
  });
});

export const layer = Layer.effect(MemoryCache, make);

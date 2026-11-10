import { EnvironmentQueryStore } from "@t3tools/client-runtime/state/query-persistence";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { MobileDatabase } from "../../../persistence/mobile-database";
import { KIN_CACHE_MAX_PAYLOAD_BYTES, syncKinCacheIdentity, withKinCache } from "./kinCache";

const environmentId = EnvironmentId.make("kin-host");

function fakeDatabase(rows: Map<string, string>) {
  const id = (kind: string, key: string) => `${kind}|${key}`;
  return {
    loadCache: (_environmentId: EnvironmentId, kind: string, key: string) =>
      Effect.sync(() => Option.fromNullishOr(rows.get(id(kind, key)))),
    saveCache: (
      _environmentId: EnvironmentId,
      kind: string,
      key: string,
      _version: number,
      payload: string,
    ) => Effect.sync(() => void rows.set(id(kind, key), payload)),
    removeCache: (_environmentId: EnvironmentId, kind: string, key: string) =>
      Effect.sync(() => void rows.delete(id(kind, key))),
    clearCacheKind: () => Effect.sync(() => rows.clear()),
  } as unknown as MobileDatabase["Service"];
}

describe("Kin cache", () => {
  it.effect("drops the cache when the host maps this session to another person", () =>
    Effect.gen(function* () {
      const rows = new Map([
        ["kin|index", JSON.stringify({ identity: "p1", keys: ["inbox"] })],
        ["kin|v1:inbox", "p1's inbox"],
      ]);
      yield* syncKinCacheIdentity(environmentId, "p2").pipe(
        Effect.provideService(MobileDatabase, fakeDatabase(rows)),
      );
      expect([...rows.keys()]).toEqual(["kin|index"]);
      expect(JSON.parse(rows.get("kin|index") ?? "")).toEqual({ identity: "p2", keys: [] });
    }),
  );

  it.effect("skips a payload past the byte cap, even when its length is under it", () =>
    Effect.gen(function* () {
      const rows = new Map<string, string>();
      // Three UTF-8 bytes per character: half the cap in length, 1.5 times it in bytes.
      const payload = "€".repeat(KIN_CACHE_MAX_PAYLOAD_BYTES / 2);
      yield* EnvironmentQueryStore.use((store) => store!.save(environmentId, "big", payload)).pipe(
        withKinCache,
        Effect.provideService(MobileDatabase, fakeDatabase(rows)),
      );
      expect(rows.size).toBe(0);
    }),
  );
});

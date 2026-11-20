import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import * as EgressGuard from "../connections/EgressGuard.ts";
import { makeFakeImageVendor } from "./FakeImageVendor.ts";
import * as Pictures from "./KinPictures.ts";

/**
 * `vp run dev` with `KIN_DEV_FAKE_PICTURES=1`: pictures come from the in-memory fake (a 1×1 PNG)
 * and any saved key works. Only with a dev server (`devUrl`), so an installed host never offers it.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const raw = yield* Config.String("KIN_DEV_FAKE_PICTURES").pipe(Config.withDefault(""));
    if (config.devUrl === undefined || raw.trim() === "" || raw.trim() === "0")
      return Pictures.layer.pipe(Layer.provide(EgressGuard.layer));
    yield* Effect.logWarning("Kin pictures come from the fake picture service");
    const { vendor } = makeFakeImageVendor({ name: "dev-fake", label: "Fake pictures (dev)" });
    // Nothing leaves the machine: the fake answers without HTTP, and the guard stays beneath.
    return Pictures.makeLayer(vendor).pipe(Layer.provide(EgressGuard.layer));
  }),
);

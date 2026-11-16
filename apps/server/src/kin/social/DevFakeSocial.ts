import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

import { ServerConfig } from "../../config.ts";
import * as EgressGuard from "../connections/EgressGuard.ts";
import { fileStore, makeFakeZernio } from "./FakeZernio.ts";
import * as Social from "./SocialService.ts";

/**
 * `vp run dev` with `KIN_DEV_FAKE_SOCIAL=1`: Zernio's calls go to a local file instead
 * (`kin-fake-social.json` in the state folder), which `apps/server/scripts/kin-fake-social.ts`
 * fills and changes. Only with a dev server (`devUrl`), so an installed host never offers it.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const raw = yield* Config.String("KIN_DEV_FAKE_SOCIAL").pipe(Config.withDefault(""));
    if (config.devUrl === undefined || raw.trim() === "" || raw.trim() === "0")
      return Social.layer.pipe(Layer.provide(EgressGuard.layer));
    const path = (yield* Path.Path).join(config.stateDir, "kin-fake-social.json");
    yield* Effect.logWarning(`Kin social posts go to the fake Zernio at ${path}`);
    // Nothing else is reachable: a request the fake doesn't own fails instead of leaving the machine.
    const fetch = makeFakeZernio(fileStore(path)).handle(() =>
      Promise.reject(new Error("Only the fake Zernio answers with KIN_DEV_FAKE_SOCIAL.")),
    );
    // `Fetch` is read from each request's own fiber, so it is set per request, not on the layer.
    const fake = Layer.effect(
      HttpClient.HttpClient,
      Effect.map(HttpClient.HttpClient, (client) =>
        client.pipe(
          HttpClient.transformResponse(Effect.provideService(FetchHttpClient.Fetch, fetch)),
        ),
      ),
    ).pipe(Layer.provide(FetchHttpClient.layer));
    // Fresh: layers are shared by reference, and the fake mailbox builds `guarded` over its own fetch.
    return Social.layer.pipe(
      Layer.provide(Layer.fresh(EgressGuard.guarded).pipe(Layer.provide(fake))),
    );
  }),
);

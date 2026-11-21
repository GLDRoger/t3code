import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import * as Apns from "./Apns.ts";
import * as Fcm from "./Fcm.ts";

const encodeLine = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * `vp run dev` with `KIN_DEV_PUSH_CAPTURE=1`: every push Kin would send to APNs or FCM is appended
 * to `<stateDir>/kin-push-capture.jsonl` and answered 200, so a dev run can read what each device
 * got. Only with a dev server (`devUrl`), so an installed host never offers it.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const on = yield* Config.Boolean("KIN_DEV_PUSH_CAPTURE").pipe(Config.withDefault(false));
    if (!on || config.devUrl === undefined) return Layer.merge(Apns.layer, Fcm.layer);
    const fs = yield* FileSystem.FileSystem;
    const file = (yield* Path.Path).join(config.stateDir, "kin-push-capture.jsonl");
    yield* Effect.logWarning(`Kin pushes go to ${file}, not APNs or FCM`);
    const capture = Effect.fn("KinDevPushCapture.capture")(
      function* (push: object) {
        const line = yield* encodeLine({ at: yield* Clock.currentTimeMillis, ...push });
        yield* fs.writeFileString(file, `${line}\n`, { flag: "a" });
        return { status: 200, reason: undefined };
      },
      Effect.orElseSucceed(() => ({ status: 0, reason: "capture" })),
    );
    return Layer.merge(
      Layer.succeed(
        Apns.KinApnsTransport,
        Apns.KinApnsTransport.of({
          status: "ready",
          send: Effect.fn("KinDevPushCapture.send")(function* (push: Apns.KinApnsPush) {
            return yield* capture(push);
          }),
        }),
      ),
      Layer.succeed(
        Fcm.KinFcmTransport,
        Fcm.KinFcmTransport.of({
          status: "ready",
          send: Effect.fn("KinDevPushCapture.sendFcm")(function* (push: Fcm.KinFcmPush) {
            return yield* capture({ platform: "android", ...push });
          }),
        }),
      ),
    );
  }),
);

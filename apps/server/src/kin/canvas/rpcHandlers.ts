import { KinCanvasRpcs, KinChatError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { KinCanvas } from "./KinCanvas.ts";

const group = RpcGroup.make(...KinCanvasRpcs);
const disabled = new KinChatError({
  reason: "disabled",
  message: "Kin is not running on this host.",
});
const defect = (cause: unknown) =>
  Effect.logWarning("Kin RPC defect.", cause).pipe(
    Effect.andThen(
      Effect.fail(new KinChatError({ reason: "unavailable", message: "Kin is unavailable." })),
    ),
  );

/** Thin transport: resolve the session's people, then one canvas call. */
export const makeKinCanvasHandlers = Effect.fn("makeKinCanvasHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const resolved = Effect.fn("KinCanvas.rpc.resolve")(function* () {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    const services = kin.value.services.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    return { canvas: Context.get(services, KinCanvas), people };
  });
  const call = <A>(
    run: (
      canvas: KinCanvas["Service"],
      people: ReadonlyArray<PersonIdentity>,
    ) => Effect.Effect<A, KinChatError>,
  ) =>
    resolved().pipe(
      Effect.flatMap(({ canvas, people }) => run(canvas, people)),
      Effect.catchDefect(defect),
    );
  return group.of({
    "kin.canvas.read": (input) => call((canvas, people) => canvas.read(people, input)),
    "kin.canvas.subscribe": (input) =>
      Stream.unwrap(
        Effect.map(resolved(), ({ canvas, people }) => canvas.subscribe(people, input)),
      ),
    "kin.canvas.place": (input) => call((canvas, people) => canvas.place(people, input)),
    "kin.canvas.unplace": (input) => call((canvas, people) => canvas.unplace(people, input)),
    "kin.canvas.widgetAdd": (input) => call((canvas, people) => canvas.widgetAdd(people, input)),
    "kin.canvas.widgetRemove": (input) =>
      call((canvas, people) => canvas.widgetRemove(people, input)),
    "kin.canvas.seen": (input) => call((canvas, people) => canvas.seen(people, input)),
  });
});

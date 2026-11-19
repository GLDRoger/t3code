import { KinChatError, KinTasksKeyRpcs } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuth, type AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { CloudLink } from "../../cloud/CloudLink.ts";
import { KinServer, type Services } from "../KinServer.ts";
import * as TasksKeys from "./TasksKeys.ts";

const group = RpcGroup.make(...KinTasksKeyRpcs);
const isKinError = Schema.is(KinChatError);
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });

export const makeKinTasksKeyHandlers = Effect.fn("makeKinTasksKeyHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const auth = yield* Effect.serviceOption(EnvironmentAuth);
  const cloud = yield* Effect.serviceOption(CloudLink);
  const run = Effect.fnUntraced(
    function* <A, R extends Services | EnvironmentAuth>(body: Effect.Effect<A, KinChatError, R>) {
      const services = Option.flatMap(kin, (k) => k.services);
      if (Option.isNone(services) || Option.isNone(auth)) return yield* unavailable;
      const provided = body.pipe(
        Effect.provideContext(services.value),
        Effect.provideService(EnvironmentAuth, auth.value),
      );
      return yield* Option.isSome(cloud)
        ? provided.pipe(Effect.provideService(CloudLink, cloud.value))
        : provided;
    },
    Effect.mapError((e) => (isKinError(e) ? e : unavailable)),
  );
  return group.of({
    "kin.tasksKeys.issue": (input) => run(TasksKeys.issue(session, input)),
    "kin.tasksKeys.list": (input) => run(TasksKeys.list(session, input)),
    "kin.tasksKeys.revoke": (input) => run(TasksKeys.revoke(session, input)),
  });
});

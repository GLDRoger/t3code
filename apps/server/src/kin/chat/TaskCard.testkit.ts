import { EnvironmentId } from "@t3tools/contracts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const environment = Layer.mock(ServerEnvironment)({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
});

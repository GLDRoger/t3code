import * as JudgeShadow from "../floor/JudgeShadow.ts";
import { EnvironmentId } from "@t3tools/contracts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const serverEnvironment = Layer.mock(ServerEnvironment)({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
});

export const environment = Layer.merge(serverEnvironment, JudgeShadow.layerOff);

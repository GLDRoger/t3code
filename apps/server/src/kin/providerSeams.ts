import {
  EEVEE_LANE_LABEL,
  KIN_LANE_LABEL,
  ThreadId,
  laneLabelEnvironment,
} from "@t3tools/contracts";
import { activeSeam, readProviderChunk, readToolJson } from "@t3tools/kin-reliability";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as HouseLineService from "./houseLine/HouseLineService.ts";

export function withLaneLabel(
  environment: NodeJS.ProcessEnv,
  label: string | null | undefined,
): NodeJS.ProcessEnv {
  if (label === undefined || label === null || label.length === 0) return environment;
  return { ...environment, ...laneLabelEnvironment(label) };
}

export const applyLaneLabel = Effect.fn("kin.applyLaneLabel")(function* (
  environment: NodeJS.ProcessEnv,
  threadId: string,
) {
  const houseLine = Context.getOption(
    yield* Effect.context<never>(),
    HouseLineService.HouseLineService,
  );
  if (Option.isNone(houseLine)) return withLaneLabel(environment, environment[KIN_LANE_LABEL]);
  const label = yield* houseLine.value
    .laneLabel(ThreadId.make(threadId))
    .pipe(Effect.orElseSucceed(() => null));
  return withLaneLabel(
    environment,
    label ?? environment[KIN_LANE_LABEL] ?? environment[EEVEE_LANE_LABEL],
  );
});

function arm() {
  return { env: process.env };
}

/** Inert unless KIN_CHAOS=1, the process is not production, and KIN_CHAOS_SEAM selects this seam. */
export function faultProviderText(seam: "provider.stream" | "tool.json", text: string): string {
  const active = activeSeam(process.env);
  return seam === "provider.stream"
    ? readProviderChunk(arm(), active, text)
    : readToolJson(arm(), active, text);
}

export function faultToolJsonValue(value: unknown): unknown {
  if (process.env.KIN_CHAOS !== "1") return value;
  const json = typeof value === "string" ? value : JSON.stringify(value);
  if (json === undefined) return value;
  const faulted = faultProviderText("tool.json", json);
  if (faulted === json) return value;
  if (typeof value === "string") return faulted;
  try {
    return JSON.parse(faulted) as unknown;
  } catch {
    return value;
  }
}

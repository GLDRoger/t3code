import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Judge, type JudgeVerdict } from "./Judge.ts";

const verdict: JudgeVerdict = {
  needsResponse: { value: false, confidence: 0 },
  role: { value: null, confidence: 0 },
  urgency: { value: "normal", confidence: 0 },
  needsHumanDecision: { value: false, confidence: 0 },
  commitment: { value: { kind: "none", text: null }, confidence: 0 },
};
export const layer = Layer.succeed(Judge, {
  name: "noop",
  judge: Effect.fn("KinJudge.judge")(() => Effect.succeed(verdict)),
});

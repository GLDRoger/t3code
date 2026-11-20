import { assert, it } from "@effect/vitest";

import { MODEL_COVERS, modelsFor } from "./kin-model.ts";

it("checks a Kin model only when a file it stands for, its folder or its runner changed", () => {
  assert.deepStrictEqual(modelsFor(["apps/server/src/kin/work/cardAnswers.ts"]), [
    "send",
    "money",
    "questions",
  ]);
  assert.deepStrictEqual(modelsFor(["apps/server/src/kin/people/personNamed.ts"]), ["people"]);
  // The queue stands in both the reply and the check-in.
  assert.deepStrictEqual(modelsFor(["apps/server/src/kin/lead/KinEventQueue.ts"]), [
    "reply",
    "checkin",
  ]);
  assert.deepStrictEqual(modelsFor(["verification/kin/checkin/CheckIn.tla"]), ["checkin"]);
  assert.deepStrictEqual(modelsFor(["scripts/kin-model.ts"]), Object.keys(MODEL_COVERS));
  assert.deepStrictEqual(modelsFor(["apps/server/src/kin/work/money.ts", "docs/kin/RULES.md"]), []);
});

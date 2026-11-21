// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";

import { MODEL_COVERS, modelsFor, modelsToReconfirm } from "./kin-model.ts";

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

it("asks to re-confirm a model whose covered code changed without it", () => {
  const queue = "apps/server/src/kin/lead/KinEventQueue.ts";
  assert.deepStrictEqual(modelsToReconfirm([queue]), ["reply", "checkin"]);
  assert.deepStrictEqual(modelsToReconfirm([queue, "verification/kin/reply/Reply.tla"]), [
    "checkin",
  ]);
  assert.deepStrictEqual(modelsToReconfirm(["scripts/kin-model.ts"]), []);
});

it("covers, for each Kin model, exactly the files its README's Covers names, and each exists", () => {
  const root = NodePath.resolve(import.meta.dirname, "..");
  for (const [name, covers] of Object.entries(MODEL_COVERS)) {
    const readme = NodeFS.readFileSync(
      NodePath.join(root, "verification/kin", name, "README.md"),
      "utf8",
    );
    const block = readme.slice(readme.indexOf("**Covers**")).split(/\n\n(?!- )/)[0]!;
    const named = [...block.matchAll(/`((?:apps|packages)\/[^`]+)`/g)].flatMap(([, path]) => {
      const braces = /^(.*)\{([^}]*)\}(.*)$/.exec(path!);
      return braces === null
        ? [path!]
        : braces[2]!.split(",").map((one) => `${braces[1]}${one}${braces[3]}`);
    });
    assert.deepStrictEqual([...covers].toSorted(), [...new Set(named)].toSorted(), name);
    for (const file of covers) assert.isTrue(NodeFS.existsSync(NodePath.join(root, file)), file);
  }
});

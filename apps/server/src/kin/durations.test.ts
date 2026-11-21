// @effect-diagnostics nodeBuiltinImport:off -- the guard reads source files synchronously, outside any Effect.
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

it("defines a minute, hour, day or week only in durations.ts", () => {
  const span =
    /^\s*(?:export )?const (?:MINUTE|HOUR|DAY|WEEK)(?:_MS)? = [\d_ *A-Z]+;|^\s*(?:export )?const (?:day|week) = [\d_ *]+;/gm;
  const found = NodeFS.readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !/\.test\.ts$|\.testkit\.ts$|migrations\//.test(file))
    .flatMap((file) =>
      [...NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8").matchAll(span)].map(
        () => file,
      ),
    );
  assert.deepStrictEqual(found.toSorted(), Array(4).fill("durations.ts"));
});

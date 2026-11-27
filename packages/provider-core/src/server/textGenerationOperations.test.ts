import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";

// regression: #23726 a reply that echoes the schema key replaced the seed title with "title"
it.effect("fails a thread title reply that is only the schema key", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(request, "Stub", '{"title":"title","needsRefinement":false}'),
    );

    const outcome = yield* textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "$implement Issue #140",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-haiku-4-5",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateThreadTitle");
  }),
);

it.effect.each([
  ["valid JSON", '{"kind":"other"}', true],
  ["malformed JSON", "not JSON", false],
  ["prose around JSON", 'Answer: {"kind":"other"}', false],
  ["wrong shape", '{"kind":"unexpected"}', false],
] as const)("decodes structured text once: %s", ([, text, valid]) =>
  Effect.gen(function* () {
    let calls = 0;
    const capable = fromRunner(
      "Stub",
      (request) => {
        calls++;
        return decodeJsonReply(request, "Stub", text);
      },
      { toolFree: true },
    );
    assert.isFunction(capable.generateStructuredText);
    const generate = capable.generateStructuredText!;
    const outcome = yield* generate({
      cwd: process.cwd(),
      prompt: "Read the data.",
      modelSelection: { instanceId: ProviderInstanceId.make("stub"), model: "small" },
      outputSchema: Schema.Struct({ kind: Schema.Literal("other") }),
    }).pipe(Effect.result);
    assert.strictEqual(calls, 1);
    assert.strictEqual(outcome._tag, valid ? "Success" : "Failure");
    if (outcome._tag === "Success") {
      assert.deepStrictEqual(outcome.success, { kind: "other" });
    } else {
      assert.isTrue(Schema.isSchemaError(outcome.failure.cause));
    }
  }),
);

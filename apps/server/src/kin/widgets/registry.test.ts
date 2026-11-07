import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { validateState } from "./registry.ts";

const state = {
  taskId: "task",
  environmentId: "environment",
  threadId: "thread",
  remoteEnvironmentId: null,
  title: "Work",
  model: null,
  status: "working",
  pullRequests: [],
  lastError: null,
  updatedAt: "2026-11-07T00:00:00.000Z",
};

describe("Kin widget registry", () => {
  it.effect("validates task state and refuses unknown or invalid state without a fallback", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* validateState("task", state), state);
      for (const [type, value] of [
        ["unknown", state],
        ["approval", state],
        ["decision", state],
        ["task", {}],
        ["task", { ...state, status: "approved" }],
        ["task", { ...state, threadId: 1 }],
        ["task", { ...state, title: "" }],
      ] as const) {
        assert.include(
          yield* validateState(type, value).pipe(
            Effect.match({
              onFailure: (error) => error,
              onSuccess: () => assert.fail("Expected invalid widget state"),
            }),
          ),
          { reason: "invalid_state" },
        );
      }
    }),
  );
});

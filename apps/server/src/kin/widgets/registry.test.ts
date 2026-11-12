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

const choice = {
  question: "Ship today?",
  detail: null,
  options: [
    { optionId: "option-1", label: "Yes", kind: "yes" },
    { optionId: "option-2", label: "No", kind: "no" },
  ],
  answer: null,
};

const chart = {
  chart: "bar",
  title: "Signups",
  caption: null,
  unit: { kind: "count" },
  labelType: "category",
  labels: ["Mon", "Tue"],
  series: [{ name: "This week", values: [12, null] }],
  comparison: null,
};

const visual = { title: "Funnel", attachmentId: "kin-chat-1-html", height: 360 };

describe("Kin widget registry", () => {
  it.effect("validates task state and refuses unknown or invalid state without a fallback", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* validateState("task", state), state);
      assert.deepStrictEqual(yield* validateState("choice", choice), choice);
      assert.deepStrictEqual(yield* validateState("chart", chart), chart);
      assert.deepStrictEqual(yield* validateState("visual", visual), visual);
      for (const [type, value] of [
        ["unknown", state],
        ["approval", state],
        ["decision", state],
        ["task", {}],
        ["task", { ...state, status: "approved" }],
        ["task", { ...state, threadId: 1 }],
        ["task", { ...state, title: "" }],
        ["choice", { ...choice, options: choice.options.slice(0, 1) }],
        ["choice", { ...choice, question: "x".repeat(241) }],
        ["chart", { ...chart, labels: ["Mon"] }],
        ["chart", { ...chart, html: "<b>hi</b>", chart: "sankey" }],
        ["chart", { ...chart, chart: "pie", series: [{ name: "Net", values: [12, -3] }] }],
        ["visual", { ...visual, attachmentId: "" }],
        ["visual", { ...visual, height: 20_000 }],
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

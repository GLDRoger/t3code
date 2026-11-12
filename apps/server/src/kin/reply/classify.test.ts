import {
  RunId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import { PHASE_LABELS, setupFailure, setupFailureIn, toolLabel } from "./classify.ts";

const call = (toolName: string) =>
  toolLabel({ type: "dynamic_tool", toolName: `mcp__kin__${toolName}` } as OrchestrationV2TurnItem);

it("gives every lead tool a status a person would say, never Kin's own vocabulary", () => {
  const silent = ["kin_react", "kin_journal", "kin_end"];
  const labels = Object.keys(KinLeadToolkit.tools).map((name) => [name, call(name)] as const);
  expect(labels.filter(([, label]) => label === null).map(([name]) => name)).toEqual(silent);
  // A tool the table forgot reads as the generic line: add its own words instead.
  expect(labels.filter(([, label]) => label === PHASE_LABELS.tool)).toEqual([]);
  for (const label of [...labels.map(([, label]) => label ?? ""), ...Object.values(PHASE_LABELS)])
    expect(label).not.toMatch(/memory|tool|level|worker|wake|queue|defer|widget|kin_|_/i);
  expect(call("kin_hand_off")).toBe("Passing this on");
  expect(call("something_new")).toBe(PHASE_LABELS.tool);
});

it("treats only sign-in, account access and unknown model failures as ones no retry fixes", () => {
  const of = (code: string | null, failureClass = "provider_error" as const) =>
    setupFailure({ class: failureClass, message: "Failed.", code, retryable: null });
  expect(of("authentication_failed")).toBe("signin");
  expect(of("api_error_401")).toBe("signin");
  expect(of("api_error_403")).toBe("access");
  expect(
    setupFailure({ class: "permission_error", message: "No.", code: null, retryable: null }),
  ).toBe("access");
  // QA Q3: a model the provider doesn't know is set up wrong, not a passing failure.
  const said = (code: string, message: string) =>
    setupFailure({ class: "provider_error", message, code, retryable: null });
  expect(said("api_error_400", "API Error: 400 unknown provider for model claude-x")).toBe("model");
  expect(said("api_error_404", 'API Error: 404 {"error":{"message":"model: claude-x"}}')).toBe(
    "model",
  );
  expect(said("api_error_400", "API Error: 400 prompt is too long")).toBeNull();
  expect(of("api_error_529")).toBeNull();
  expect(of(null)).toBeNull();
});

it("counts only a sign-in failure that ended the run, not a retry it recovered from", () => {
  const runId = RunId.make("run");
  const error = (status: "failed" | "completed") =>
    ({
      type: "error",
      runId,
      status,
      failure: { class: "provider_error", message: "No.", code: "api_error_401", retryable: null },
    }) as OrchestrationV2TurnItem;
  const projection = (status: "failed" | "completed") =>
    ({ runs: [{ id: runId, ordinal: 1 }], turnItems: [error(status)] }) as unknown as Pick<
      OrchestrationV2ThreadProjection,
      "runs" | "turnItems"
    >;
  expect(setupFailureIn(projection("failed"), runId)).toBe("signin");
  expect(setupFailureIn(projection("completed"), runId)).toBeNull();
});

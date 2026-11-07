import { assert, it } from "@effect/vitest";
import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeInput = Schema.decodeSync(OrchestratorMcpDelegateTaskInput);

const decodeResult = Schema.decodeSync(OrchestratorMcpDelegateTaskResult);

it("decodes LEAD's worktree brief and the durable child thread result", () => {
  const task =
    "You were called by another agent. Do this task yourself. Review the PR and report findings.";
  const input = decodeInput({
    task,
    isolation: "worktree",
    target: { providerInstanceId: "codex", model: "gpt-6.1-sol", options: { effort: "medium" } },
  });
  assert.equal(input.task, task);
  assert.equal(input.isolation, "worktree");
  assert.equal(input.target?.providerInstanceId, "codex");
  assert.equal(input.target?.model, "gpt-6.1-sol");
  assert.deepEqual(input.target?.options, [{ id: "effort", value: "medium" }]);
  const result = decodeResult({
    taskId: "node-task-18",
    childThreadId: "thread-child-18",
    childRunId: null,
    childNodeId: "node-task-18",
    status: "completed",
    workState: "result_available",
    hasPendingChildRuns: false,
    providerInstanceId: "codex",
    model: null,
    summary: null,
    resultContextTransferId: null,
    latestTerminalRunId: null,
    latestTerminalStatus: null,
    latestTerminalSummary: null,
    latestTerminalResultContextTransferId: null,
    hasPendingQuestion: false,
    pendingApproval: null,
    waitTimedOut: false,
  });
  assert.equal(result.childThreadId, "thread-child-18");
});

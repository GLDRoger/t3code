import { ProviderDriverKind, type OrchestratorMcpTarget } from "@t3tools/contracts";

import type { KinRouteDecision } from "./RoutingPolicy.ts";

const ACTIVE_TASK_STATUS = new Set(["idle", "pending", "running", "waiting"]);

export function countActiveDelegations(
  subagents: ReadonlyArray<{ readonly status: string; readonly driver: string }>,
): {
  readonly activeTotal: number;
  readonly activeByProvider: Readonly<Record<string, number>>;
} {
  const activeByProvider: Record<string, number> = {};
  let activeTotal = 0;
  for (const task of subagents) {
    if (!ACTIVE_TASK_STATUS.has(task.status)) continue;
    activeTotal += 1;
    activeByProvider[task.driver] = (activeByProvider[task.driver] ?? 0) + 1;
  }
  return { activeTotal, activeByProvider };
}

export function applyKinRoute(input: {
  readonly target: OrchestratorMcpTarget | undefined;
  readonly decision: KinRouteDecision;
}):
  | { readonly pause: string }
  | { readonly target: OrchestratorMcpTarget | undefined; readonly taskAddendum?: string } {
  if (input.decision.action === "pause") return { pause: input.decision.reason };
  if (input.decision.action === "inherit") return { target: input.target };
  const { providerInstanceId: _instanceId, ...rest } = input.target ?? {};
  return {
    target: {
      ...rest,
      driverKind: ProviderDriverKind.make(input.decision.provider),
      ...(input.decision.model === undefined ? {} : { model: input.decision.model }),
    },
    ...(input.decision.promptAddendum === undefined
      ? {}
      : { taskAddendum: input.decision.promptAddendum }),
  };
}

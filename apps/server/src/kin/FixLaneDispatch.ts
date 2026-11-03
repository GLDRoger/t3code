import { CommandId, ThreadId } from "@t3tools/contracts";
import { FIX_LANE_PROFILE } from "@t3tools/kin-reliability";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { delegationCapDecision, planCapFor } from "./caps.ts";
import * as HouseLine from "./houseLine/HouseLineService.ts";
import * as Kin from "./KinService.ts";

const RunRow = Schema.Struct({ threadId: Schema.String });
const decodeRuns = Schema.decodeUnknownEffect(Schema.Array(RunRow));

export interface DispatchableFixLane {
  readonly task: string;
  readonly title: string;
  readonly clientRequestId: string;
  readonly profile: string;
  readonly house: string;
}

export interface FixLaneDispatchResult {
  readonly dispatched: number;
  readonly skipped: number;
}

/**
 * Opens one `delegate_task` per sweep request on an active main run.
 * Without a live parent run the outbox keeps the request and nothing starts.
 */
export const dispatchFixLanes = Effect.fn("KinFixLaneDispatch.dispatch")(function* (
  requests: readonly DispatchableFixLane[],
) {
  if (requests.length === 0) return { dispatched: 0, skipped: 0 };
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT thread_id AS threadId
    FROM orchestration_v2_projection_runs
    WHERE status IN ('preparing', 'starting', 'running', 'waiting')
    ORDER BY requested_at DESC
    LIMIT 8
  `.pipe(
    Effect.flatMap(decodeRuns),
    Effect.orElseSucceed(() => []),
  );
  const candidates = [];
  for (const row of rows) {
    const projection = yield* threads
      .getThreadProjection(ThreadId.make(row.threadId))
      .pipe(Effect.orElseSucceed(() => null));
    if (projection === null) continue;
    if (projection.thread.lineage.relationshipToParent === "subagent") continue;
    const active = ThreadManagement.latestActiveRun(projection);
    if (active === undefined || active.rootNodeId === null) continue;
    candidates.push(projection);
    break;
  }
  const found = candidates[0];
  if (found === undefined) {
    yield* Effect.logInfo("kin.error-sweep.deferred", {
      reason: "no active main run",
      count: requests.length,
    });
    return { dispatched: 0, skipped: requests.length };
  }
  const parentRun = ThreadManagement.latestActiveRun(found);
  if (parentRun === undefined || parentRun.rootNodeId === null) {
    return { dispatched: 0, skipped: requests.length };
  }
  const context = yield* Effect.context<never>();
  const houseLine = Context.getOption(context, HouseLine.HouseLineService);
  const kin = Context.getOption(context, Kin.KinService);
  const matched = found.subagents.find(
    (subagent) => subagent.providerInstanceId === parentRun.providerInstanceId,
  );
  const targetDriver = planCapFor(parentRun.providerInstanceId)
    ? parentRun.providerInstanceId
    : (matched?.driver ?? "");
  let dispatched = 0;
  let skipped = 0;
  const accepted: Array<{ readonly status: string; readonly driver: string }> = [];
  for (const request of requests) {
    const payload = {
      ...request,
      profile: request.profile.length > 0 ? request.profile : FIX_LANE_PROFILE,
    };
    const decision = delegationCapDecision({
      children: [
        ...found.subagents.map((subagent) => ({
          status: subagent.status,
          driver: subagent.driver,
        })),
        ...accepted,
      ],
      targetDriver,
      usedPercent: null,
    });
    if (!decision.admit) {
      skipped += 1;
      yield* Effect.logInfo("kin.error-sweep.capped", { reason: decision.reason });
      continue;
    }
    const commandId = CommandId.make(payload.clientRequestId);
    const childThreadId = IdAllocator.derive.delegatedTaskThread({ commandId });
    if (Option.isSome(houseLine)) {
      yield* houseLine.value
        .openLane({
          projectId: found.thread.projectId,
          threadId: childThreadId,
          label: payload.title,
          house: payload.house,
          profile: payload.profile,
          role: "implementer",
          provider: parentRun.modelSelection.instanceId,
          model: parentRun.modelSelection.model,
        })
        .pipe(Effect.ignore);
    }
    const dispatchedCommand = yield* threads
      .dispatch({
        type: "delegated_task.request",
        createdBy: "system",
        creationSource: "server",
        commandId,
        parentThreadId: found.thread.id,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId,
        task: `${payload.task}\n\nUse the ${payload.profile} profile.`,
        title: payload.title,
        modelSelection: parentRun.modelSelection,
        runtimeMode: found.thread.runtimeMode,
        interactionMode: found.thread.interactionMode,
        completionWake: "always",
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (dispatchedCommand === null) {
      skipped += 1;
      continue;
    }
    if (Option.isSome(kin)) {
      yield* kin.value
        .bindThread({
          threadId: childThreadId,
          profileName: payload.profile,
          parentThreadId: found.thread.id,
        })
        .pipe(Effect.ignore);
    }
    accepted.push({ status: "running", driver: targetDriver });
    dispatched += 1;
  }
  return { dispatched, skipped };
});
